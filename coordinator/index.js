const path = require('path');
// Cada computador ejecuta UN coordinador con el MISMO código y un .env con la misma forma.
//   npm run start:a  →  node index.js coord-a      (el nombre sale del comando: distinto en cada PC)
//   npm start -- mi-nombre  →  cualquier nombre (único en el mesh, sin importar mayúsculas)
// En el .env: COORD_PORT (puerto local) y COORD_PUBLIC_URL (la URL de ngrok de ESE computador).
// Por esa misma URL entran los jugadores (/connect) y los otros coordinadores (/peer).
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const express = require('express');
const http    = require('http');
const jwt     = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');

// ───────── 1. Configuración ─────────
const COORDINATOR_ID = (process.argv[2] || process.env.COORDINATOR_ID || '').trim();   // único en el mesh: coord-a, coord-b...
const PORT           = parseInt(process.env.COORD_PORT, 10) || 5000;    // puerto local (jugadores y mesh)
const PUBLIC_URL     = (process.env.COORD_PUBLIC_URL || `ws://localhost:${PORT}`).replace(/\/$/, '');  // URL pública (ngrok)
const PEER_URL       = `${PUBLIC_URL}/peer`;                            // el mesh usa la MISMA URL, ruta /peer
const MESH_SECRET    = process.env.MESH_SECRET || '';                   // opcional: clave compartida del mesh
const DIRECTORY_HEARTBEAT_MS = parseInt(process.env.DIRECTORY_HEARTBEAT_MS, 10) || 2000;   // POST /heartbeat
const PEER_POLL_MS   = parseInt(process.env.PEER_POLL_MS, 10) || 2000;                     // GET /peers
const PEER_PING_MS   = parseInt(process.env.PEER_PING_MS, 10) || 5000;                     // detecta peers congelados
const SYNC_MS        = parseInt(process.env.SYNC_MS, 10) || 1000;                          // corrección de posiciones
const JWT_SECRET     = process.env.JWT_SECRET;          // la MISMA que usa auth-service
const HEARTBEAT_MS   = parseInt(process.env.HEARTBEAT_MS, 10) || 30000;    // ping/pong cada 30 s
const AUTH_URL       = (process.env.AUTH_URL || '').replace(/\/$/, '');     // para la duración en vivo
const POLICY_POLL_MS = parseInt(process.env.POLICY_POLL_MS, 10) || 3000;
const STARTED_AT     = Date.now();

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET falta o tiene menos de 32 caracteres (debe ser la misma de auth-service)');
  process.exit(1);
}
if (!/^[\w.-]{1,64}$/.test(COORDINATOR_ID)) {
  console.error('Falta el nombre del coordinador: npm run start:a, o npm start -- mi-nombre (letras, números, . _ -; máx. 64)');
  process.exit(1);
}
if (!AUTH_URL) {
  console.error('AUTH_URL falta en el .env: el auth-service es también el directorio (heartbeat, /peers)');
  process.exit(1);
}
if (!/^wss?:\/\//i.test(PUBLIC_URL)) {
  console.error('COORD_PUBLIC_URL debe empezar con ws:// o wss:// (con ngrok: wss://xxxx.ngrok-free.dev)');
  process.exit(1);
}

// Reglas del juego (el servidor es la autoridad: estas reglas solo viven aquí)
const WORLD_WIDTH   = 960;
const WORLD_HEIGHT  = 600;
const PLAYER_RADIUS = 18;
const PLAYER_SPEED  = 200;              // píxeles por segundo
const TICK_RATE     = 20;               // actualizaciones por segundo (Hz)
const TICK_MS       = 1000 / TICK_RATE;

// Característica extra: color del jugador. Solo se aceptan colores de esta paleta,
// así nadie puede mandar texto arbitrario que luego se dibuje en otros navegadores.
const ALLOWED_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#6d4c41'];
const EXTRAS_MAX_CHARS = 1024;          // límite anti-abuso del PDF

// Códigos de cierre propios (el rango 4000-4999 está reservado para aplicaciones)
const CLOSE_INVALID_TOKEN = 4001;   // token vencido, malformado o con otra firma
const CLOSE_ELSEWHERE     = 4002;   // el mismo usuario abrió otra pestaña
const CLOSE_BAD_PATH      = 4004;   // se conectó a una ruta distinta de /connect
const CLOSE_PEER_REJECTED = 4010;   // mesh: hello inválido, secreto incorrecto o conexión duplicada

// Mensajes que el cliente puede enviar (se listan en el welcome y en los errores)
const CLIENT_MESSAGES = {
  intent:        '{"type":"intent","intent":{"dir":{"x":1,"y":0}}} → hacia dónde te quieres mover (-1, 0 o 1)',
  extras_update: '{"type":"extras_update","extras":{"color":"#e53935"}} → cambia tu color',
  ping:          '{"type":"ping"} → responde pong (prueba de conexión)',
  get_players:   '{"type":"get_players"} → te envía la lista de jugadores en línea',
  logout:        '{"type":"logout"} → cierra tu sesión en el coordinador',
  reauth:        '{"type":"reauth","token":"..."} → vuelve a validar tu sesión con otro token',
};

// ───────── 2. Estado en memoria ─────────
// ESTADO DEL MUNDO, igual en todos los coordinadores (Taller 6).
// userId → { username, provider, origin, socket, connectedAt, x, y, intent: {x, y}, extras: {} }
//   origin = coordinatorId al que está conectado el jugador (puede ser otro coordinador)
//   socket = WebSocket del jugador SOLO si es local; en los jugadores remotos es null
const players = new Map();
const isLocal = (p) => p.socket !== null;
// Jugadores remotos cuyo coordinador murió: se quitan del mundo, pero se recuerda dónde estaban
// (userId → { x, y, extras, until }) para que, al reconectarse a otro coordinador, sigan ahí.
const ORPHAN_TTL_MS = 60000;
// Si se cae un coordinador, sus jugadores NO desaparecen de inmediato: quedan quietos en su sitio
// (con su color) mientras se reconectan a otro coordinador. Si no vuelven en este tiempo, se quitan.
const GHOST_MS = parseInt(process.env.GHOST_MS, 10) || 8000;
const orphans = new Map();
const localCount = () => { let n = 0; for (const p of players.values()) if (isLocal(p)) n++; return n; };

