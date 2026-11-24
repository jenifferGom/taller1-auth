// ─────────────────────────────────────────────────────────────
// Guaro Royal · CHAT DISTRIBUIDO (track principal del examen final)
// ─────────────────────────────────────────────────────────────
// 1. El jugador manda { type: 'chat_send', text } por SU WebSocket al coordinador local.
// 2. El coordinador valida (longitud, caracteres de control, rate limit), le pone autor desde el JWT
//    (nunca desde el mensaje), un id único y una marca de reloj HLC, lo guarda y lo REPLICA por el mesh
//    (chat_msg). Cada coordinador lo entrega a sus jugadores y espectadores.
// CANALES: "general" (todos los jugadores del lobby, de todos los coordinadores) y uno INDEPENDIENTE por
// cada sala de parqués ("sala:ABC234"): ese solo lo leen y escriben los jugadores de la sala —estén en el
// coordinador que estén— y lo leen los espectadores que la miran. Cada canal tiene su historial y su orden;
// el de una sala se borra cuando la sala se cierra.
// 3. Historial: cada coordinador guarda en memoria los últimos CHAT_HISTORIAL mensajes POR CANAL. Un cliente
//    recién conectado los recibe (chat_historial); un coordinador que entra al mesh recibe el de cada
//    peer y lo mezcla con el suyo.
//
// ORDEN: ¿Alice en coord-A escribe "hola" y Bob en coord-B "qué tal" a los pocos ms; en qué orden los ve
// Charlie en coord-C? Cada mensaje lleva una marca de RELOJ HÍBRIDO (HLC: tiempo físico + contador lógico)
// y el orden es TOTAL por la clave (t, c, origin, seq):
//   · Si B ya había visto "hola" cuando escribe, su marca es MAYOR (causalidad): "qué tal" va después.
//   · Si fueron concurrentes, gana el de t menor (≈ el que se escribió antes según los relojes), y en
//     empate decide el id del coordinador. Es arbitrario pero IGUAL para todos.
//   · Un mensaje que llega tarde (red lenta) se inserta en su lugar: todos los clientes terminan con
//     la MISMA lista en el MISMO orden, sin importar el orden de llegada.
// Un peer con el reloj adelantado no puede arrastrar el reloj de todos: si su t supera al nuestro en
// más de CHAT_MAX_DESFASE_MS, se ordena con su marca pero no se adopta.

const CANAL_RE = /^(general|sala:[A-HJ-NP-Z2-9]{6})$/;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g;   // control, ancho cero y bidi

function entero(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; }

function leerConfigChat(env = process.env) {
  return {
    maxLargo: entero(env.CHAT_MAX_LARGO, 200),            // caracteres por mensaje
    historial: entero(env.CHAT_HISTORIAL, 50),            // mensajes guardados por coordinador
    porVentana: entero(env.CHAT_POR_VENTANA, 5),          // rate limit: N mensajes…
    ventanaMs: entero(env.CHAT_VENTANA_MS, 10000),        // …cada tantos ms
    silencioMs: entero(env.CHAT_SILENCIO_MS, 30000),      // si insiste después del límite, queda silenciado
    avisosAntesDeSilencio: entero(env.CHAT_AVISOS, 3),
    maxDesfaseMs: entero(env.CHAT_MAX_DESFASE_MS, 60000),
  };
}

/** Deja el texto en una sola línea, sin caracteres de control ni invisibles. NO se escapa HTML aquí:
 *  el texto se guarda tal cual y el CLIENTE lo pinta como texto (textContent), así "<b>" se ve literal. */
function limpiarTexto(t) {
  return String(t).replace(/[\r\n\t]+/g, ' ').replace(CONTROL, '').replace(/\s{2,}/g, ' ').trim();
}
const largo = (t) => [...t].length;                         // en caracteres reales (un emoji cuenta 1)

/** Orden total de los mensajes: (t, c, origin, seq) */
function comparar(a, b) {
  return a.t - b.t || a.c - b.c || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0) || a.seq - b.seq;
}

/**
 * difundir(payload)              → canal general: a todos mis jugadores y espectadores
 * entregarSala(codigo, payload)  → canal de una sala: a mis jugadores de esa sala y a mis espectadores que la miran
 * puedeEscribirSala(userId, codigo) / salaDe(userId) → ¿es jugador de esa sala? / ¿en qué sala está?
 */
