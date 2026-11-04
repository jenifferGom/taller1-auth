const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const express = require('express');
const http    = require('http');
const jwt     = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');

// ───────── 1. Configuración ─────────
const PORT           = parseInt(process.env.PORT, 10) || 5000;
const JWT_SECRET     = process.env.JWT_SECRET;          // la MISMA que usa auth-service
const HEARTBEAT_MS   = parseInt(process.env.HEARTBEAT_MS, 10) || 30000;    // ping/pong cada 30 s
const AUTH_URL       = (process.env.AUTH_URL || '').replace(/\/$/, '');     // para la duración en vivo
const POLICY_POLL_MS = parseInt(process.env.POLICY_POLL_MS, 10) || 3000;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET falta o tiene menos de 32 caracteres (debe ser la misma de auth-service)');
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
// userId → { username, provider, socket, connectedAt, x, y, intent: {x, y}, extras: {} }
const players = new Map();

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

// Envía el mismo mensaje a todos los jugadores conectados
function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const { socket } of players.values()) {
    if (socket.readyState === WebSocket.OPEN) socket.send(raw);
  }
}

function playersList() {
  return Array.from(players.entries()).map(([userId, p]) => ({ userId, username: p.username }));
}

// Lista de jugadores (del Taller 4): se envía cuando alguien entra, sale o se reconecta.
function broadcastPlayers(action, username) {
  const list = playersList();
  const texto = { joined: 'entró al juego', left: 'salió del juego', reconnected: 'se reconectó desde otra pestaña' }[action];
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

// Agrega al jugador al Map. Si ya tenía otra conexión (otra pestaña), cierra la anterior
// y conserva su posición y su color, para que el jugador siga donde estaba.
function addPlayer(userId, payload, ws) {
  const previous = players.get(userId);
  if (previous) {
    console.log(`[duplicado] ${payload.username} abrió otra pestaña: se cierra la conexión anterior`);
    closeWith(previous.socket, CLOSE_ELSEWHERE, 'session opened elsewhere', 'session_opened_elsewhere',
      'Abriste esta cuenta en otra pestaña o navegador; esta conexión se cerró',
      'Sigue en la pestaña nueva, o vuelve a iniciar sesión aquí (eso cerrará la otra)');
  }
  players.set(userId, {
    username:    payload.username,
    provider:    payload.provider === 'google' ? 'google' : 'local',
    socket:      ws,
    connectedAt: new Date().toISOString(),
    x: previous ? previous.x : PLAYER_RADIUS + Math.random() * (WORLD_WIDTH  - 2 * PLAYER_RADIUS),
    y: previous ? previous.y : PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS),
    intent: { x: 0, y: 0 },
    extras: previous ? previous.extras : {},
  });
  console.log(`[+] ${payload.username} conectado (${payload.provider || 'local'})`);
  broadcastPlayers(previous ? 'reconnected' : 'joined', payload.username);
}

// Quita al jugador del Map y avisa a todos. Solo si este socket sigue siendo el activo:
// cuando se cierra la pestaña vieja (reemplazada), NO debe borrar la conexión nueva.
function removePlayer(userId, username, ws) {
  if (players.get(userId)?.socket !== ws) return;
  players.delete(userId);                 // primero se elimina del Map...
  console.log(`[-] ${username} desconectado`);
  broadcastPlayers('left', username);     // ...y luego se avisa a los demás
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
  p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };
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
  http: { 'GET /health': 'Estado del servicio', 'GET /players': 'Jugadores conectados' },
}));
app.get('/health',  (_req, res) => res.json({ status: 'ok', message: 'coordinator funcionando', players: players.size,
  sessionPolicy: policy.label || 'sin consultar' }));
app.get('/players', (_req, res) => res.json({ players: playersList(), message: `${players.size} jugador(es) en línea` }));
app.use((req, res) => res.status(404).json({
  error: 'not_found', message: `No existe ${req.method} ${req.path}`,
  hint: 'Rutas HTTP: GET /, GET /health, GET /players. WebSocket: /connect?token=...',
}));

// El token se valida en el UPGRADE, antes de que el socket entre a 'connection'.
server.on('upgrade', (req, socket, head) => {
  const url    = new URL(req.url, `http://${req.headers.host}`);
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
    wss.emit('connection', ws, result.payload);
  });
});

// ───────── 9. Cada conexión de jugador ─────────
wss.on('connection', (ws, payload) => {
  const userId   = String(payload.userId);
  const username = payload.username;
  ws.username = username;
  ws.tokenIat = payload.iat;
  ws.tokenExp = payload.exp;

  addPlayer(userId, payload, ws);
  const exp = scheduleExpiry(ws);

  // Bienvenida: identidad + dimensiones del mundo (el cliente arma el canvas con esto)
  send(ws, {
    type: 'welcome',
    message: `Conectado al juego como ${username}`,
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
  });

  ws.on('error', (err) => console.error(`[ws] error de ${username}: ${err.message}`));
});

// ───────── 10. Game loop: el servidor mueve a los jugadores ─────────
// 20 veces por segundo: aplica las intenciones, respeta los límites y envía el estado a todos.
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

  if (players.size) broadcast({ type: 'state', t: now, players: snapshot() });
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

// ───────── 12. Arranque ─────────
if (AUTH_URL) {
  pollSessionPolicy();
  setInterval(pollSessionPolicy, POLICY_POLL_MS);
} else {
  console.log('[sesión] AUTH_URL no está en el .env: los cambios de duración solo afectarán a los tokens nuevos');
}

server.listen(PORT, () => console.log(
  `Coordinador en puerto ${PORT} (WS en /connect?token=..., juego a ${TICK_RATE} Hz, heartbeat cada ${HEARTBEAT_MS / 1000} s)`));