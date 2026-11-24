// ─────────────────────────────────────────────────────────────
// Guaro Royal · MODO ESPECTADOR (track secundario del examen final)
// ─────────────────────────────────────────────────────────────
// WebSocket SIN autenticación en /spectate (misma URL del coordinador, otra ruta que /connect):
//   · Recibe el "state" del mundo igual que un jugador, el chat (solo leer) y, si elige una partida de
//     parqués, su sala en tiempo real (sala_estado). NO puede mandar intent, extras_update, chat_send ni
//     ninguna acción de sala: se ignoran sin romper nada y se le responde "spectator_read_only".
//   · Los espectadores viven en su PROPIO conjunto, separado del Map de jugadores: no aparecen en el
//     mundo, no cuentan en connectedPlayers (el heartbeat al directorio) y no afectan el balanceo.
//
// Costo (lo difícil del track): 1000 espectadores cuestan casi lo mismo que 1000 jugadores en red. Por eso:
//   · el estado se serializa UNA vez por envío y se manda el mismo texto a todos (sin "you" por persona);
//   · se les manda a menor frecuencia: 1 de cada SPECTATOR_STATE_EVERY ticks (por defecto 10 Hz, no 20);
//   · hay un tope por coordinador (SPECTATORS_MAX, 100): el que llega lleno se cierra con 4003 y la página
//     del espectador pide otro coordinador al directorio (?exclude=), como hace el lobby;
//   · mensajes del espectador de máximo 2 KB (maxPayload) y respuestas de error limitadas a 1 por segundo.
const { WebSocketServer, WebSocket } = require('ws');

const CODIGO_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const PERMITIDOS = {
  ping:          '{"type":"ping"}',
  salas_listar:  '{"type":"salas_listar"} → partidas públicas para mirar',
  espectar_sala: '{"type":"espectar_sala","codigo":"ABC234"} → mirar una partida (pública o privada con su código)',
  dejar_sala:    '{"type":"dejar_sala"} → volver al mundo',
};
const CLOSE_LLENO = 4003;

function entero(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; }