function crearChat({ COORDINATOR_ID, replicate, sendPeer, send, difundir, entregarSala = () => {},
  puedeEscribirSala = () => false, salaDe = () => null, env = process.env, ahora = () => Date.now() }) {
  const cfg = leerConfigChat(env);
  const canales = new Map();           // canal → { mensajes: [] ordenados, vistos: Set de ids }
  const canal = (nombre) => { if (!canales.has(nombre)) canales.set(nombre, { mensajes: [], vistos: new Set() }); return canales.get(nombre); };
  const mensajes = canal('general').mensajes;   // el general siempre existe
  const limites = new Map();           // userId → { envios: [ms], avisos, silenciadoHasta }
  let reloj = { t: 0, c: 0 };          // HLC de este coordinador
  let seq = 0;
  const stats = { enviados: 0, replicadosRecibidos: 0, rechazados: 0, limitados: 0 };

  // ── Reloj híbrido (HLC) ──
  function marcaLocal() {
    const pt = ahora();
    reloj = pt > reloj.t ? { t: pt, c: 0 } : { t: reloj.t, c: reloj.c + 1 };
    return { ...reloj };
  }
  function recibirMarca(m) {
    const pt = ahora();
    if (m.t - pt > cfg.maxDesfaseMs) return;                 // reloj del otro demasiado adelantado: no se adopta
    const t = Math.max(reloj.t, m.t, pt);
    const c = t === reloj.t && t === m.t ? Math.max(reloj.c, m.c) + 1 : t === reloj.t ? reloj.c + 1 : t === m.t ? m.c + 1 : 0;
    reloj = { t, c };
  }

  // ── Historial ──
  /** Inserta en su lugar (por la clave de orden) dentro de SU canal. Devuelve false si ya estaba. */
  function guardar(m) {
    const { mensajes: lista, vistos } = canal(m.canal);
    if (vistos.has(m.id)) return false;
    vistos.add(m.id);
    let i = lista.length;
    while (i > 0 && comparar(lista[i - 1], m) > 0) i--;      // casi siempre va al final: recorrido corto
    lista.splice(i, 0, m);
    while (lista.length > cfg.historial) vistos.delete(lista.shift().id);
    return true;
  }
  /** Entrega a los clientes de ESTE coordinador que pueden leer ese canal */
  function entregar(m) {
    const payload = { type: 'chat_msg', msg: m };
    if (m.canal === 'general') difundir(payload);
    else entregarSala(m.canal.slice(5), payload);
  }
  /** ¿Un mensaje que llegó por el mesh tiene la forma correcta? (no se confía en nadie) */
  function valido(m) {
    if (!m || typeof m !== 'object') return null;
    const { id, origin, userId, username } = m;
    if (typeof id !== 'string' || id.length > 120 || typeof origin !== 'string' || origin.length > 64) return null;
    if (typeof userId !== 'string' || userId.length > 64 || typeof username !== 'string' || username.length > 64) return null;
    if (!Number.isFinite(m.t) || !Number.isInteger(m.c) || m.c < 0 || !Number.isInteger(m.seq) || m.seq < 0) return null;
    if (typeof m.text !== 'string') return null;
    const text = limpiarTexto(m.text);
    if (!text || largo(text) > cfg.maxLargo) return null;
    const c = m.canal === undefined ? 'general' : m.canal;
    if (typeof c !== 'string' || !CANAL_RE.test(c)) return null;
    return { id, origin, seq: m.seq, t: m.t, c: m.c, canal: c, userId, username: limpiarTexto(username), text, ts: Number.isFinite(m.ts) ? m.ts : m.t };
  }

  // ── Rate limit por jugador: N mensajes por ventana; si insiste, silencio temporal ──
  function revisarLimite(userId) {
    const t = ahora();
    const l = limites.get(userId) || { envios: [], avisos: 0, silenciadoHasta: 0 };
    limites.set(userId, l);
    if (l.silenciadoHasta > t) return { code: 'chat_silenciado', retryInMs: l.silenciadoHasta - t };
    l.envios = l.envios.filter(x => t - x < cfg.ventanaMs);
    if (l.envios.length >= cfg.porVentana) {
      l.avisos++;
      if (l.avisos >= cfg.avisosAntesDeSilencio) {
        l.silenciadoHasta = t + cfg.silencioMs; l.avisos = 0;
        return { code: 'chat_silenciado', retryInMs: cfg.silencioMs };
      }
      return { code: 'chat_rate_limited', retryInMs: cfg.ventanaMs - (t - l.envios[0]) };
    }
    l.envios.push(t);
    if (l.envios.length === 1) l.avisos = 0;                     // ventana limpia: se perdonan los avisos
    return null;
  }

  // ── Del jugador local ──
  function alMensajeCliente(ws, userId, username, msg) {
    if (msg.type === 'chat_historial_pedir') {                 // el cliente entró a una sala: quiere ese historial
      const c = typeof msg.canal === 'string' ? msg.canal : 'general';
      if (!CANAL_RE.test(c)) return true;
      if (c !== 'general' && !puedeEscribirSala(String(userId), c.slice(5))) return true;   // solo los de la sala
      enviarHistorial(ws, c);
      return true;
    }
    if (msg.type !== 'chat_send') return false;
    const error = (code, message, hint, extra = {}) => { stats.rechazados++; send(ws, { type: 'chat_error', code, message, hint, canal: msg.canal, ...extra }); };
    const destino = msg.canal === undefined ? 'general' : msg.canal;
    if (typeof destino !== 'string' || !CANAL_RE.test(destino)) return error('chat_canal_invalido', 'Canal de chat inválido', 'Usa "general" o "sala:CODIGO"'), true;
    if (destino !== 'general' && !puedeEscribirSala(String(userId), destino.slice(5))) {
      return error('chat_no_en_sala', 'Solo los jugadores de esa partida pueden escribir en su chat', 'Usa el chat general'), true;
    }
    if (typeof msg.text !== 'string') return error('chat_invalido', 'El mensaje debe ser texto', 'Envía {"type":"chat_send","text":"hola"}'), true;
    if (msg.text.length > cfg.maxLargo * 4) return error('chat_muy_largo', `Máximo ${cfg.maxLargo} caracteres`, 'Escribe un mensaje más corto'), true;
    const text = limpiarTexto(msg.text);
    if (!text) return error('chat_vacio', 'El mensaje está vacío', 'Escribe algo antes de enviar'), true;
    if (largo(text) > cfg.maxLargo) return error('chat_muy_largo', `Máximo ${cfg.maxLargo} caracteres (tiene ${largo(text)})`, 'Escribe un mensaje más corto'), true;
    const limite = revisarLimite(userId);
    if (limite) {
      stats.limitados++;
      const segs = Math.ceil(limite.retryInMs / 1000);
      console.log(`[chat] ${username}: ${limite.code} (${segs} s)`);
      return error(limite.code, limite.code === 'chat_silenciado' ? `Silenciado por spam durante ${segs} s` : `Vas muy rápido: espera ${segs} s`,
        `Máximo ${cfg.porVentana} mensajes cada ${cfg.ventanaMs / 1000} s`, { retryInMs: limite.retryInMs }), true;
    }
    const marca = marcaLocal();
    const m = { id: `${COORDINATOR_ID}:${marca.t}:${++seq}`, origin: COORDINATOR_ID, seq, t: marca.t, c: marca.c,
      canal: destino, userId: String(userId), username, text, ts: marca.t };
    guardar(m);
    stats.enviados++;
    replicate({ type: 'chat_msg', msg: m });                    // 1.º a los demás coordinadores…
    entregar(m);                                                // …2.º a mis jugadores (y espectadores) de ese canal
    return true;
  }

  // ── Del mesh ──
  function alMensajePeer(msg, origin) {
    if (msg.type === 'chat_msg') {
      const m = valido(msg.msg);
      if (!m || m.origin !== origin) return true;               // solo el coordinador autor replica en vivo
      recibirMarca(m);
      stats.replicadosRecibidos++;
      if (guardar(m)) entregar(m);
      return true;
    }
    if (msg.type === 'chat_historial') {                        // un peer me pasa su historial al conectarnos
      // Formato: { canales: { general: [...], 'sala:ABC234': [...] } } (o el viejo { mensajes: [...] } = general)
      const grupos = msg.canales && typeof msg.canales === 'object' ? msg.canales : { general: msg.mensajes };
      const nuevos = [];
      for (const [nombre, lista] of Object.entries(grupos)) {
        if (!CANAL_RE.test(nombre) || !Array.isArray(lista)) continue;
        for (const x of lista.slice(-cfg.historial)) {
          const m = valido({ ...x, canal: nombre });
          if (m) { recibirMarca(m); if (guardar(m)) nuevos.push(m); }
        }
      }
      for (const m of nuevos.sort(comparar)) if (canal(m.canal).mensajes.includes(m)) entregar(m);
      return true;
    }
    return false;
  }
  function alConectarPeer(peerId) {
    const todos = {};
    for (const [nombre, c] of canales) if (c.mensajes.length) todos[nombre] = c.mensajes;
    if (Object.keys(todos).length) sendPeer(peerId, { type: 'chat_historial', canales: todos });
  }
  function enviarHistorial(ws, nombre) {
    send(ws, { type: 'chat_historial', canal: nombre, mensajes: canales.has(nombre) ? canales.get(nombre).mensajes : [], maxLargo: cfg.maxLargo });
  }
  /** Cliente recién conectado: el historial general y, si es un jugador que está en una sala, el de su sala */
  function alConectarCliente(ws, userId = null) {
    enviarHistorial(ws, 'general');
    const codigo = userId ? salaDe(String(userId)) : null;
    if (codigo) enviarHistorial(ws, `sala:${codigo}`);
  }
  /** La sala se cerró: su chat desaparece */
  function borrarCanal(nombre) { if (nombre !== 'general') canales.delete(nombre); }

  return { alMensajeCliente, alMensajePeer, alConectarPeer, alConectarCliente, enviarHistorial, borrarCanal,
    historial: (nombre) => (canales.has(nombre) ? canales.get(nombre).mensajes : []),
    canales, mensajes, config: cfg, stats, reloj: () => ({ ...reloj }) };
}

module.exports = { crearChat, limpiarTexto, comparar, leerConfigChat };
