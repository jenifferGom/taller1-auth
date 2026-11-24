// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · Matchmaking (partidas públicas)
// ─────────────────────────────────────────────────────────────
// Hay UNA sola cola para todo el mesh y la lleva el coordinador vivo de id menor (todos lo calculan
// igual con su lista de peers, sin votar). Los demás le reenvían "buscar" y "cancelar".
//   · Cada jugador busca con un NIVEL de shots (suave | normal | guaro), igual que en las privadas.
//     La cola se agrupa por nivel: solo se juntan jugadores que eligieron el mismo nivel.
//   · Por nivel: con SALA_PUBLICA_MAX en cola, o al menos SALA_PUBLICA_MIN y pasó PUBLICA_ESPERA_MS,
//     se sacan esos jugadores de la cola y se le pide la sala a RoomManager con ESE nivel.
//   · Sin asignaciones dobles: una sola cola, un solo proceso que atiende un mensaje a la vez, y un
//     jugador que ya está en una sala no puede entrar a la cola.
//   · La cola NO se replica: si se cae quien la lleva, cada coordinador le vuelve a mandar al nuevo
//     los jugadores suyos que siguen buscando (la reconstruye).
//
// Mesh: mm_buscar { userId, nivel } · mm_cancelar { userId } · mm_estado { porNivel: { nivel: { enCola, empiezaEn } } }
const { NIVELES } = require('./GameRules');

