// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · enlace con el coordinador
// ─────────────────────────────────────────────────────────────
// coordinator/index.js crea el módulo con crearParques(...) y llama sus ganchos. Aquí se validan los
// mensajes del cliente y del mesh y se pasan a RoomManager o a Matchmaking. No guarda estado propio.
//
// Cliente → coordinador: partida_buscar, partida_cancelar, sala_crear, sala_unirse, sala_salir,
//   sala_listo, sala_agua, sala_empezar, sala_tirar, sala_mover, sala_shot_ok, sala_elegir,
//   sala_saltar, sala_revancha
// Coordinador → cliente: salas_config, sala_estado { sala | null, jugadas }, busqueda_estado, sala_error
// Mesh: sala_upsert, sala_borrar, sala_accion, sala_error, mm_buscar, mm_cancelar, mm_estado
const { leerConfig } = require('./config');
const { crearRoomManager } = require('./RoomManager');
const { crearMatchmaking } = require('./Matchmaking');

const MENSAJES = {
  partida_buscar:   '{"type":"partida_buscar","nivel":"normal"} → busca una partida pública de ese nivel de shots (suave | normal | guaro)',
  partida_cancelar: '{"type":"partida_cancelar"} → deja de buscar',
  sala_crear:       '{"type":"sala_crear","maxJugadores":4,"nivel":"normal"} → crea una sala privada (nivel: suave | normal | guaro)',
  sala_unirse:      '{"type":"sala_unirse","codigo":"ABC234"} → entra a una sala privada con su código',
  sala_salir:       '{"type":"sala_salir"} → sale de tu sala',
  sala_listo:       '{"type":"sala_listo","listo":true} → listo para empezar (sala privada)',
  sala_agua:        '{"type":"sala_agua","agua":true} → Modo Agua: agua o reto en vez de guaro',
  sala_empezar:     '{"type":"sala_empezar"} → el anfitrión empieza la partida privada',
  sala_tirar:       '{"type":"sala_tirar","v":12} → tira los dados (v = versión de la sala que ves)',
  sala_mover:       '{"type":"sala_mover","v":13,"ficha":0,"dados":[0]} → mueve una ficha (una de tus "jugadas")',
  sala_shot_ok:     '{"type":"sala_shot_ok","shotId":3} → confirma que te tomaste el shot',
  sala_elegir:      '{"type":"sala_elegir","shotId":4,"jugadorId":"7"} → a quién mandas a tomar por comer',
  sala_saltar:      '{"type":"sala_saltar"} → el anfitrión salta el turno de un jugador desconectado',
  sala_revancha:    '{"type":"sala_revancha"} → el anfitrión pide revancha (sala privada)',
};
const ACCIONES = {                                    // tipo de mensaje → acción de sala
  sala_unirse: 'unirse', sala_salir: 'salir', sala_listo: 'listo', sala_agua: 'agua', sala_empezar: 'empezar',
  sala_tirar: 'tirar', sala_mover: 'mover', sala_shot_ok: 'shot_ok', sala_elegir: 'elegir',
  sala_saltar: 'saltar', sala_revancha: 'revancha',
};
const MESH = new Set(['sala_upsert', 'sala_borrar', 'sala_accion', 'sala_error', 'mm_buscar', 'mm_cancelar', 'mm_estado']);