// Duración de sesión vigente según el auth (null = todavía no se conoce).
// clockOffsetMs = cuánto va adelantado (+) o atrasado (-) el reloj del auth respecto a este
// equipo. Los tokens traen iat/exp escritos con el reloj del auth, así que se comparan con él.
const policy = { seconds: null, label: null, reachable: null, clockOffsetMs: 0 };

// "Ahora" según el reloj del auth (en ms)
function authNow() {
  return Date.now() + policy.clockOffsetMs;
}

// Milisegundos que le quedan a una sesión que vence en "exp" (segundos, reloj del auth).
// Se envía al navegador como tiempo RESTANTE, para que no dependa del reloj de ese equipo.
function remainingMs(exp) {
  return Math.max(0, Math.round(exp * 1000 - authNow()));
}

// ───────── 3. Envío de mensajes ─────────
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// Todos los errores tienen la misma forma: { type: 'error', code, message, hint }
function sendError(ws, code, message, hint) {
  send(ws, { type: 'error', code, message, hint });
}

// Avisa el motivo con un mensaje y luego cierra (wscat muestra ambos)
function closeWith(ws, closeCode, reason, code, message, hint) {
  sendError(ws, code, message, hint);
  ws.close(closeCode, reason);
}

// Envía el mismo mensaje a los clientes de ESTE coordinador (los remotos lo reciben de su coordinador)
function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const { socket } of players.values()) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(raw);
  }
}

function playersList() {
  return Array.from(players.entries()).map(([userId, p]) => ({ userId, username: p.username, coordinator: p.origin }));
}

// Lista de jugadores (del Taller 4): se envía cuando alguien entra, sale o se reconecta.
function broadcastPlayers(action, username) {
  const list = playersList();
  const texto = { joined: 'entró al juego', left: 'salió del juego', reconnected: 'se reconectó (otra pestaña o cambio de coordinador)' }[action];
  broadcast({
    type: 'players_update',
    players: list,
    event: { action, username },
    message: `${username} ${texto} (${list.length} en línea)`,
  });
  console.log(`[broadcast] ${username} ${action} → ${list.length} en línea: ${list.map(p => p.username).join(', ') || '(nadie)'}`);
}

// Foto del estado del juego que se envía en cada tick. No incluye el socket (es interno).
// "badge" (insignia) sale del provider del JWT: el cliente no puede falsificarla.
function snapshot() {
  return Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
    extras: p.extras,
    badge: p.provider,
    coordinator: p.origin,            // a qué coordinador está conectado cada jugador (para la UI)
  }));
}

// ───────── 4. Verificación del token ─────────
// Momento en que vence la sesión: el "exp" del token o, si el auth acortó la duración
// después de emitirlo, iat + duración vigente (lo que ocurra primero).
function effectiveExp(payload) {
  if (!policy.seconds || !payload.iat) return payload.exp;
  return Math.min(payload.exp, payload.iat + policy.seconds);
}

// Devuelve { payload } si es válido, o { code, message, hint } explicando qué falló.
function verifyToken(token) {
  if (!token) {
    return { code: 'missing_token', message: 'No enviaste token',
      hint: 'Conéctate a /connect?token=TU_TOKEN (el token sale de POST /login o POST /auth/google)' };
  }
  try {
    // valida firma y exp; el vencimiento se mide con el reloj del auth (clockTimestamp)
    const payload = jwt.verify(token, JWT_SECRET, { clockTimestamp: Math.floor(authNow() / 1000) });
    if (!payload.userId || !payload.username) {
      return { code: 'invalid_token', message: 'El token no trae userId y username',
        hint: 'Usa un token emitido por el auth-service' };
    }
    if (effectiveExp(payload) * 1000 <= authNow()) {        // la duración se acortó en vivo
      return { code: 'token_expired', message: `El token venció (la sesión ahora dura ${policy.label})`,
        hint: 'Inicia sesión de nuevo para obtener un token nuevo' };
    }
    return { payload };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return { code: 'token_expired', message: `El token venció (${err.expiredAt.toISOString()})`,
        hint: 'Inicia sesión de nuevo para obtener un token nuevo' };
    }
    if (err.message === 'invalid signature') {
      return { code: 'invalid_signature', message: 'La firma del token no es válida',
        hint: 'El token fue modificado o lo firmó otra clave. Inicia sesión de nuevo' };
    }
    return { code: 'malformed_token', message: `El token está mal formado (${err.message})`,
      hint: 'Copia el token completo que devuelve el auth, sin comillas ni espacios' };
  }
}

// ───────── 5. Expiración de la sesión (también en vivo) ─────────
// Cada socket recuerda iat/exp de su token. scheduleExpiry programa el cierre para el
// momento en que vence; se vuelve a llamar si llega un token nuevo o cambia la duración.
function scheduleExpiry(ws) {
  clearTimeout(ws.expiryTimer);
  const exp = effectiveExp({ iat: ws.tokenIat, exp: ws.tokenExp });
  ws.expiryTimer = setTimeout(() => {
    console.log(`[expirado] token de ${ws.username}`);
    closeWith(ws, CLOSE_INVALID_TOKEN, 'token expired', 'token_expired',
      'Tu sesión venció', 'Inicia sesión de nuevo');
  }, remainingMs(exp));
  return exp;
}

// Avisa a un jugador cuánto le queda de sesión. refresh = true le pide renovar su token
// (cuando la duración aumentó y su token se emitió con una duración menor).
function sendSessionUpdate(ws, message, refresh = false) {
  const exp = scheduleExpiry(ws);
  send(ws, { type: 'session_update', expiresAt: new Date(exp * 1000).toISOString(),
    expiresInMs: remainingMs(exp), refresh, message });
}

