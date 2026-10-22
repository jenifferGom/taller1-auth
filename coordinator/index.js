require('dotenv').config();
const express = require('express');
const http    = require('http');
const jwt     = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');

// ───────── 1. Configuración ─────────
const PORT         = parseInt(process.env.PORT, 10) || 5000;
const JWT_SECRET   = process.env.JWT_SECRET;          // la MISMA que usa auth-service
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS, 10) || 30000;   // ping/pong cada 30 s

if (!JWT_SECRET) {
  console.error('Falta JWT_SECRET en el .env (debe ser la misma de auth-service)');
  process.exit(1);
}

// Códigos de cierre propios (el rango 4000-4999 está reservado para aplicaciones)
const CLOSE_INVALID_TOKEN = 4001;   // token vencido, malformado o con otra firma
const CLOSE_ELSEWHERE     = 4002;   // el mismo usuario abrió otra pestaña
const CLOSE_BAD_PATH      = 4004;   // se conectó a una ruta distinta de /connect

// Mensajes que el cliente puede enviar (se listan en el welcome y en los errores)
const CLIENT_MESSAGES = {
  ping:        '{"type":"ping"} → responde pong (prueba de conexión)',
  get_players: '{"type":"get_players"} → te envía la lista de jugadores en línea',
  logout:      '{"type":"logout"} → cierra tu sesión en el coordinador',
  reauth:      '{"type":"reauth","token":"..."} → vuelve a validar tu sesión con otro token',
};

// ───────── 2. Estado en memoria ─────────
// userId → { username, socket, connectedAt }
const players = new Map();

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

function playersList() {
  return Array.from(players.entries()).map(([userId, p]) => ({ userId, username: p.username }));
}

// Envía la lista a TODOS los conectados (incluido el que acaba de entrar).
// "players" es el formato del enunciado; "event" y "message" dicen qué cambió.
function broadcastPlayers(action, username) {
  const list = playersList();
  const texto = { joined: 'entró al lobby', left: 'salió del lobby', reconnected: 'se reconectó desde otra pestaña' }[action];
  const msg = JSON.stringify({
    type: 'players_update',
    players: list,
    event: { action, username },
    message: `${username} ${texto} (${list.length} en línea)`,
  });
  for (const { socket } of players.values()) {
    if (socket.readyState === WebSocket.OPEN) socket.send(msg);
  }
  console.log(`[broadcast] ${username} ${action} → ${list.length} en línea: ${list.map(p => p.username).join(', ') || '(nadie)'}`);
}

// ───────── 4. Verificación del token ─────────
// Devuelve { payload } si es válido, o { code, message, hint } explicando qué falló.
function verifyToken(token) {
  if (!token) {
    return { code: 'MISSING_TOKEN', message: 'No enviaste token',
      hint: 'Conéctate a /connect?token=TU_TOKEN (el token sale de POST /login en auth-service)' };
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);          // valida firma y exp
    if (!payload.userId || !payload.username) {
      return { code: 'INVALID_TOKEN', message: 'El token no trae userId y username',
        hint: 'Usa un token emitido por POST /login' };
    }
    return { payload };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return { code: 'TOKEN_EXPIRED', message: `El token venció (${err.expiredAt.toISOString()})`,
        hint: 'Haz login de nuevo con POST /login para obtener un token nuevo' };
    }
    if (err.message === 'invalid signature') {
      return { code: 'INVALID_SIGNATURE', message: 'La firma del token no es válida',
        hint: 'El token fue modificado o lo firmó otra clave. Pide uno nuevo con POST /login' };
    }
    return { code: 'MALFORMED_TOKEN', message: `El token está mal formado (${err.message})`,
      hint: 'Copia el token completo que devuelve POST /login, sin comillas ni espacios' };
  }
}

// ───────── 5. Alta y baja de jugadores ─────────

// Agrega al jugador al Map. Si ya tenía otra conexión (otra pestaña), cierra la anterior.
// Devuelve true si fue una reconexión.
function addPlayer(userId, username, ws) {
  const previous = players.get(userId);
  if (previous) {
    console.log(`[duplicado] ${username} abrió otra pestaña: se cierra la conexión anterior`);
    closeWith(previous.socket, CLOSE_ELSEWHERE, 'session opened elsewhere', 'SESSION_OPENED_ELSEWHERE',
      'Abriste esta cuenta en otra pestaña o navegador; esta conexión se cerró',
      'Sigue en la pestaña nueva, o vuelve a iniciar sesión aquí (eso cerrará la otra)');
  }
  players.set(userId, { username, socket: ws, connectedAt: Date.now() });
  console.log(`[+] ${username} conectado`);
  broadcastPlayers(previous ? 'reconnected' : 'joined', username);
}

