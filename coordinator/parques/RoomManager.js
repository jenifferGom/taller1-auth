// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · RoomManager (salas repartidas entre coordinadores)
// ─────────────────────────────────────────────────────────────
//   · Cada sala tiene un coordinador DUEÑO (donde se creó). Solo el dueño aplica acciones: une y
//     retira jugadores y le pide a GameManager cada jugada. Los demás coordinadores tienen una COPIA.
//   · Cada cambio sube la versión "v" y el dueño REPLICA la sala completa a todos (sala_upsert)
//     ANTES de avisar a sus propios jugadores. Ante dos copias gana la v mayor (empate: dueño de id menor).
//   · Un jugador conectado a otro coordinador hace su acción allá; ese coordinador la reenvía al
//     dueño (sala_accion). El dueño solo la acepta si ese jugador está conectado a ese coordinador.
//   · Si el dueño se cae, el coordinador vivo de id menor ADOPTA sus salas desde la última copia.
//   · Una sala sin NADIE conectado durante SALA_ABANDONADA_MS se cierra (sala_borrar).
//   · Privada: solo se entra con el código exacto; no aparece en ninguna lista.
//     Pública: la crea Matchmaking con los jugadores ya agrupados y arranca sola tras una cuenta.
const crypto = require('crypto');
const GM = require('./GameManager');
const { NIVELES, REGLAS } = require('./GameRules');

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';        // sin 0/O ni 1/I: se dictan fácil
const CODIGO_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const azar = (n) => crypto.randomInt(n);
const tirarDados = () => [1 + azar(6), 1 + azar(6)];
const err = (code, message) => ({ error: { code, message } });

// ── Acciones de sala (puras): unirse, salir, listo, agua. Las de juego las resuelve GameManager ──
function nuevaSala({ codigo, uid, tipo, nivel, maxJugadores, anfitrion }) {
  return {
    codigo, uid, tipo,                                   // tipo: 'privada' | 'publica'
    nivel: NIVELES[nivel] ? nivel : 'normal',
    tablaShots: { ...NIVELES[NIVELES[nivel] ? nivel : 'normal'] },   // shots por evento de ESTE nivel (para el recuadro de reglas)
    reglas: { ...REGLAS },                               // las reglas con que se juega esta sala (también para el recuadro)
    maxJugadores,
    anfitrion: anfitrion.id,
    jugadores: [{ id: anfitrion.id, nombre: anfitrion.nombre, color: 0, listo: false, agua: false }],
    estado: 'espera',                                    // 'espera' | 'jugando' | 'fin' | 'cerrada'
    empiezaEn: null,                                     // pública: hora (ms) en que arranca sola
    game: null,
    shots: [],                                           // cola de shots: la partida se pausa hasta vaciarla
    sigShot: 1,
    ultimo: null,                                        // última jugada, para que todos la animen igual
    seq: 0,
    creada: Date.now(),
  };
}
const copia = (s) => ({ ...s, jugadores: s.jugadores.map(j => ({ ...j })), shots: [...s.shots] });

function agregarJugador(s, id, nombre) {
  s.jugadores = s.jugadores.filter(j => j.id !== id);
  const otros = s.jugadores.filter(j => !j.fuera);
  const usados = new Set(otros.map(j => j.color));
  // Si solo hay uno en la sala, el nuevo va a la esquina opuesta (diagonal); si no, se llenan
  // primero las diagonales (0 ↔ 2, luego 1 ↔ 3)
  const preferido = otros.length === 1 ? (otros[0].color + 2) % 4 : null;
  const color = preferido !== null && !usados.has(preferido) ? preferido : [0, 2, 1, 3].find(c => !usados.has(c));
  s.jugadores.push({ id, nombre: String(nombre || 'Jugador').slice(0, 32), color, listo: false, agua: false });
}