// Opción B: el coordinador pregunta al auth la duración vigente. Si cambió, la aplica a
// los jugadores conectados (los que ya superaron la duración nueva salen enseguida).
async function pollSessionPolicy() {
  try {
    const t0   = Date.now();
    const res  = await fetch(`${AUTH_URL}/session-policy`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
    const data = await res.json();
    const t1   = Date.now();
    if (policy.reachable === false) console.log(`[sesión] ${AUTH_URL} responde de nuevo`);
    policy.reachable = true;

    // Diferencia de reloj: la hora del auth comparada con la mitad del viaje de ida y vuelta
    let clockChanged = false;
    if (Number.isFinite(data.serverTime)) {
      const offset = Math.round(data.serverTime - (t0 + t1) / 2);
      if (Math.abs(offset - policy.clockOffsetMs) > 500) {
        policy.clockOffsetMs = offset;
        clockChanged = true;
        console.log(`[reloj] El reloj del auth va ${Math.abs(offset / 1000).toFixed(1)} s ` +
          `${offset >= 0 ? 'adelantado' : 'atrasado'} respecto a este equipo: se compensa`);
      }
    }

    const changed = Number.isFinite(data.seconds) && data.seconds > 0 && data.seconds !== policy.seconds;
    const before  = policy.seconds;
    if (changed) {
      policy.seconds = data.seconds;
      const beforeLabel = policy.label;
      policy.label = data.expiresIn;
      console.log(`[sesión] Duración de sesión ${beforeLabel ? `${beforeLabel} → ` : ''}${policy.label}` +
        (before ? ': se aplica a los jugadores conectados' : ''));
    }
    if (!(before && changed) && !clockChanged) return;

    for (const { socket } of players.values()) {
      if (!socket) continue;                 // jugador remoto: su coordinador es quien le avisa
      if (before && changed) {
        // Si la duración aumentó y este token es más corto, se le pide al cliente renovarlo
        const refresh = policy.seconds > before && (socket.tokenExp - socket.tokenIat) < policy.seconds;
        sendSessionUpdate(socket, `La duración de la sesión cambió a ${policy.label}`, refresh);
      } else {
        sendSessionUpdate(socket, null);      // solo se corrigió el reloj
      }
    }
  } catch (err) {
    // Solo se avisa una vez; se sigue reintentando cada POLICY_POLL_MS
    if (policy.reachable !== false) {
      console.log(`[sesión] No se pudo consultar ${AUTH_URL}/session-policy (${err.message}). Se reintentará`);
    }
    policy.reachable = false;
  }
}

// ───────── 6. Alta y baja de jugadores ─────────

// Un jugador se conecta a ESTE coordinador. Si ya tenía otra conexión (otra pestaña aquí, o
// una copia remota que llegó por el mesh) conserva su posición y su color. El aviso a los
// demás coordinadores (player_joined) hace que el que tuviera su socket anterior lo cierre.
function addPlayer(userId, payload, ws) {
  let previous = players.get(userId);
  const orphan = orphans.get(userId);
  orphans.delete(userId);
  if (!previous && orphan && orphan.until > Date.now()) {
    previous = { x: orphan.x, y: orphan.y, extras: orphan.extras, socket: null, origin: null };   // sigue donde estaba
    console.log(`[+] ${payload.username} conserva su posición de antes de la caída`);
  }
  if (previous && previous.socket) {
    console.log(`[duplicado] ${payload.username} abrió otra pestaña: se cierra la conexión anterior`);
    closeWith(previous.socket, CLOSE_ELSEWHERE, 'session opened elsewhere', 'session_opened_elsewhere',
      'Abriste esta cuenta en otra pestaña o navegador; esta conexión se cerró',
      'Sigue en la pestaña nueva, o vuelve a iniciar sesión aquí (eso cerrará la otra)');
  }
  const entry = {
    username:    payload.username,
    provider:    payload.provider === 'google' ? 'google' : 'local',
    origin:      COORDINATOR_ID,
    socket:      ws,
    seq:         ws.connSeq || 0,
    connectedAt: new Date().toISOString(),
    x: previous ? previous.x : PLAYER_RADIUS + Math.random() * (WORLD_WIDTH  - 2 * PLAYER_RADIUS),
    y: previous ? previous.y : PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS),
    intent: { x: 0, y: 0 },
    extras: previous ? previous.extras : {},
  };
  players.set(userId, entry);
  console.log(`[+] ${payload.username} conectado aquí (${entry.provider})${previous && !previous.socket ? ` (venía de ${previous.origin})` : ''}`);
  broadcastPlayers(previous && previous.origin ? 'reconnected' : 'joined', payload.username);
  replicate({ type: 'player_joined', userId, username: entry.username, provider: entry.provider,
    x: entry.x, y: entry.y, extras: entry.extras, intent: entry.intent, seq: entry.seq });
}

// Quita al jugador del Map y avisa a todos. Solo si este socket sigue siendo el activo:
// cuando se cierra la pestaña vieja (reemplazada), NO debe borrar la conexión nueva.
function removePlayer(userId, username, ws) {
  if (players.get(userId)?.socket !== ws) return;
  players.delete(userId);                 // primero se elimina del Map...
  console.log(`[-] ${username} desconectado`);
  broadcastPlayers('left', username);     // ...y luego se avisa a los clientes locales
  replicate({ type: 'player_left', userId });   // ...y a los demás coordinadores
}

// ───────── 7. Validación de los mensajes del juego ─────────