function crearEspectadores({ COORDINATOR_ID, world, rooms, chat, env = process.env }) {
  const MAX = entero(env.SPECTATORS_MAX, 100);
  const CADA = entero(env.SPECTATOR_STATE_EVERY, 2);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  const espectadores = new Set();
  const stats = { conectadosTotal: 0, rechazadosPorCupo: 0, accionesIgnoradas: 0 };
  let n = 0, ticks = 0;

  const enviar = (ws, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
  const enviarRaw = (ws, raw) => { if (ws.readyState === WebSocket.OPEN) ws.send(raw); };

  function salasPublicas() {
    const lista = [];
    let privadas = 0;
    for (const s of rooms.salas.values()) {
      if (s.estado === 'cerrada') continue;
      if (s.tipo !== 'publica') { privadas++; continue; }
      lista.push({ codigo: s.codigo, nivel: s.nivel, estado: s.estado, jugadores: s.jugadores.filter(j => !j.fuera).map(j => j.nombre) });
    }
    return { type: 'salas_publicas', salas: lista, privadas };
  }

  /** Upgrade de /spectate: sin token. Si el coordinador está lleno, se explica y se cierra con 4003. */
  function handleUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (espectadores.size >= MAX) {
        stats.rechazadosPorCupo++;
        enviar(ws, { type: 'error', code: 'spectators_full', message: `Este coordinador ya tiene ${MAX} espectadores`,
          hint: 'Pide otro coordinador al directorio (GET /coordinator?exclude=' + COORDINATOR_ID + ')' });
        return ws.close(CLOSE_LLENO, 'spectators full');
      }
      conectar(ws);
    });
  }

  function conectar(ws) {
    ws.espectadorId = `esp-${++n}`;
    ws.sala = null;
    ws.isAlive = true;
    ws.ultimoAviso = 0;
    espectadores.add(ws);
    stats.conectadosTotal++;
    console.log(`[espectador] + ${ws.espectadorId} (${espectadores.size} mirando)`);
    enviar(ws, {
      type: 'bienvenida_espectador',
      message: `Modo espectador en ${COORDINATOR_ID}: solo puedes mirar`,
      coordinatorId: COORDINATOR_ID, espectadorId: ws.espectadorId, world,
      mensajesPermitidos: PERMITIDOS,
    });
    chat.alConectarCliente(ws);
    enviar(ws, salasPublicas());

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { /* se trata como acción no permitida */ }
      const tipo = msg && typeof msg.type === 'string' ? msg.type : '';
      switch (tipo) {
        case 'ping': return enviar(ws, { type: 'pong', serverTime: new Date().toISOString() });
        case 'salas_listar': return enviar(ws, salasPublicas());
        case 'espectar_sala': {
          const codigo = String(msg.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
          const sala = CODIGO_RE.test(codigo) ? rooms.salas.get(codigo) : null;
          if (!sala || sala.estado === 'cerrada') return enviar(ws, { type: 'error', code: 'codigo_invalido', message: 'No hay ninguna partida con ese código' });
          ws.sala = codigo;
          enviar(ws, { type: 'sala_estado', sala, jugadas: [], espectador: true });
          return chat.enviarHistorial(ws, `sala:${codigo}`);       // y el chat de esa partida (solo leer)
        }
        case 'dejar_sala':
          ws.sala = null;
          return enviar(ws, { type: 'sala_estado', sala: null, jugadas: [], espectador: true });
        default: {
          // intent, extras_update, chat_send, sala_tirar… o basura: se IGNORA sin tocar el estado del juego
          stats.accionesIgnoradas++;
          const ahora = Date.now();
          if (ahora - ws.ultimoAviso >= 1000) {
            ws.ultimoAviso = ahora;
            console.log(`[espectador] ${ws.espectadorId} intentó "${tipo || 'mensaje inválido'}": ignorado`);
            enviar(ws, { type: 'error', code: 'spectator_read_only', message: 'Modo espectador: solo puedes mirar',
              hint: `Mensajes permitidos: ${Object.keys(PERMITIDOS).join(', ')}. Inicia sesión para jugar.` });
          }
        }
      }
    });
    ws.on('close', () => { espectadores.delete(ws); console.log(`[espectador] - ${ws.espectadorId} (${espectadores.size} mirando)`); });
    ws.on('error', () => {});
  }

  /** Desde el game loop: el estado del mundo, serializado una vez, cada CADA ticks */
  function tick(now, snapshot) {
    if (!espectadores.size || (++ticks % CADA) !== 0) return;
    const raw = JSON.stringify({ type: 'state', t: now, coordinatorId: COORDINATOR_ID, spectator: true, players: snapshot() });
    for (const ws of espectadores) enviarRaw(ws, raw);
  }
  /** Chat y otros avisos para todos los espectadores */
  function difundir(payload) {
    if (!espectadores.size) return;
    const raw = JSON.stringify(payload);
    for (const ws of espectadores) enviarRaw(ws, raw);
  }
  /** Chat de una sala: solo a los espectadores que la están mirando */
  function difundirSala(codigo, payload) {
    let raw = null;
    for (const ws of espectadores) if (ws.sala === codigo) enviarRaw(ws, raw || (raw = JSON.stringify(payload)));
  }
  /** Cambió una sala de parqués en este coordinador (jugada, réplica o cierre) */
  let listaPendiente = null;
  function alCambiarSala(sala) {
    if (!sala) return;
    const cerrada = sala.estado === 'cerrada';
    for (const ws of espectadores) {
      if (ws.sala === sala.codigo) {
        enviar(ws, { type: 'sala_estado', sala: cerrada ? null : sala, codigo: sala.codigo, jugadas: [], espectador: true });
        if (cerrada) ws.sala = null;
      }
    }
    if (!listaPendiente && espectadores.size) listaPendiente = setTimeout(() => { listaPendiente = null; difundir(salasPublicas()); }, 500);
  }

  const latido = setInterval(() => {                       // espectadores con la pestaña congelada o sin red
    for (const ws of espectadores) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ok */ }
    }
  }, 30000);
  latido.unref();

  return { handleUpgrade, tick, difundir, difundirSala, alCambiarSala, cuantos: () => espectadores.size, max: MAX, stats, permitidos: PERMITIDOS };
}

module.exports = { crearEspectadores };