function aplicarSala(s0, accion, ctx) {
  const s = copia(s0);
  const yo = accion.userId;
  const miembro = s.jugadores.some(j => j.id === yo && !j.fuera);
  switch (accion.tipo) {
    case 'unirse': {
      if (miembro) return { sala: s };                                // ya estaba
      if (s.tipo !== 'privada') return err('sala_publica', 'A una partida pública se entra con "Jugar partida pública"');
      if (s.estado !== 'espera') return err('sala_en_juego', 'La partida de esa sala ya empezó');
      if (GM.activos(s).length >= s.maxJugadores) return err('sala_llena', `La sala está llena (${s.maxJugadores} jugadores)`);
      agregarJugador(s, yo, accion.nombre);
      return { sala: s };
    }
    case 'salir': {
      if (!miembro) return err('no_estas_en_la_sala', 'No estás en esa sala');
      if (s.estado === 'espera' || s.estado === 'fin') s.jugadores = s.jugadores.filter(j => j.id !== yo);
      else s.jugadores.forEach(j => { if (j.id === yo) j.fuera = true; });   // en plena partida: "fuera", se saltan sus turnos
      if (!GM.activos(s).length) { s.estado = 'cerrada'; return { sala: s }; }
      if (yo === s.anfitrion) s.anfitrion = GM.activos(s)[0].id;        // el anfitrión pasa al siguiente
      if (s.tipo === 'publica' && s.estado === 'espera' && GM.activos(s).length < ctx.minPublica) s.estado = 'cerrada';
      return { sala: GM.normalizar(s) };
    }
    case 'listo': {
      if (!miembro) return err('no_estas_en_la_sala', 'No estás en esa sala');
      if (s.estado !== 'espera') return err('sala_en_juego', 'La partida ya empezó');
      s.jugadores.forEach(j => { if (j.id === yo) j.listo = !!accion.listo; });
      return { sala: s };
    }
    case 'agua': {                                                    // Modo Agua: se puede cambiar en cualquier momento
      if (!miembro) return err('no_estas_en_la_sala', 'No estás en esa sala');
      s.jugadores.forEach(j => { if (j.id === yo) j.agua = !!accion.agua; });
      if (s.game) s.game = { ...s.game, jugadores: s.game.jugadores.map(j => (j.id === yo ? { ...j, agua: !!accion.agua } : j)) };
      return { sala: s };
    }
    default:
      if (!miembro) return err('no_estas_en_la_sala', 'No estás en esa sala');
      return GM.aplicar(s, accion, ctx);
  }
}