// intent: solo guarda HACIA DÓNDE quiere ir el jugador. No lo mueve ni hace broadcast:
// eso lo hace el game loop. Math.sign deja cada eje en -1, 0 o 1 (así {x: 9999} no teletransporta).
function handleIntent(ws, p, msg) {
  const dir = msg.intent && msg.intent.dir;
  if (!dir || !Number.isFinite(dir.x) || !Number.isFinite(dir.y)) {
    return sendError(ws, 'invalid_intent', 'La dirección no es válida',
      'Envía {"type":"intent","intent":{"dir":{"x":1,"y":0}}} con números');
  }
  if (p.frozenUntil > Date.now()) return;  // se está cambiando de coordinador: quieto hasta que llegue al nuevo
  p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };
  // El game loop de los demás coordinadores aplica esta misma intención a su copia del jugador
  replicate({ type: 'intent_replicate', userId: ws.userId, intent: { dir: p.intent } });
}

// extras_update: un objeto (no arreglo) de máximo 1024 caracteres. De él solo se acepta
// "color", y únicamente si está en la paleta permitida.
function handleExtras(ws, p, msg) {
  const extras = msg.extras;
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) {
    return sendError(ws, 'invalid_extras', 'extras debe ser un objeto', 'Ejemplo: {"type":"extras_update","extras":{"color":"#e53935"}}');
  }
  if (JSON.stringify(extras).length > EXTRAS_MAX_CHARS) {
    return sendError(ws, 'extras_too_large', `extras supera ${EXTRAS_MAX_CHARS} caracteres`, 'Envía solo el color');
  }
  const color = typeof extras.color === 'string' ? extras.color.toLowerCase() : null;
  if (!ALLOWED_COLORS.includes(color)) {
    return sendError(ws, 'invalid_color', 'Ese color no está permitido', `Colores permitidos: ${ALLOWED_COLORS.join(', ')}`);
  }
  p.extras = { ...p.extras, color };       // se guarda; el próximo state lo replica a todos
  console.log(`[extras] ${p.username} cambió su color a ${color}`);
  replicate({ type: 'extras_replicate', userId: ws.userId, extras: p.extras });
  send(ws, { type: 'extras_ok', extras: p.extras, message: 'Color actualizado' });
}

// ───────── 8. Servidor HTTP + WebSocket ─────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });   // nosotros manejamos el upgrade

app.get('/', (_req, res) => res.json({
  service: 'coordinator',
  message: 'Coordinador del juego en línea',
  websocket: 'ws://HOST/connect?token=TU_TOKEN (wss:// si es por ngrok)',
  world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: PLAYER_RADIUS, tickRate: TICK_RATE },
  clientMessages: CLIENT_MESSAGES,
  http: { 'GET /health': 'Estado del servicio', 'GET /players': 'Jugadores del mundo (locales y remotos)', 'GET /mesh': 'Estado del mesh' },
}));
app.get('/health',  (_req, res) => res.json({ status: 'ok', message: 'coordinator funcionando', coordinatorId: COORDINATOR_ID,
  connectedPlayers: localCount(), worldPlayers: players.size, peers: [...peers.keys()],
  sessionPolicy: policy.label || 'sin consultar' }));
app.get('/players', (_req, res) => res.json({ coordinatorId: COORDINATOR_ID, players: playersList(),
  message: `${players.size} jugador(es) en el mundo, ${localCount()} conectados aquí` }));
app.get('/mesh', (_req, res) => res.json({
  coordinatorId: COORDINATOR_ID, publicUrl: PUBLIC_URL, peerUrl: PEER_URL,
  connected: [...peers.entries()].map(([id, r]) => ({ coordinatorId: id, role: r.outbound ? 'initiator' : 'acceptor' })),
  knownInDirectory: [...knownPeers.keys()],
}));
app.use((req, res) => res.status(404).json({
  error: 'not_found', message: `No existe ${req.method} ${req.path}`,
  hint: 'Rutas HTTP: GET /, GET /health, GET /players, GET /mesh. WebSocket: /connect?token=...',
}));

// El token se valida en el UPGRADE, antes de que el socket entre a 'connection'.
server.on('upgrade', (req, socket, head) => {
  const url    = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/peer') {                     // otro coordinador (mesh): misma URL, otra ruta
    return peerWss.handleUpgrade(req, socket, head, (ws) => setupPeerSocket(ws, false));
  }
  const result = url.pathname === '/connect' ? verifyToken(url.searchParams.get('token')) : null;

  // Se completa el handshake solo para poder explicar el error y cerrar con un código propio.
  // Con un HTTP 401/404, el navegador y wscat solo verían un error genérico sin explicación.
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!result) {
      return closeWith(ws, CLOSE_BAD_PATH, 'bad path', 'bad_path',
        `La ruta ${url.pathname} no existe`, 'Conéctate a /connect?token=TU_TOKEN');
    }
    if (!result.payload) {
      // Token malo: el socket NUNCA llega a 'connection' ni al Map
      console.log(`[rechazado] ${result.code}: ${result.message}`);
      return closeWith(ws, CLOSE_INVALID_TOKEN, 'invalid token', result.code, result.message, result.hint);
    }
    // seq = momento en que el navegador abrió ESTA conexión: si la misma cuenta queda conectada en
    // dos coordinadores a la vez (carrera al cambiarse), gana siempre la más nueva
    ws.connSeq = Number(url.searchParams.get('seq')) || 0;
    wss.emit('connection', ws, result.payload);
  });
});