function crearParques({ COORDINATOR_ID, players, peers, replicate, send, WebSocket, env = process.env }) {
  const config = leerConfig(env);
  const sendPeer = (peerId, payload) => {
    const r = peers.get(peerId);
    if (!r || r.ws.readyState !== WebSocket.OPEN) return false;
    r.ws.send(JSON.stringify({ ...payload, origin: COORDINATOR_ID }));
    return true;
  };
  let mm = null;
  const oyentes = [];                                   // otros interesados en cada cambio de sala (espectadores)
  const rooms = crearRoomManager({ COORDINATOR_ID, players, peers, replicate, send, sendPeer, config,
    alCambiarSala: (sala) => {
      if (mm) mm.alCambiarSala(sala);
      for (const f of oyentes) { try { f(sala); } catch (e) { console.error('[parques] oyente de sala:', e.message); } }
    } });
  mm = crearMatchmaking({ COORDINATOR_ID, players, peers, send, sendPeer, replicate, rooms, config });
  console.log(`[parques] salas listas · pública ${config.publica.min}-${config.publica.max} jugadores (espera ${config.esperaPublicaMs / 1000} s, nivel ${config.nivelPublica}) · privada ${config.privada.min}-${config.privada.max}`);

  const error = (ws, code, message, hint = '') => send(ws, { type: 'sala_error', code, message, hint });

  /** Mensaje de un jugador conectado aquí. Devuelve true si era de salas (y ya se atendió). */
  function alMensajeCliente(ws, userId, username, msg) {
    const t = msg.type;
    if (t !== 'partida_buscar' && t !== 'partida_cancelar' && t !== 'sala_crear' && !ACCIONES[t]) return false;

    if (t === 'partida_buscar') { mm.buscar(userId, typeof msg.nivel === 'string' ? msg.nivel : undefined); return true; }
    if (t === 'partida_cancelar') { mm.cancelar(userId); return true; }
    if (mm.estaBuscando(userId) && (t === 'sala_crear' || t === 'sala_unirse')) {
      error(ws, 'buscando_partida', 'Estás buscando una partida pública', 'Cancela la búsqueda para crear o unirte a una sala privada');
      return true;
    }
    if (t === 'sala_crear') {
      const nivel = typeof msg.nivel === 'string' ? msg.nivel : 'normal';
      const r = rooms.crearPrivada(userId, username, { maxJugadores: Number(msg.maxJugadores), nivel });
      if (r.error) error(ws, r.error.code, r.error.message, 'Sal de tu sala actual para crear otra');
      return true;
    }

    // Se arma la acción solo con los campos válidos para su tipo; el userId sale del JWT, nunca del mensaje
    const tipo = ACCIONES[t];
    const accion = { tipo };
    if (tipo === 'unirse') accion.codigo = String(msg.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (tipo === 'listo') accion.listo = msg.listo === true;
    if (tipo === 'agua') accion.agua = msg.agua === true;
    if (tipo === 'tirar' || tipo === 'mover') { if (Number.isInteger(msg.v)) accion.v = msg.v; }
    if (tipo === 'mover') {
      if (!Number.isInteger(msg.ficha) || !Array.isArray(msg.dados) || !msg.dados.length || msg.dados.length > 2 || !msg.dados.every(d => d === 0 || d === 1)) {
        error(ws, 'movimiento_invalido', 'Movimiento mal formado', 'Envía una de las "jugadas" que te mandó el servidor: {"ficha":0,"dados":[0]}');
        return true;
      }
      accion.ficha = msg.ficha; accion.dados = msg.dados;
    }
    if (tipo === 'shot_ok' || tipo === 'elegir') {
      if (!Number.isInteger(msg.shotId)) { error(ws, 'shot_no_vigente', 'Falta shotId'); return true; }
      accion.shotId = msg.shotId;
    }
    if (tipo === 'elegir') accion.jugadorId = String(msg.jugadorId || '').slice(0, 64);
    rooms.accionLocal(userId, username, accion);
    return true;
  }

  return {
    mensajes: MENSAJES,
    config,
    /** registra una función que recibe cada sala que cambia en este coordinador (la usa el modo espectador) */
    onCambioSala: (f) => oyentes.push(f),
    rooms,
    matchmaking: mm,
    alMensajeCliente,
    /** después del welcome: los rangos de jugadores (para la interfaz) y la sala del jugador, si estaba en una */
    alBienvenida: (ws, userId) => {
      send(ws, { type: 'salas_config', publica: config.publica, privada: config.privada, nivelPublica: config.nivelPublica });
      rooms.alBienvenida(ws, userId);
    },
    /** logout: sale de la sala y deja de buscar */
    alLogout: (userId, username) => {
      mm.alDesconectar(userId);
      if (rooms.salaDe(userId)) rooms.accionLocal(userId, username, { tipo: 'salir' });
    },
    /** se cerró la conexión activa del jugador (no por otra pestaña ni por cambio de coordinador) */
    alDesconectar: (userId) => mm.alDesconectar(userId),
    /** mensaje del mesh (origin ya validado). Devuelve true si era de salas. */
    alMensajePeer: (msg, origin) => {
      if (!MESH.has(msg.type)) return false;
      if (msg.type.startsWith('mm_')) return mm.alMensajePeer(msg, origin);
      return rooms.alMensajePeer(msg, origin);
    },
    /** un peer terminó el hello (después de sendLocalSnapshot) */
    alConectarPeer: (peerId) => { rooms.alConectarPeer(peerId); mm.revisarLider(); },
    /** se perdió un peer */
    alPerderPeer: () => { rooms.adoptarHuerfanas(); mm.revisarLider(); },
  };
}

module.exports = { crearParques };