// ── Parte distribuida ──
function crearRoomManager({ COORDINATOR_ID, players, peers, replicate, send, sendPeer, config, alCambiarSala = () => {} }) {
  const salas = new Map();                                         // codigo → sala (con duenio, v y uid)

  const socketDe = (userId) => { const p = players.get(String(userId)); return p && p.socket; };
  const enLinea = (userId) => players.has(String(userId));
  const activosIds = (s) => s.jugadores.filter(j => !j.fuera).map(j => j.id);
  const vivos = () => [COORDINATOR_ID, ...peers.keys()].sort();
  const ctx = {
    tirarDados, azar, enLinea,
    minJugadores: config.privada.min, minPublica: config.publica.min,
  };

  function salaDe(userId) {
    for (const s of salas.values()) if (s.estado !== 'cerrada' && s.jugadores.some(j => j.id === userId && !j.fuera)) return s;
    return null;
  }
  function nuevoCodigo() {
    let c;
    do { c = Array.from({ length: 6 }, () => ALFABETO[azar(ALFABETO.length)]).join(''); } while (salas.has(c));
    return c;
  }
  const nuevoUid = () => `${COORDINATOR_ID}:${Date.now().toString(36)}:${crypto.randomBytes(3).toString('hex')}`;

  /** Lo que recibe un jugador: la sala y, si es su turno de mover, las jugadas válidas (las calcula el servidor) */
  function estadoPara(sala, userId) {
    return { type: 'sala_estado', sala, jugadas: GM.jugadasPara(sala, userId) };
  }
  function avisarSala(sala, antes = []) {
    const ahora = new Set(sala && sala.estado !== 'cerrada' ? activosIds(sala) : []);
    for (const id of new Set([...ahora, ...antes])) {
      const ws = socketDe(id);
      if (!ws) continue;
      send(ws, ahora.has(id) ? estadoPara(sala, id) : { type: 'sala_estado', sala: null, codigo: sala && sala.codigo, jugadas: [] });
    }
    alCambiarSala(sala);
  }
  function errorA(userId, origen, code, message) {
    if (origen === COORDINATOR_ID) {
      const ws = socketDe(userId);
      if (ws) send(ws, { type: 'sala_error', code, message, hint: pista(code) });
      return;
    }
    sendPeer(origen, { type: 'sala_error', userId, code, message });
  }

  // ── Un cambio hecho por mí (el dueño): versión nueva, réplica a todos y LUEGO aviso a mis jugadores ──
  function confirmar(antes, nueva) {
    const previos = antes ? activosIds(antes) : [];
    nueva.duenio = COORDINATOR_ID;
    nueva.v = ((antes && antes.v) || 0) + 1;
    if (nueva.estado === 'cerrada') {
      salas.delete(nueva.codigo);
      replicate({ type: 'sala_borrar', codigo: nueva.codigo, uid: nueva.uid, v: nueva.v });
      console.log(`[parques] ${nueva.codigo} cerrada`);
    } else {
      salas.set(nueva.codigo, nueva);
      replicate({ type: 'sala_upsert', sala: nueva });
    }
    avisarSala(nueva, previos);
    return nueva;
  }

  /** Aplica la acción si soy el dueño de la sala; si no, la reenvía al dueño por el mesh */
  function enrutar(codigo, accion, origen) {
    const sala = salas.get(codigo);
    if (!sala) return errorA(accion.userId, origen, 'codigo_invalido', 'No hay ninguna sala con ese código');
    if (sala.duenio !== COORDINATOR_ID) {
      if (origen !== COORDINATOR_ID) return;                          // no se reenvía dos veces
      if (sendPeer(sala.duenio, { type: 'sala_accion', codigo, accion })) return;
      return errorA(accion.userId, origen, 'sala_recuperandose', 'La sala se está pasando a otro servidor: intenta de nuevo en un momento');
    }
    // Versión: tirar y mover llevan la v que vio el jugador. Si la sala cambió desde entonces, se rechaza.
    if ((accion.tipo === 'tirar' || accion.tipo === 'mover') && Number.isInteger(accion.v) && accion.v !== sala.v) {
      return errorA(accion.userId, origen, 'sala_desactualizada', 'La partida cambió mientras jugabas: mira el tablero y vuelve a intentar');
    }
    let r;
    try { r = aplicarSala(sala, accion, ctx); }
    catch (e) { console.error(`[parques] error aplicando ${accion.tipo} en ${codigo}: ${e.message}`); r = err('error_interno', 'No se pudo aplicar la jugada'); }
    if (r.error) return errorA(accion.userId, origen, r.error.code, r.error.message);
    confirmar(sala, r.sala);
  }

  // ── Acciones que llegan de MIS jugadores (ya validados por el JWT) ──
  function crearPrivada(userId, username, datos) {
    const actual = salaDe(userId);
    if (actual) return { error: { code: 'ya_en_sala', message: `Ya estás en la sala ${actual.codigo}: sal de ella primero` } };
    const max = Math.min(config.privada.max, Math.max(config.privada.min, Number(datos.maxJugadores) || config.privada.max));
    const sala = nuevaSala({ codigo: nuevoCodigo(), uid: nuevoUid(), tipo: 'privada', nivel: datos.nivel, maxJugadores: max, anfitrion: { id: userId, nombre: username } });
    console.log(`[parques] ${username} creó la sala privada ${sala.codigo} (máx. ${max}, nivel ${sala.nivel})`);
    confirmar(null, sala);
    return { sala };
  }
  /** Matchmaking ya agrupó a estos jugadores: sala pública con cuenta regresiva; el dueño soy yo */
  function crearPublica(jugadores, nivel = config.nivelPublica) {
    const [primero, ...resto] = jugadores;
    const sala = nuevaSala({ codigo: nuevoCodigo(), uid: nuevoUid(), tipo: 'publica', nivel: NIVELES[nivel] ? nivel : config.nivelPublica,
      maxJugadores: jugadores.length, anfitrion: primero });
    for (const j of resto) agregarJugador(sala, j.id, j.nombre);
    sala.empiezaEn = Date.now() + config.cuentaPublicaMs;
    console.log(`[parques] partida pública ${sala.codigo} (nivel ${sala.nivel}): ${jugadores.map(j => j.nombre).join(', ')}`);
    return confirmar(null, sala);
  }
  function accionLocal(userId, username, accion) {
    const actual = salaDe(userId);
    if (accion.tipo === 'unirse') {
      if (!CODIGO_RE.test(accion.codigo || '')) return errorA(userId, COORDINATOR_ID, 'codigo_invalido', 'El código tiene 6 letras o números');
      if (actual && actual.codigo !== accion.codigo) return errorA(userId, COORDINATOR_ID, 'ya_en_sala', `Ya estás en la sala ${actual.codigo}: sal de ella primero`);
      return enrutar(accion.codigo, { ...accion, userId, nombre: username }, COORDINATOR_ID);
    }
    if (!actual) return errorA(userId, COORDINATOR_ID, 'sin_sala', 'No estás en ninguna sala');
    enrutar(actual.codigo, { ...accion, userId, nombre: username }, COORDINATOR_ID);
  }

  /** Al conectarse un jugador (recarga, otro coordinador, rebalanceo): si estaba en una sala, se la mando */
  function alBienvenida(ws, userId) {
    const s = salaDe(userId);
    send(ws, s ? estadoPara(s, userId) : { type: 'sala_estado', sala: null, jugadas: [] });
  }

  // ── Mesh ──
  function salaValida(s) {
    return s && typeof s.codigo === 'string' && CODIGO_RE.test(s.codigo) && typeof s.uid === 'string'
      && Array.isArray(s.jugadores) && s.jugadores.length <= 4 && Number.isInteger(s.v) && typeof s.duenio === 'string'
      && (s.tipo === 'privada' || s.tipo === 'publica') && Array.isArray(s.shots);
  }
  function alMensajePeer(msg, origin) {
    switch (msg.type) {
      case 'sala_upsert': {
        const s = msg.sala;
        if (!salaValida(s)) return true;
        const cur = salas.get(s.codigo);
        if (cur && cur.uid !== s.uid) {                              // dos salas distintas con el mismo código
          if (cur.duenio === COORDINATOR_ID && s.duenio < COORDINATOR_ID) {
            const renombrada = { ...cur, codigo: nuevoCodigo() };   // gana la del dueño de id menor: la mía cambia de código
            console.log(`[parques] el código ${cur.codigo} ya lo usa ${s.duenio}: mi sala pasa a ${renombrada.codigo}`);
            salas.set(s.codigo, s);
            confirmar(cur, renombrada);
            return true;
          }
          if (cur.duenio === COORDINATOR_ID) { sendPeer(origin, { type: 'sala_upsert', sala: cur }); return true; }   // gano yo: que el otro cambie
          if (cur.duenio < s.duenio) return true;
          salas.set(s.codigo, s); avisarSala(s, activosIds(cur));
          return true;
        }
        if (cur && !(s.v > cur.v || (s.v === cur.v && s.duenio < cur.duenio))) return true;   // la mía es más nueva
        if (cur && cur.duenio === COORDINATOR_ID && s.duenio !== COORDINATOR_ID) console.log(`[parques] ${s.codigo} ahora la maneja ${s.duenio}`);
        salas.set(s.codigo, s);
        avisarSala(s, cur ? activosIds(cur) : []);
        return true;
      }
      case 'sala_borrar': {
        const cur = salas.get(msg.codigo);
        if (cur && cur.uid === msg.uid && (!Number.isInteger(msg.v) || msg.v >= cur.v)) {
          salas.delete(msg.codigo);
          avisarSala({ ...cur, estado: 'cerrada' }, activosIds(cur));
        }
        return true;
      }
      case 'sala_accion': {                                         // un jugador de otro coordinador actúa en una sala mía
        const a = msg.accion || {};
        const userId = String(a.userId || '');
        const p = players.get(userId);
        // Solo el coordinador donde está conectado ese jugador puede hablar por él
        if (!p || p.origin !== origin || typeof msg.codigo !== 'string' || typeof a.tipo !== 'string') return true;
        enrutar(msg.codigo, { ...limpiarAccion(a), userId, nombre: p.username }, origin);
        return true;
      }
      case 'sala_error': {                                          // el dueño rechazó la acción de un jugador mío
        const ws = socketDe(msg.userId);
        if (!ws) return true;
        send(ws, { type: 'sala_error', code: String(msg.code || 'error'), message: String(msg.message || ''), hint: pista(msg.code) });
        const s = salaDe(String(msg.userId));
        if (msg.code === 'sala_desactualizada' && s) send(ws, estadoPara(s, String(msg.userId)));
        return true;
      }
      default:
        return false;
    }
  }
  function alConectarPeer(peerId) {                                  // le paso las salas que manejo yo
    for (const s of salas.values()) if (s.duenio === COORDINATOR_ID) sendPeer(peerId, { type: 'sala_upsert', sala: s });
  }
  // Salas cuyo dueño ya no está en el mesh. Se espera ADOPCION_GRACIA_MS por si solo fue un corte breve.
  const ADOPCION_GRACIA_MS = 2000;
  const ausenteDesde = new Map();                                    // coordinatorId → desde cuándo no está
  function adoptarHuerfanas() {
    const ahora = Date.now();
    for (const id of [...ausenteDesde.keys()]) if (peers.has(id)) ausenteDesde.delete(id);
    if (vivos()[0] !== COORDINATOR_ID) return;                        // adopta solo el vivo de id menor
    for (const s of [...salas.values()]) {
      if (s.duenio === COORDINATOR_ID || peers.has(s.duenio)) continue;
      if (!ausenteDesde.has(s.duenio)) ausenteDesde.set(s.duenio, ahora);
      if (ahora - ausenteDesde.get(s.duenio) < ADOPCION_GRACIA_MS) continue;
      console.log(`[parques] ${s.duenio} no está: adopto la sala ${s.codigo} (v ${s.v})`);
      confirmar(s, copia(s));
    }
  }

  // ── Tareas periódicas del dueño ──
  const vaciaDesde = new Map();
  setInterval(() => {
    const ahora = Date.now();
    adoptarHuerfanas();
    for (const s of [...salas.values()]) {
      if (s.duenio !== COORDINATOR_ID) { vaciaDesde.delete(s.codigo); continue; }
      // Pública en espera: al terminar la cuenta arranca sola (o se cierra si ya no hay suficientes)
      if (s.tipo === 'publica' && s.estado === 'espera' && s.empiezaEn && s.empiezaEn <= ahora) {
        const nueva = copia(s);
        if (GM.activos(nueva).length >= config.publica.min) GM.iniciar(nueva, ctx);
        else nueva.estado = 'cerrada';
        confirmar(s, nueva);
        continue;
      }
      // Sala abandonada: nadie conectado durante SALA_ABANDONADA_MS
      if (activosIds(s).some(enLinea)) { vaciaDesde.delete(s.codigo); continue; }
      if (!vaciaDesde.has(s.codigo)) vaciaDesde.set(s.codigo, ahora);
      else if (ahora - vaciaDesde.get(s.codigo) >= config.salaAbandonadaMs) {
        vaciaDesde.delete(s.codigo);
        console.log(`[parques] ${s.codigo} lleva ${Math.round(config.salaAbandonadaMs / 1000)} s sin jugadores conectados`);
        confirmar(s, { ...copia(s), estado: 'cerrada' });
      }
    }
  }, 500).unref();

  return { salas, salaDe, crearPrivada, crearPublica, accionLocal, alBienvenida, alMensajePeer, alConectarPeer, adoptarHuerfanas, errorA };
}