// ───────── 9. Cada conexión de jugador ─────────
wss.on('connection', (ws, payload) => {
  const userId   = String(payload.userId);
  const username = payload.username;
  ws.username = username;
  ws.userId   = userId;
  ws.tokenIat = payload.iat;
  ws.tokenExp = payload.exp;

  addPlayer(userId, payload, ws);
  sendHeartbeat();                       // avisa ya al directorio: su carga cambió (no espera 2 s)
  const exp = scheduleExpiry(ws);

  // Bienvenida: identidad + dimensiones del mundo (el cliente arma el canvas con esto)
  send(ws, {
    type: 'welcome',
    message: `Conectado al juego como ${username} (coordinador ${COORDINATOR_ID})`,
    coordinatorId: COORDINATOR_ID,
    you: { userId, username, provider: players.get(userId).provider },
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: PLAYER_RADIUS, tickRate: TICK_RATE },
    colors: ALLOWED_COLORS,
    tokenExpiresAt: new Date(exp * 1000).toISOString(),
    expiresInMs: remainingMs(exp),
    clientMessages: CLIENT_MESSAGES,
  });

  // Heartbeat: marcamos vivo al conectar y cada vez que responde un pong
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // El cliente reenvía su token si cambia en el navegador (p. ej., lo editan en DevTools).
  // Se valida igual que en el upgrade: si es inválido se cierra con 4001, sin recargar.
  function reauth(newToken) {
    const result = verifyToken(newToken);
    if (!result.payload) {
      console.log(`[reauth rechazado] ${username}: ${result.code}`);
      return closeWith(ws, CLOSE_INVALID_TOKEN, 'invalid token', result.code, result.message, result.hint);
    }
    if (String(result.payload.userId) !== userId) {
      console.log(`[reauth rechazado] ${username}: el token es de otro usuario`);
      return closeWith(ws, CLOSE_INVALID_TOKEN, 'invalid token', 'token_user_mismatch',
        'El token nuevo pertenece a otro usuario', 'Cierra sesión e inicia sesión con la cuenta que quieres usar');
    }
    ws.tokenIat = result.payload.iat;
    ws.tokenExp = result.payload.exp;
    const newExp = scheduleExpiry(ws);
    console.log(`[reauth] ${username}: token nuevo válido`);
    send(ws, { type: 'reauth_ok', message: 'Token verificado: tu sesión sigue activa',
      tokenExpiresAt: new Date(newExp * 1000).toISOString(), expiresInMs: remainingMs(newExp) });
  }

  // Mensajes del cliente. Los errores siempre se responden; un intent válido no tiene
  // respuesta propia: su confirmación es el siguiente "state".
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return sendError(ws, 'invalid_json', 'El mensaje no es un JSON válido', 'Envía un objeto como {"type":"ping"}');
    }
    if (!msg || typeof msg.type !== 'string') {
      return sendError(ws, 'missing_type', 'El mensaje no tiene el campo "type"',
        `Tipos disponibles: ${Object.keys(CLIENT_MESSAGES).join(', ')}`);
    }

    const p = players.get(userId);
    if (!p || p.socket !== ws) return;        // conexión ya reemplazada o cerrándose

    switch (msg.type) {
      case 'intent':
        return handleIntent(ws, p, msg);
      case 'extras_update':
        return handleExtras(ws, p, msg);
      case 'ping':
        return send(ws, { type: 'pong', message: 'Conexión activa', serverTime: new Date().toISOString() });
      case 'get_players':
        return send(ws, { type: 'players_update', players: playersList(), message: `${players.size} jugador(es) en línea` });
      case 'logout':
        send(ws, { type: 'logout_ok', message: `Sesión de ${username} cerrada. ¡Hasta pronto!` });
        return ws.close(1000, 'logout');
      case 'rebalance_cancel':                          // el auth le dijo quedarse aquí: puede volver a moverse
        p.frozenUntil = 0;
        return;
      case 'reauth':
        return reauth(typeof msg.token === 'string' ? msg.token : '');
      default:
        return sendError(ws, 'unknown_type', `No existe el tipo de mensaje "${msg.type}"`,
          `Tipos disponibles: ${Object.keys(CLIENT_MESSAGES).join(', ')}`);
    }
  });

  ws.on('close', () => {
    clearTimeout(ws.expiryTimer);
    removePlayer(userId, username, ws);
    sendHeartbeat();                     // carga actualizada en el directorio de inmediato
  });

  ws.on('error', (err) => console.error(`[ws] error de ${username}: ${err.message}`));
});

// ───────── 10. Game loop: el servidor mueve a los jugadores ─────────
// 20 veces por segundo: aplica las intenciones de TODOS los jugadores (locales y remotos), respeta
// los límites y envía el estado SOLO a sus clientes locales (nunca a los peers).
let lastTick = Date.now();

function tick() {
  const now = Date.now();
  const dt  = (now - lastTick) / 1000;   // segundos desde el tick anterior
  lastTick  = now;

  for (const p of players.values()) {
    // Normalizar diagonales: sin esto, en diagonal se avanza ~41 % más rápido
    const ix  = p.intent.x;
    const iy  = p.intent.y;
    const mag = Math.hypot(ix, iy);
    if (mag > 0) {
      p.x += (ix / mag) * PLAYER_SPEED * dt;
      p.y += (iy / mag) * PLAYER_SPEED * dt;
    }
    // Mantener dentro del mundo
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH  - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
  }

  if (localCount()) broadcast({ type: 'state', t: now, coordinatorId: COORDINATOR_ID, players: snapshot() });
}

setInterval(tick, TICK_MS);

// ───────── 11. Heartbeat: detecta conexiones muertas ─────────
// Cada HEARTBEAT_MS se envía un ping de protocolo a cada socket. Si no respondió el
// ping anterior (pestaña congelada, red caída sin "close"), se termina la conexión;
// eso dispara 'close' → removePlayer → broadcast.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      console.log('[heartbeat] conexión sin respuesta: se termina');
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// ───────── 11b. Mesh de coordinadores (Taller 6) ─────────
// Cada par de coordinadores comparte UNA sola conexión WS. Quien tiene el coordinatorId "menor"
// (orden lexicográfico) la inicia; el otro la espera en su ruta /peer. Todos los mensajes llevan
// "origin" y NUNCA se retransmiten: cada coordinador manda directo a todos los demás.
const peers = new Map();          // peerId → { ws, outbound }   (solo peers que ya hicieron hello)
const connecting = new Set();     // peerId con una conexión saliente en curso
const missed = new Map();         // peerId → veces seguidas que /peers ya no lo lista
let knownPeers = new Map();       // peerId → peerUrl, según el último GET /peers
const peerLogged = new Set();     // para no repetir el mismo error de conexión cada 2 s