// Quita al jugador del Map y avisa a todos. Solo si este socket sigue siendo el activo:
// cuando se cierra la pestaña vieja (reemplazada), NO debe borrar la conexión nueva.
function removePlayer(userId, username, ws) {
  if (players.get(userId)?.socket !== ws) return;
  players.delete(userId);                 // primero se elimina del Map...
  console.log(`[-] ${username} desconectado`);
  broadcastPlayers('left', username);     // ...y luego se avisa a los demás
}

// ───────── 6. Servidor HTTP + WebSocket ─────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });   // nosotros manejamos el upgrade

app.get('/', (_req, res) => res.json({
  service: 'coordinator',
  message: 'Coordinador de sesiones en línea',
  websocket: 'ws://HOST/connect?token=TU_TOKEN (wss:// si es por ngrok)',
  clientMessages: CLIENT_MESSAGES,
  http: { 'GET /health': 'Estado del servicio', 'GET /players': 'Jugadores conectados' },
}));
app.get('/health',  (_req, res) => res.json({ status: 'ok', message: 'coordinator funcionando', players: players.size }));
app.get('/players', (_req, res) => res.json({ players: playersList(), message: `${players.size} jugador(es) en línea` }));
app.use((req, res) => res.status(404).json({
  error: 'NOT_FOUND', message: `No existe ${req.method} ${req.path}`,
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
      return closeWith(ws, CLOSE_BAD_PATH, 'bad path', 'BAD_PATH',
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

// ───────── 7. Cada conexión de jugador ─────────
wss.on('connection', (ws, payload) => {
  const userId   = String(payload.userId);
  const username = payload.username;

  // Confirmación de conexión solo para quien entra
  send(ws, {
    type: 'welcome',
    message: `Conectado al coordinador como ${username}`,
    user: { userId, username },
    tokenExpiresAt: new Date(payload.exp * 1000).toISOString(),
    clientMessages: CLIENT_MESSAGES,
  });
  addPlayer(userId, username, ws);

  // Heartbeat: marcamos vivo al conectar y cada vez que responde un pong
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // El token también se vence con el socket abierto: cerramos justo cuando llega exp.
  let expiryTimer = null;
  function scheduleExpiry(exp) {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      console.log(`[expirado] token de ${username}`);
      closeWith(ws, CLOSE_INVALID_TOKEN, 'token expired', 'TOKEN_EXPIRED',
        'Tu token venció y la sesión se cerró', 'Haz login de nuevo con POST /login');
    }, Math.max(0, exp * 1000 - Date.now()));
  }
  scheduleExpiry(payload.exp);

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
      return closeWith(ws, CLOSE_INVALID_TOKEN, 'invalid token', 'TOKEN_USER_MISMATCH',
        'El token nuevo pertenece a otro usuario', 'Cierra sesión e inicia sesión con la cuenta que quieres usar');
    }
    scheduleExpiry(result.payload.exp);
    console.log(`[reauth] ${username}: token nuevo válido`);
    send(ws, { type: 'reauth_ok', message: 'Token verificado: tu sesión sigue activa',
      tokenExpiresAt: new Date(result.payload.exp * 1000).toISOString() });
  }

  // Mensajes del cliente: todos reciben respuesta (resultado o error)
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return sendError(ws, 'INVALID_JSON', 'El mensaje no es un JSON válido',
        'Envía un objeto como {"type":"ping"}');
    }
    if (!msg || typeof msg.type !== 'string') {
      return sendError(ws, 'MISSING_TYPE', 'El mensaje no tiene el campo "type"',
        `Tipos disponibles: ${Object.keys(CLIENT_MESSAGES).join(', ')}`);
    }

    switch (msg.type) {
      case 'ping':
        return send(ws, { type: 'pong', message: 'Conexión activa', serverTime: new Date().toISOString() });
      case 'get_players':
        return send(ws, { type: 'players_update', players: playersList(),
          message: `${players.size} jugador(es) en línea` });
      case 'logout':
        send(ws, { type: 'logout_ok', message: `Sesión de ${username} cerrada. ¡Hasta pronto!` });
        return ws.close(1000, 'logout');
      case 'reauth':
        return reauth(typeof msg.token === 'string' ? msg.token : '');
      default:
        return sendError(ws, 'UNKNOWN_TYPE', `No existe el tipo de mensaje "${msg.type}"`,
          `Tipos disponibles: ${Object.keys(CLIENT_MESSAGES).join(', ')}`);
    }
  });

  ws.on('close', () => {
    clearTimeout(expiryTimer);
    removePlayer(userId, username, ws);
  });

  ws.on('error', (err) => console.error(`[ws] error de ${username}: ${err.message}`));
});

// ───────── 8. Heartbeat: detecta conexiones muertas ─────────
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

server.listen(PORT, () => console.log(`Coordinador en puerto ${PORT} (WS en /connect?token=..., heartbeat cada ${HEARTBEAT_MS / 1000} s)`));