/** Solo los campos que cada acción necesita, con su tipo correcto (no se confía en el mesh) */
function limpiarAccion(a) {
  const out = { tipo: String(a.tipo) };
  if (typeof a.codigo === 'string') out.codigo = a.codigo;
  if ('listo' in a) out.listo = !!a.listo;
  if ('agua' in a) out.agua = !!a.agua;
  if (Number.isInteger(a.v)) out.v = a.v;
  if (Number.isInteger(a.ficha)) out.ficha = a.ficha;
  if (Array.isArray(a.dados)) out.dados = a.dados.filter(Number.isInteger).slice(0, 2);
  if (Number.isInteger(a.shotId)) out.shotId = a.shotId;
  if (typeof a.jugadorId === 'string') out.jugadorId = a.jugadorId;
  return out;
}

const PISTAS = {
  codigo_invalido: 'Revisa el código que te pasaron (6 letras o números)',
  ya_en_sala: 'Sal de tu sala actual para crear o unirte a otra',
  sala_llena: 'Pídele al anfitrión que cree otra sala',
  sala_en_juego: 'Espera a que termine o crea otra sala',
  no_es_tu_turno: 'Espera tu turno',
  sala_desactualizada: 'El tablero ya se actualizó: vuelve a intentar',
  shot_pendiente: 'Primero confirmen el shot 🥃',
  sala_recuperandose: 'Intenta de nuevo en unos segundos',
};
const pista = (code) => PISTAS[code] || '';

module.exports = { crearRoomManager, nuevaSala, aplicarSala, limpiarAccion, CODIGO_RE };