// Envía un mensaje (con origin) a todos los peers ya registrados
function replicate(payload) {
  if (!peers.size) return;
  const raw = JSON.stringify({ ...payload, origin: COORDINATOR_ID });
  for (const { ws } of peers.values()) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
}

// Valida lo que llega de otro coordinador: no se confía en nadie, ni en el mesh
function cleanDir(d) {
  return d && Number.isFinite(d.x) && Number.isFinite(d.y) ? { x: Math.sign(d.x), y: Math.sign(d.y) } : { x: 0, y: 0 };
}
function cleanExtras(e) {
  const color = e && typeof e.color === 'string' ? e.color.toLowerCase() : null;
  return ALLOWED_COLORS.includes(color) ? { color } : {};
}
const clampX = (v) => Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH  - PLAYER_RADIUS, v));
const clampY = (v) => Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, v));

// Quita del mundo a los jugadores remotos que pertenecían a ese coordinador
function removeRemotePlayersOf(peerId, announce = true) {
  for (const [userId, p] of players) {
    if (p.origin === peerId && !p.socket) {
      // Se queda visible y quieto ("fantasma") hasta que se reconecte en algún coordinador. Si su
      // coordinador solo se reconectó al mesh (announce = false), su foto lo refresca enseguida.
      p.intent = { x: 0, y: 0 };
      p.ghostUntil = Date.now() + GHOST_MS;
      p.ghostAnnounce = announce;
    }
  }
}

// Fantasmas que no volvieron a tiempo: ahora sí se quitan del mundo y se avisa
setInterval(() => {
  const now = Date.now();
  for (const [userId, p] of players) {
    if (p.socket || !(p.ghostUntil <= now)) continue;
    players.delete(userId);
    orphans.set(userId, { x: p.x, y: p.y, extras: p.extras, until: now + ORPHAN_TTL_MS });
    if (p.ghostAnnounce) { console.log(`[mesh] - ${p.username} (su coordinador ${p.origin} no volvió)`); broadcastPlayers('left', p.username); }
  }
}, 500).unref();

// Al registrar un peer (o reconectarlo) se envía la foto de MIS jugadores locales:
// así un coordinador que entra tarde (o se reconecta) queda con el mismo estado.
function sendLocalSnapshot(ws) {
  for (const [userId, p] of players) {
    if (!p.socket) continue;
    send(ws, { type: 'player_joined', origin: COORDINATOR_ID, sync: true, userId, username: p.username,
      provider: p.provider, x: p.x, y: p.y, extras: p.extras, intent: p.intent, seq: p.seq || 0 });
  }
}

function handleHello(ws, msg) {
  const id = msg.coordinatorId;
  const reject = (why) => {
    console.log(`[mesh] hello rechazado (${why})`);
    ws.duplicate = true;
    ws.close(CLOSE_PEER_REJECTED, why);
  };
  if (typeof id !== 'string' || !/^[\w.-]{1,64}$/.test(id)) return reject('coordinatorId inválido');
  if (id.toLowerCase() === COORDINATOR_ID.toLowerCase()) return reject(`otro coordinador usa mi mismo nombre (${id})`);
  if (MESH_SECRET && msg.secret !== MESH_SECRET) return reject('secreto del mesh incorrecto');

  // Una sola conexión por par. La válida es la que inicia el coordinador de id menor.
  const existing = peers.get(id);
  if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
    const validaEsSaliente = COORDINATOR_ID < id;       // si mi id es menor, la válida es la que yo inicié
    if (ws.outbound !== validaEsSaliente) {             // esta es la duplicada: se cierra la NUEVA
      console.log(`[mesh] conexión duplicada con ${id}: se cierra la nueva`);
      ws.duplicate = true;
      return ws.close(CLOSE_PEER_REJECTED, 'duplicate connection');
    }
    console.log(`[mesh] ${id} se reconectó: se reemplaza la conexión anterior`);
    existing.ws.duplicate = true;                       // ya no la representa: su close no borra nada
    existing.ws.close(CLOSE_PEER_REJECTED, 'replaced');
  }

  ws.peerId = id;
  peers.set(id, { ws, outbound: ws.outbound });
  peerLogged.delete(id);
  removeRemotePlayersOf(id, false);                     // descarta fantasmas de una conexión anterior
  console.log(`[mesh] ✔ conectado con ${id} (${ws.outbound ? 'yo inicié' : 'él inició'}). Peers: ${[...peers.keys()].join(', ')}`);
  sendLocalSnapshot(ws);
}