function crearMatchmaking({ COORDINATOR_ID, players, peers, send, sendPeer, replicate, rooms, config }) {
  const buscando = new Map();             // MIS jugadores que buscan partida: userId → { desde, nivel }
  const cola = new Map();                 // solo en quien lleva la cola: userId → { nombre, coord, desde, nivel }
  const relojes = new Map();              // nivel → { deadline, timer }
  let porNivel = {};                      // lo último publicado: nivel → { enCola, empiezaEn }
  let liderAnterior = null;

  const lider = () => [COORDINATOR_ID, ...peers.keys()].sort()[0];
  const soyLider = () => lider() === COORDINATOR_ID;
  const nivelValido = (n) => (typeof n === 'string' && NIVELES[n] ? n : config.nivelPublica);

  function estadoPara(nivel) {
    const e = porNivel[nivel] || { enCola: 0, empiezaEn: null };
    return { type: 'busqueda_estado', buscando: true, nivel, enCola: e.enCola, empiezaEn: e.empiezaEn,
      minimo: config.publica.min, maximo: config.publica.max };
  }
  function avisarLocales() {
    for (const [userId, b] of buscando) {
      const p = players.get(userId);
      if (p && p.socket) send(p.socket, estadoPara(b.nivel));
    }
  }
  function publicarEstado() {
    porNivel = {};
    for (const nivel of Object.keys(NIVELES)) {
      const n = [...cola.values()].filter(e => e.nivel === nivel).length;
      const r = relojes.get(nivel);
      if (n || r) porNivel[nivel] = { enCola: n, empiezaEn: r ? r.deadline : null };
    }
    replicate({ type: 'mm_estado', porNivel });
    avisarLocales();
  }
  function pararReloj(nivel) { const r = relojes.get(nivel); if (r) { clearTimeout(r.timer); relojes.delete(nivel); } }
  function pararTodos() { for (const nivel of [...relojes.keys()]) pararReloj(nivel); }

  // ── Solo en quien lleva la cola ──
  function encolar(userId, coord, nivel) {
    const p = players.get(userId);
    if (!p || p.origin !== coord) return;                           // el jugador debe estar conectado a ese coordinador
    if (rooms.salaDe(userId)) return;                                // ya tiene sala: no entra a la cola
    const previo = cola.get(userId);
    cola.set(userId, { nombre: p.username, coord, nivel: nivelValido(nivel), desde: previo && previo.nivel === nivelValido(nivel) ? previo.desde : Date.now() });
    evaluar();
  }
  function desencolar(userId, coord) {
    const e = cola.get(userId);
    if (e && (!coord || e.coord === coord)) { cola.delete(userId); evaluar(); }
  }
  function evaluar() {
    for (const [id, e] of cola) {                                    // limpia a quien ya no está o ya tiene sala
      const p = players.get(id);
      if (!p || p.origin !== e.coord || rooms.salaDe(id)) cola.delete(id);
    }
    for (const nivel of Object.keys(NIVELES)) {
      const n = [...cola.values()].filter(e => e.nivel === nivel).length;
      if (n >= config.publica.max) { formar(nivel, config.publica.max); return evaluar(); }
      if (n >= config.publica.min) {
        if (!relojes.has(nivel)) {
          const r = { deadline: Date.now() + config.esperaPublicaMs };
          r.timer = setTimeout(() => {
            relojes.delete(nivel);
            const quedan = [...cola.values()].filter(e => e.nivel === nivel).length;
            if (soyLider() && quedan >= config.publica.min) formar(nivel, Math.min(quedan, config.publica.max));
            evaluar();
          }, config.esperaPublicaMs + 5);
          relojes.set(nivel, r);
        }
      } else {
        pararReloj(nivel);
      }
    }
    publicarEstado();
  }
  function formar(nivel, n) {
    const elegidos = [...cola.entries()].filter(([, e]) => e.nivel === nivel).sort((a, b) => a[1].desde - b[1].desde).slice(0, n);
    for (const [id] of elegidos) cola.delete(id);
    pararReloj(nivel);
    rooms.crearPublica(elegidos.map(([id, e]) => ({ id, nombre: e.nombre })), nivel);
  }

  // ── Mensajes de MIS jugadores ──
  function buscar(userId, nivelPedido) {
    const ws = players.get(userId) && players.get(userId).socket;
    const actual = rooms.salaDe(userId);
    if (actual) return ws && send(ws, { type: 'sala_error', code: 'ya_en_sala', message: `Ya estás en la sala ${actual.codigo}`, hint: 'Sal de ella para buscar otra partida' });
    const nivel = nivelValido(nivelPedido);
    const previo = buscando.get(userId);
    buscando.set(userId, { desde: previo ? previo.desde : Date.now(), nivel });
    if (ws) send(ws, estadoPara(nivel));
    if (soyLider()) encolar(userId, COORDINATOR_ID, nivel);
    else sendPeer(lider(), { type: 'mm_buscar', userId, nivel });
  }
  function cancelar(userId, avisar = true) {
    if (!buscando.delete(userId)) return;
    if (soyLider()) desencolar(userId, COORDINATOR_ID);
    else sendPeer(lider(), { type: 'mm_cancelar', userId });
    const p = players.get(userId);
    if (avisar && p && p.socket) send(p.socket, { type: 'busqueda_estado', buscando: false });
  }

  /** RoomManager avisa cada cambio de sala: si un jugador mío que buscaba ya tiene sala, deja de buscar */
  function alCambiarSala(sala) {
    if (!sala || sala.estado === 'cerrada') return;
    for (const j of sala.jugadores) {
      if (!j.fuera && buscando.delete(j.id)) {
        const p = players.get(j.id);
        if (p && p.socket) send(p.socket, { type: 'busqueda_estado', buscando: false, encontrada: sala.codigo });
      }
    }
  }

  // ── Mesh ──
  function alMensajePeer(msg, origin) {
    switch (msg.type) {
      case 'mm_buscar':   if (soyLider()) encolar(String(msg.userId || ''), origin, msg.nivel); return true;
      case 'mm_cancelar': if (soyLider()) desencolar(String(msg.userId || ''), origin); return true;
      case 'mm_estado': {
        if (origin !== lider()) return true;                         // solo cuenta el estado de quien lleva la cola
        const limpio = {};
        for (const nivel of Object.keys(NIVELES)) {
          const e = msg.porNivel && msg.porNivel[nivel];
          if (e) limpio[nivel] = { enCola: Number(e.enCola) || 0, empiezaEn: Number.isFinite(e.empiezaEn) ? e.empiezaEn : null };
        }
        porNivel = limpio;
        avisarLocales();
        return true;
      }
      default:
        return false;
    }
  }
  /** Cambió el mesh: si cambió quien lleva la cola, le vuelvo a mandar a mis jugadores que buscan */
  function revisarLider() {
    const ahora = lider();
    if (ahora === liderAnterior) return;
    const antes = liderAnterior;
    liderAnterior = ahora;
    if (antes === null) return;
    console.log(`[parques] la cola de partidas públicas ahora la lleva ${ahora}`);
    if (ahora !== COORDINATOR_ID) { cola.clear(); pararTodos(); }
    for (const [userId, b] of buscando) {
      if (ahora === COORDINATOR_ID) encolar(userId, COORDINATOR_ID, b.nivel);
      else sendPeer(ahora, { type: 'mm_buscar', userId, nivel: b.nivel });
    }
    if (ahora === COORDINATOR_ID) evaluar();
  }
  liderAnterior = lider();

  /** Un jugador mío se desconectó (no por cambio de pestaña o de coordinador): deja de buscar */
  function alDesconectar(userId) { cancelar(userId, false); }

  return { buscar, cancelar, alCambiarSala, alMensajePeer, revisarLider, alDesconectar, estaBuscando: (id) => buscando.has(id), cola };
}

module.exports = { crearMatchmaking };