function handlePeerMessage(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.origin === COORDINATOR_ID) return;            // anti-bucle: un mensaje mío que volvió
  if (msg.origin !== ws.peerId) {                       // solo el dueño de la conexión puede hablar por sí mismo
    return console.log(`[mesh] descartado: origin "${msg.origin}" no coincide con ${ws.peerId}`);
  }
  const origin = msg.origin;
  const userId = msg.userId !== undefined ? String(msg.userId) : null;
  const p = userId ? players.get(userId) : null;

  switch (msg.type) {
    case 'intent_replicate':                            // se aplica a MI copia; solo el dueño la maneja
      if (p && p.origin === origin) { p.intent = cleanDir(msg.intent && msg.intent.dir); p.ghostUntil = undefined; }
      return;
    case 'extras_replicate':
      if (p && p.origin === origin) p.extras = { ...p.extras, ...cleanExtras(msg.extras) };
      return;
    case 'player_joined': {
      if (!userId || typeof msg.username !== 'string' || !msg.username || msg.username.length > 64) return;
      if (p && p.socket && (p.seq || 0) > (Number(msg.seq) || 0)) {
        return;                                         // mi conexión es MÁS NUEVA que la de allá: me quedo con ella
      }
      if (p && p.socket) {                              // el jugador abrió sesión en OTRO coordinador
        console.log(`[duplicado] ${p.username} se conectó a ${origin}: se cierra su conexión aquí`);
        const old = p.socket;
        p.socket = null;                                // ya no es local: su close no avisa "left"
        closeWith(old, CLOSE_ELSEWHERE, 'session opened elsewhere', 'session_opened_elsewhere',
          'Abriste esta cuenta en otra pestaña o navegador; esta conexión se cerró',
          'Sigue en la pestaña nueva, o vuelve a iniciar sesión aquí (eso cerrará la otra)');
      }
      const prev = players.get(userId);
      orphans.delete(userId);
      players.set(userId, {
        username: msg.username, provider: msg.provider === 'google' ? 'google' : 'local',
        origin, socket: null, connectedAt: new Date().toISOString(),
        x: clampX(Number.isFinite(msg.x) ? msg.x : (prev ? prev.x : WORLD_WIDTH / 2)),
        y: clampY(Number.isFinite(msg.y) ? msg.y : (prev ? prev.y : WORLD_HEIGHT / 2)),
        intent: cleanDir(msg.intent && msg.intent.dir),
        extras: cleanExtras(msg.extras),
        seq: Number(msg.seq) || 0,
      });
      if (!msg.sync) {                                  // sync = foto inicial del mesh, no es una entrada nueva
        console.log(`[mesh] + ${msg.username} (en ${origin})`);
        broadcastPlayers(prev ? 'reconnected' : 'joined', msg.username);
      }
      return;
    }
    case 'player_left':                                 // solo si sigue siendo de ese coordinador
      if (p && p.origin === origin && !p.socket) {
        players.delete(userId);
        console.log(`[mesh] - ${p.username} (salió de ${origin})`);
        broadcastPlayers('left', p.username);
      }
      return;
    case 'positions_sync':                              // corrección periódica: el dueño manda la posición real
      if (!Array.isArray(msg.players)) return;
      for (const s of msg.players) {
        if (!s || s.userId === undefined || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
        const id = String(s.userId);
        let q = players.get(id);
        if (!q && typeof s.username === 'string' && s.username && s.username.length <= 64) {
          // No tenía copia (llegó tarde al mesh, o se perdió): se crea con lo que manda su dueño
          q = { username: s.username, provider: s.provider === 'google' ? 'google' : 'local', origin,
                socket: null, connectedAt: new Date().toISOString(), x: 0, y: 0, intent: { x: 0, y: 0 }, extras: {} };
          players.set(id, q);
          orphans.delete(id);
        }
        if (q && q.origin === origin && !q.socket) {
          q.x = clampX(s.x); q.y = clampY(s.y); q.intent = cleanDir(s.intent);
          q.ghostUntil = undefined;                                // su dueño sigue vivo
          if (s.extras) q.extras = cleanExtras(s.extras);          // el color también viaja
        }
      }
      return;
    default:
      return;
  }
}

// Lo común de una conexión de mesh, entrante o saliente
function setupPeerSocket(ws, outbound) {
  ws.outbound = outbound;
  ws.peerId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const hello = () => send(ws, { type: 'hello', coordinatorId: COORDINATOR_ID, ...(MESH_SECRET ? { secret: MESH_SECRET } : {}) });
  if (outbound) ws.on('open', hello); else hello();

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!ws.peerId) {                                   // el primer mensaje DEBE ser hello
      if (ws.duplicate) return;
      if (msg && msg.type === 'hello') return handleHello(ws, msg);
      ws.duplicate = true;
      return ws.close(CLOSE_PEER_REJECTED, 'hello expected');
    }
    handlePeerMessage(ws, msg);
  });

  ws.on('close', (code, reason) => {
    if (ws.peerId && peers.get(ws.peerId)?.ws === ws) {
      peers.delete(ws.peerId);
      removeRemotePlayersOf(ws.peerId);                 // sus jugadores ya no los puedo ver
      const motivo = `${code}${reason && reason.length ? ` ${reason}` : ''}`;   // ej: 1000 left directory
      console.log(`[mesh] ✘ se perdió ${ws.peerId} (cierre ${motivo}). Peers: ${[...peers.keys()].join(', ') || '(ninguno)'}`);
    }
  });
  ws.on('error', () => {});                             // el error ya se registra en discoverPeers
}

// Servidor del mesh: comparte el puerto y la URL de ngrok con los jugadores, pero en la ruta /peer
// (el upgrade de la sección 8 separa /connect = jugadores y /peer = coordinadores)
const peerWss = new WebSocketServer({ noServer: true });

// Abre la conexión saliente hacia un peer de id MAYOR al mío
function connectToPeer(id, url) {
  connecting.add(id);
  const ws = new WebSocket(url, { handshakeTimeout: 4000, headers: { 'ngrok-skip-browser-warning': 'true' } });
  setupPeerSocket(ws, true);
  ws.on('error', (err) => {
    if (!peerLogged.has(id)) { peerLogged.add(id); console.log(`[mesh] no se pudo conectar con ${id} (${url}): ${err.message}. Se reintenta`); }
  });
  ws.on('close', () => connecting.delete(id));
}

// GET /peers al arrancar y cada PEER_POLL_MS: abre conexiones a los nuevos y cierra las de los que desaparecieron
async function discoverPeers() {
  try {
    const res  = await fetch(`${AUTH_URL}/peers`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
    const data = await res.json();
    if (!Array.isArray(data.peers)) throw new Error('respuesta sin "peers"');
    knownPeers = new Map(data.peers.filter(x => x && x.coordinatorId !== COORDINATOR_ID && isWsUrlOk(x.peerUrl))
      .map(x => [x.coordinatorId, x.peerUrl]));              // cada coordinador se filtra a sí mismo

    for (const [id, url] of knownPeers) {
      missed.delete(id);
      if (COORDINATOR_ID < id && !peers.has(id) && !connecting.has(id)) connectToPeer(id, url);   // el menor inicia
    }
    for (const [id, r] of peers) {                            // los que el directorio ya no lista (murieron)
      if (knownPeers.has(id)) continue;
      const n = (missed.get(id) || 0) + 1;
      missed.set(id, n);
      if (n >= 2) { console.log(`[mesh] ${id} ya no está en /peers de ${AUTH_URL}: se cierra su conexión (si sigue encendido, revisa que use el MISMO AUTH_URL)`); r.ws.close(1000, 'left directory'); missed.delete(id); }
    }
  } catch (err) {
    if (peerLogged.has('__dir')) return;
    peerLogged.add('__dir');
    console.log(`[mesh] No se pudo consultar ${AUTH_URL}/peers (${err.message}). Se reintentará`);
    return;
  }
  peerLogged.delete('__dir');
}
const isWsUrlOk = (u) => typeof u === 'string' && /^wss?:\/\/[^\s/]+/i.test(u);

// Heartbeat hacia el directorio (auth-service): "sigo vivo, tengo N jugadores"
let directoryOk = null;
// Rebalanceo automático: el directorio dice que este coordinador tiene de más. Se elige a los
// jugadores locales que llegaron más recientemente y se les envía "rebalance": el cliente pide
// GET /coordinator y se conecta al nuevo SIN recargar. Al entrar allá, el player_joined del mesh
// hace que aquí se cierre su conexión vieja (4002), conservando posición y color.
// Lo que el mesh necesita para tener una copia idéntica de un jugador: posición, dirección y color
function estadoParaMesh(userId, p) {
  return { userId, username: p.username, provider: p.provider,
    x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, intent: p.intent, extras: p.extras };
}

function moverJugadores(n) {
  const now = Date.now();
  const candidatos = [...players.entries()]
    .filter(([, p]) => isLocal(p) && p.seq > 0 && p.socket.readyState === WebSocket.OPEN && !(p.movingUntil > now))   // seq > 0: el cliente sabe cambiarse (wscat no)
    .sort(([, a], [, b]) => b.connectedAt.localeCompare(a.connectedAt))
    .slice(0, n);
  for (const [userId, p] of candidatos) {
    p.movingUntil = now + 10000;            // no se le vuelve a pedir mientras se cambia
    // Traspaso sin salto: se detiene al jugador y se envía a TODOS los coordinadores su posición
    // y su color exactos. Cuando el cliente entre al nuevo, ese ya lo tiene en el mismo punto.
    p.frozenUntil = now + 3000;
    p.intent = { x: 0, y: 0 };
    replicate({ type: 'positions_sync', players: [estadoParaMesh(userId, p)] });
    console.log(`[rebalanceo] ${p.username} se pasa a otro coordinador con menos carga`);
    send(p.socket, { type: 'rebalance', message: 'Te pasamos a un coordinador con menos jugadores' });
  }
}

async function sendHeartbeat() {
  try {
    const res = await fetch(`${AUTH_URL}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({ coordinatorId: COORDINATOR_ID, publicUrl: PUBLIC_URL, peerUrl: PEER_URL,
        connectedPlayers: localCount(), uptime: Math.floor((Date.now() - STARTED_AT) / 1000) }),
    });
    if (res.status === 409) {                         // otro coordinador vivo ya usa este nombre
      const data = await res.json().catch(() => ({}));
      console.error(`[directorio] ✘ ${data.message || 'Ese nombre ya está en uso'}. ${data.hint || ''}`);
      process.exit(1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    if (Number.isInteger(data.rebalance) && data.rebalance > 0) moverJugadores(data.rebalance);
    if (directoryOk === false) console.log(`[directorio] ${AUTH_URL} responde de nuevo: heartbeat restablecido`);
    directoryOk = true;
  } catch (err) {
    if (directoryOk !== false) console.log(`[directorio] Heartbeat falló (${err.message}). Se reintenta cada ${DIRECTORY_HEARTBEAT_MS / 1000} s`);
    directoryOk = false;
  }
}

// Corrección de deriva: cada coordinador integra las intenciones de los jugadores remotos con su
// propio reloj, así que las copias se pueden separar unos píxeles. El coordinador DUEÑO de cada
// jugador manda su posición real una vez por SYNC_MS y los demás la adoptan.
setInterval(() => { for (const [id, o] of orphans) if (o.until <= Date.now()) orphans.delete(id); }, 10000).unref();

setInterval(() => {
  if (!peers.size) return;
  const list = [];
  for (const [userId, p] of players) {
    if (p.socket) list.push(estadoParaMesh(userId, p));     // posición + dirección + color
  }
  if (list.length) replicate({ type: 'positions_sync', players: list });
}, SYNC_MS);

// Detecta peers congelados (sin "close"): ping/pong de protocolo
setInterval(() => {
  for (const { ws } of peers.values()) {
    if (!ws.isAlive) { console.log(`[mesh] ${ws.peerId} no responde al ping: se termina la conexión`); ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, PEER_PING_MS);

// ───────── 12. Arranque ─────────
if (AUTH_URL) {
  pollSessionPolicy();
  setInterval(pollSessionPolicy, POLICY_POLL_MS);
}

server.listen(PORT, () => console.log(
  `[${COORDINATOR_ID}] Clientes en puerto ${PORT} (${PUBLIC_URL}) · juego a ${TICK_RATE} Hz · heartbeat de WS cada ${HEARTBEAT_MS / 1000} s`));
console.log(`[${COORDINATOR_ID}] Mesh por la misma URL: ${PEER_URL}`);

// Primero el heartbeat (para aparecer en /peers) y luego el descubrimiento, cada uno en su ciclo
sendHeartbeat().then(discoverPeers);
setInterval(sendHeartbeat, DIRECTORY_HEARTBEAT_MS);
setInterval(discoverPeers, PEER_POLL_MS);

// Ctrl+C: cierra limpio. No se avisa al directorio: el auth lo descarta solo tras 6 s sin heartbeat.
function shutdown() {
  console.log(`\n[${COORDINATOR_ID}] Apagando…`);
  for (const ws of wss.clients) ws.close(1001, 'coordinator going away');
  for (const { ws } of peers.values()) ws.close(1001, 'coordinator going away');
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);