const fs     = require('fs');
const path   = require('path');
const dotenv = require('dotenv');

// El .env se busca junto a este archivo (funciona aunque se ejecute desde otra carpeta)
const ENV_PATH = path.join(__dirname, '.env');
dotenv.config({ path: ENV_PATH, quiet: true });

const express          = require('express');
const cors             = require('cors');
const bcrypt           = require('bcryptjs');
const jwt              = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { DatabaseSync } = require('node:sqlite');   // SQLite incluido en Node 22.5+
const http   = require('http');
const crypto = require('crypto');
let WebSocketServer, WebSocket;                    // Taller 7: el mesh entre auth-services va por WebSocket
try {
  ({ WebSocketServer, WebSocket } = require('ws'));
} catch {
  console.error('Falta la dependencia "ws" (mesh entre auth-services). Ejecuta  npm install  dentro de auth-service/');
  process.exit(1);
}

// ───────── 1. Configuración ─────────
const PORT          = parseInt(process.env.PORT || '4000', 10);
const JWT_SECRET    = process.env.JWT_SECRET;
const BCRYPT_ROUNDS = Math.max(10, parseInt(process.env.BCRYPT_ROUNDS || '10', 10)); // mínimo 10
const DB_PATH       = path.resolve(__dirname, process.env.DB_PATH || 'users.db');
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();

// Directory service (Taller 6): un coordinador sin heartbeat en este tiempo se considera muerto
const COORDINATOR_TTL_MS = parseInt(process.env.COORDINATOR_TTL_MS, 10) || 6000;   // 3 ciclos de 2 s
// Asignaciones recientes que todavía no aparecen en el connectedPlayers del heartbeat (ver GET /coordinator)
const AUTO_REBALANCE     = process.env.AUTO_REBALANCE !== 'false';   // mover jugadores conectados para emparejar la carga
const REBALANCE_COOLDOWN_MS = 4000;                                 // pausa entre órdenes al mismo coordinador
const PENDING_TTL_MS     = process.env.PENDING_TTL_MS !== undefined ? parseInt(process.env.PENDING_TTL_MS, 10) : 5000;

// ── Taller 7: varios auth-services, un líder y réplicas ──
// Cada computador corre UN auth-service con el MISMO código y un .env con la misma forma:
//   npm run start:a  →  node index.js auth-a     (el nombre sale del comando: distinto en cada PC)
//   npm start -- mi-nombre  →  cualquier nombre (único en el cluster; sin importar cuál: a < b < c decide quién inicia el mesh)
const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
let   AUTH_ID         = (process.argv[2] || process.env.AUTH_ID || '').trim();
const AUTH_PUBLIC_URL = (process.env.AUTH_PUBLIC_URL || `http://localhost:${PORT}`).trim().replace(/\/+$/, '');   // la de ngrok de ESTE equipo
const AUTH_PEER_URL   = AUTH_PUBLIC_URL.replace(/^http/i, 'ws') + '/peer';           // el mesh usa la MISMA URL, ruta /peer (http→ws, https→wss)
const MESH_SECRET     = process.env.MESH_SECRET || '';                              // opcional: clave compartida del mesh
// Las URLs públicas de TODOS los auth-services (la misma lista en cada equipo). Sirven para descubrirse:
// cada nodo les pregunta GET /peers y aprende quiénes son. El propio se reconoce y se ignora.
const AUTH_URLS_ALL   = (process.env.AUTH_URLS || '').split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
const SEEDS           = AUTH_URLS_ALL.filter(x => normUrl(x) !== normUrl(AUTH_PUBLIC_URL));
const MAX_REPLICA_LAG   = parseInt(process.env.MAX_REPLICA_LAG, 10) || 10;           // escrituras de atraso que tolera una réplica
const LEADER_HB_MS      = parseInt(process.env.LEADER_HB_MS, 10) || 2000;            // el líder emite heartbeat cada 2 s
const LEADER_TTL_MS     = parseInt(process.env.LEADER_TTL_MS, 10) || 6000;           // sin heartbeat 6 s (3 ciclos) → elección
const INITIAL_GRACE_MS  = parseInt(process.env.INITIAL_GRACE_MS, 10) || 5000;        // al arrancar, espera oír a un líder existente
const ELECTION_JITTER_MS  = parseInt(process.env.ELECTION_JITTER_MS, 10) || 300;     // espera aleatoria extra (pequeña)
const ELECTION_STAGGER_MS = parseInt(process.env.ELECTION_STAGGER_MS, 10) || 1500;   // separación entre turnos para postularse
const ELECTION_TIMEOUT_MS = parseInt(process.env.ELECTION_TIMEOUT_MS, 10) || 3000;
const ACK_TIMEOUT_MS    = parseInt(process.env.ACK_TIMEOUT_MS, 10) || 3000;          // cuánto espera el líder la confirmación de las réplicas
const DISCOVERY_MS      = parseInt(process.env.DISCOVERY_MS, 10) || 3000;
const PEER_PING_MS      = parseInt(process.env.PEER_PING_MS, 10) || 5000;
const CLOSE_PEER_REJECTED = 4010;
let role = 'replica';       // 'leader' | 'replica' (un candidato en plena elección también se reporta como replica)

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET falta o tiene menos de 32 caracteres. Genera uno con:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (!AUTH_ID && SEEDS.length === 0) AUTH_ID = 'auth-1';     // un solo auth (como antes del Taller 7): sin nombre y es su propio líder
if (!AUTH_ID) {
  console.error('Falta el nombre de este auth-service: npm run start:a, o npm start -- mi-nombre (letras, números, . _ -; máx. 64)');
  process.exit(1);
}
if (!/^[\w.-]{1,64}$/.test(AUTH_ID)) {
  console.error('El nombre del auth-service no es válido (letras, números, . _ -; máx. 64)');
  process.exit(1);
}
for (const u of [AUTH_PUBLIC_URL, ...AUTH_URLS_ALL]) {
  if (!/^https?:\/\/[^\s/]+/i.test(u)) {
    console.error(`AUTH_PUBLIC_URL y AUTH_URLS deben ser URLs http(s)://... (revisa "${u}" en el .env)`);
    process.exit(1);
  }
}
if (!GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com')) {
  console.error('GOOGLE_CLIENT_ID falta o no es válido en el .env (debe terminar en .apps.googleusercontent.com)');
  process.exit(1);
}

// Cliente de Google: verifica la firma de los ID Tokens con las claves públicas de Google
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ───────── 2. Duración del token, configurable EN VIVO ─────────
// JWT_EXPIRES_IN se puede cambiar en el .env sin reiniciar: el servicio vigila el archivo
// y el siguiente token ya sale con la duración nueva. El coordinador consulta
// GET /session-policy para aplicar el cambio también a los jugadores ya conectados.

// Convierte "30s", "15m", "1h", "2d" o "90" (segundos) a segundos. Devuelve null si no es válido.
function parseDuration(value) {
  const m = String(value).trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m || Number(m[1]) <= 0) return null;
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || 's').toLowerCase()];
  return Number(m[1]) * factor;
}

const session = { label: '1h', seconds: 3600, updatedAt: new Date().toISOString() };

function applyExpiresIn(raw, origin) {
  // Taller 7: la duración es del CLUSTER y la define el líder. Una réplica que ve cambiar su .env
  // lo ignora (seguiría emitiendo tokens distintos a los del resto); la copia que manda es la del líder.
  if (origin === 'archivo' && role !== 'leader') {
    console.log('[config] Cambió JWT_EXPIRES_IN en el .env, pero este nodo es réplica: la duración la define el líder ' +
      '(cambia el .env del líder, o de este nodo si llega a serlo)');
    return;
  }
  const value   = (raw || '1h').trim();
  const seconds = parseDuration(value);
  if (!seconds) {
    console.error(`[config] JWT_EXPIRES_IN="${value}" no es válido (usa 30s, 15m, 1h...). Se mantiene ${session.label}`);
    return;
  }
  if (seconds === session.seconds && origin !== 'inicio') return;
  if (origin !== 'inicio') console.log(`[config] Duración del token: ${session.label} → ${value} (aplicado sin reiniciar)`);
  session.label = value;
  session.seconds = seconds;
  session.updatedAt = new Date().toISOString();
}

applyExpiresIn(process.env.JWT_EXPIRES_IN, 'inicio');

// Una réplica adopta la duración que anuncia el líder en su heartbeat
function adoptSession(s) {
  if (!s || !Number.isFinite(s.seconds) || s.seconds <= 0 || s.seconds === session.seconds) return;
  console.log(`[config] Duración del token (anunciada por el líder): ${session.label} → ${s.label}`);
  session.label = String(s.label || `${s.seconds}s`);
  session.seconds = s.seconds;
  session.updatedAt = s.updatedAt || new Date().toISOString();
}

// watchFile revisa el archivo cada segundo; es más confiable que fs.watch en Windows y OneDrive
fs.watchFile(ENV_PATH, { interval: 1000 }, () => {
  try {
    const vars = dotenv.parse(fs.readFileSync(ENV_PATH));
    const before = session.seconds;
    applyExpiresIn(vars.JWT_EXPIRES_IN, 'archivo');
    if (role === 'leader' && session.seconds !== before && typeof sendHeartbeats === 'function') sendHeartbeats();   // que las réplicas lo sepan ya
  } catch (err) {
    console.error(`[config] No se pudo releer el .env: ${err.message}`);
  }
});

// ───────── 3. Base de datos: una sola tabla users para ambos proveedores ─────────
const USERS_SCHEMA = `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL COLLATE NOCASE,          -- 'Alice' y 'alice' son el mismo
    provider      TEXT NOT NULL CHECK (provider IN ('local','google')),
    password_hash TEXT,                                         -- NULL para usuarios de Google
    google_sub    TEXT UNIQUE,                                  -- NULL para usuarios locales
    email         TEXT,                                         -- opcional para local
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    CHECK ((provider = 'local'  AND password_hash IS NOT NULL AND google_sub IS NULL) OR
           (provider = 'google' AND google_sub IS NOT NULL    AND password_hash IS NULL))
  )`;

const db = new DatabaseSync(DB_PATH);

// node:sqlite marca las violaciones de UNIQUE con errcode 2067
function isUniqueError(err) {
  return err && (err.errcode === 2067 || /UNIQUE constraint failed/.test(err.message));
}

// Crea la tabla o actualiza una base del Taller 4 sin perder usuarios.
function prepareDatabase() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!table) {
    db.exec(USERS_SCHEMA);
    console.log('[db] Tabla users creada');
    return;
  }

  const columns = Object.fromEntries(db.prepare('PRAGMA table_info(users)').all().map(c => [c.name, c]));
  const upToDate = columns.provider && columns.google_sub && columns.email &&
                   columns.password_hash.notnull === 0 && /COLLATE\s+NOCASE/i.test(table.sql);
  if (upToDate) return;

  // Copia de seguridad antes de tocar nada (termina en .db, así .gitignore la excluye)
  const stamp  = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = DB_PATH.replace(/\.db$/i, '') + `-backup-${stamp}.db`;
  fs.copyFileSync(DB_PATH, backup);
  console.log(`[db] Base antigua detectada. Copia de seguridad: ${path.basename(backup)}`);

  const oldRows = db.prepare('SELECT * FROM users ORDER BY id').all();   // el más antiguo primero
  let kept = 0;
  try {
    db.exec('BEGIN');
    db.exec(USERS_SCHEMA.replace('CREATE TABLE users', 'CREATE TABLE users_new'));
    const insert = db.prepare(`INSERT INTO users_new (id, username, provider, password_hash, google_sub, email, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const row of oldRows) {
      const provider = row.provider === 'google' ? 'google' : 'local';
      try {
        insert.run(row.id, row.username, provider,
          provider === 'local' ? row.password_hash : null,
          provider === 'google' ? row.google_sub : null,
          row.email ?? null, row.created_at ?? null);
        kept++;
      } catch (err) {
        if (!isUniqueError(err) && !/CHECK constraint failed/.test(err.message)) throw err;
        console.log(`[db] Usuario "${row.username}" (id ${row.id}) descartado: ` +
          (isUniqueError(err) ? 'repite un username existente sin importar mayúsculas' : 'datos incompletos'));
      }
    }
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`[db] La migración falló y no se cambió nada: ${err.message}`);
    process.exit(1);
  }
  console.log(`[db] Migración lista: ${kept} de ${oldRows.length} usuarios conservados`);
}

prepareDatabase();

// ───────── 3b. Log de replicación (Taller 7) ─────────
// Cada escritura (registrar un usuario, crear una cuenta de Google) es una entrada numerada del
// log "oplog". El líder la escribe junto con el usuario, en la misma transacción, y la propaga; las
// réplicas aplican las mismas entradas EN ORDEN. Así todos los nodos terminan con los mismos
// usuarios y con los MISMOS userId (el JWT los lleva firmados: no pueden cambiar de un nodo a otro).
//   seq   = número de la escritura (1, 2, 3...)           term = término del líder que la escribió
//   hash  = sha256(hash anterior + seq + term + op + data): encadena el log. Dos nodos con la misma
//           entrada en el mismo seq tienen la MISMA historia; si el hash difiere, sus logs se separaron.
db.exec(`
  CREATE TABLE IF NOT EXISTS oplog (
    seq  INTEGER PRIMARY KEY,
    term INTEGER NOT NULL,
    op   TEXT NOT NULL,
    data TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

const oplogStmts = {
  insert: db.prepare('INSERT INTO oplog (seq, term, op, data, hash) VALUES (?, ?, ?, ?, ?)'),
  get:    db.prepare('SELECT * FROM oplog WHERE seq = ?'),
  since:  db.prepare('SELECT * FROM oplog WHERE seq > ? ORDER BY seq'),
  last:   db.prepare('SELECT * FROM oplog ORDER BY seq DESC LIMIT 1'),
  insertUserFull: db.prepare(`INSERT INTO users (id, username, provider, password_hash, google_sub, email, created_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?)`),
  metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
  metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
};
const countUsers = () => Number(oplogStmts.countUsers.get().n);

const hashOf = (prev, seq, term, op, dataStr) =>
  crypto.createHash('sha256').update(`${prev}|${seq}|${term}|${op}|${dataStr}`).digest('hex');

// Lo que viaja en una entrada: la fila completa del usuario (sin campos vacíos)
function userData(u) {
  const d = { userId: Number(u.id), username: u.username, provider: u.provider, password_hash: u.password_hash,
    google_sub: u.google_sub, email: u.email, created_at: u.created_at };
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined));
}

let lastSeq = 0, lastHash = '0', lastLogTerm = 0;     // la punta del log de ESTE nodo
function loadLogState() {
  const r = oplogStmts.last.get();
  lastSeq = r ? Number(r.seq) : 0;
  lastHash = r ? r.hash : '0';
  lastLogTerm = r ? Number(r.term) : 0;
}
const hashAt = (seq) => (seq === 0 ? '0' : (oplogStmts.get.get(seq) || {}).hash);

// Una base que ya tenía usuarios (Talleres 4-6) no tiene log: se escribe uno con esos usuarios,
// para que el nodo pueda ser líder y sirva de fuente a las réplicas.
function genesisFromExistingUsers() {
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM oplog').get().n) > 0) return;
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  if (!rows.length) return;
  let prev = '0', seq = 0;
  db.exec('BEGIN');
  for (const u of rows) {
    seq++;
    const op = u.provider === 'google' ? 'register_google' : 'register';
    const dataStr = JSON.stringify(userData(u));
    prev = hashOf(prev, seq, 0, op, dataStr);
    oplogStmts.insert.run(seq, 0, op, dataStr, prev);
  }
  db.exec('COMMIT');
  console.log(`[réplica] ${rows.length} usuarios que ya existían quedaron en el log de replicación (seq 1..${seq})`);
}
genesisFromExistingUsers();
loadLogState();

let term     = Number(((oplogStmts.metaGet.get('term') || {}).value) || 0);        // término actual (sobrevive a reinicios)
let votedFor = ((oplogStmts.metaGet.get('votedFor') || {}).value) || null;          // a quién voté en este término
function setTerm(t, voted = null) {
  term = t; votedFor = voted;
  oplogStmts.metaSet.run('term', String(term));
  oplogStmts.metaSet.run('votedFor', voted === null ? '' : voted);
  if (voted === null) votedFor = null;
}
if (votedFor === '') votedFor = null;

// Aplica UNA entrada del líder (réplica). Debe ser exactamente la siguiente: seq = lastSeq + 1.
function applyEntry(e) {
  if (!e || !Number.isInteger(e.seq) || !Number.isInteger(e.term) || (e.op !== 'register' && e.op !== 'register_google')) {
    throw new Error('entrada de replicación inválida');
  }
  if (e.seq !== lastSeq + 1) throw new Error(`hueco en el log (esperaba ${lastSeq + 1}, llegó ${e.seq})`);
  const d = e.data;
  if (!d || !Number.isInteger(d.userId) || typeof d.username !== 'string' || (d.provider !== 'local' && d.provider !== 'google')) {
    throw new Error('datos de usuario inválidos en la entrada');
  }
  const dataStr = JSON.stringify(d);
  const hash = hashOf(lastHash, e.seq, e.term, e.op, dataStr);
  if (e.hash && e.hash !== hash) throw new Error(`el hash de la entrada ${e.seq} no coincide: los logs se separaron`);
  db.exec('BEGIN');
  try {
    oplogStmts.insertUserFull.run(d.userId, d.username, d.provider, d.password_hash ?? null, d.google_sub ?? null,
      d.email ?? null, d.created_at ?? null);
    oplogStmts.insert.run(e.seq, e.term, e.op, dataStr, hash);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  lastSeq = e.seq; lastHash = hash; lastLogTerm = e.term;
}

// Escritura del LÍDER: inserta el usuario y su entrada de log en una sola transacción.
// doInsert() hace el INSERT y devuelve la fila del usuario ya creada.
function leaderWrite(op, doInsert) {
  const seq = lastSeq + 1;
  db.exec('BEGIN');
  try {
    const user = doInsert();
    const data = userData(user);
    const dataStr = JSON.stringify(data);
    const hash = hashOf(lastHash, seq, term, op, dataStr);
    oplogStmts.insert.run(seq, term, op, dataStr, hash);
    db.exec('COMMIT');
    lastSeq = seq; lastHash = hash; lastLogTerm = term;
    return { seq, term, op, data, hash };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const entriesSince = (seq) => oplogStmts.since.all(seq).map(r =>
  ({ seq: Number(r.seq), term: Number(r.term), op: r.op, data: JSON.parse(r.data), hash: r.hash }));

// Copia de seguridad consistente de la BD (VACUUM INTO no copia a medias una base en uso)
function backupDb(reason) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = DB_PATH.replace(/\.db$/i, '') + `-backup-${stamp}.db`;
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`[réplica] Copia de seguridad de la BD local (${reason}): ${path.basename(file)}`);
  } catch (err) {
    console.log(`[réplica] No se pudo hacer la copia de seguridad (${err.message}); se continúa`);
  }
}

// El líder tiene otra historia (por ejemplo, esta BD se usó sola antes de entrar al cluster, o este
// nodo era un líder viejo con escrituras que nunca llegaron a la mayoría): se descarta la copia local
// y se vuelve a construir desde el principio con el log del líder.
function resetFromLeader(entries) {
  if (lastSeq > 0 || countUsers() > 0) backupDb('el líder tiene otra historia');
  db.exec('BEGIN');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM oplog');
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'users'");
  db.exec('COMMIT');
  lastSeq = 0; lastHash = '0'; lastLogTerm = 0;
  for (const e of entries) applyEntry(e);
}

// Consultas preparadas: los datos van aparte del SQL, así no hay inyección SQL.
// Gracias a COLLATE NOCASE, "WHERE username = ?" no distingue mayúsculas.
const stmts = {
  insertLocal:    db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"),
  insertGoogle:   db.prepare("INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByGoogle:   db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  findById:       db.prepare('SELECT * FROM users WHERE id = ?'),
};

// Hash "señuelo": si el usuario no existe igual se ejecuta un bcrypt.compare,
// así el tiempo de respuesta no revela qué usuarios están registrados.
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_ROUNDS);

// ───────── 4. Respuestas, validaciones y tokens ─────────
// Error: { error: código_en_minúscula, message: qué pasó, hint: cómo solucionarlo }
function fail(res, status, error, message, hint, extra) {
  return res.status(status).json({ error, message, hint, ...(extra || {}) });
}

const BODY_EJEMPLO = '{"username":"alice","password":"secret123"}';

function checkBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['missing_body', 'La petición no trae un body JSON',
      `Envía el header "Content-Type: application/json" y un body como ${BODY_EJEMPLO}`];
  }
  const faltan = ['username', 'password'].filter(k => typeof body[k] !== 'string' || body[k] === '');
  if (faltan.length) {
    return ['missing_fields', `Falta o no es texto: ${faltan.join(' y ')}`, `El body debe ser como ${BODY_EJEMPLO}`];
  }
  return null;
}

// Reglas del username (las mismas para local y Google)
function validateUsername(u) {
  if (typeof u !== 'string') return 'El username debe ser texto';
  if (u.length < 3 || u.length > 32) return 'El username debe tener entre 3 y 32 caracteres';
  if (!/^[a-zA-Z0-9_]+$/.test(u)) return 'El username solo puede tener letras sin tildes, números y _';
  return null;
}

function validatePassword(p) {
  if (p.length < 6) return 'La contraseña debe tener mínimo 6 caracteres';
  if (Buffer.byteLength(p) > 72) return 'La contraseña debe tener máximo 72 caracteres'; // límite de bcrypt
  return null;
}

// El mismo JWT para ambos proveedores: userId, username y provider (+ iat y exp automáticos)
function emitToken(user) {
  return jwt.sign(
    { userId: String(user.id), username: user.username, provider: user.provider },
    JWT_SECRET,
    { expiresIn: session.seconds }
  );
}

// ───────── 5. Rutas ─────────
const app = express();
app.use(cors({ exposedHeaders: ['X-Auth-Id', 'X-Auth-Role'] }));   // el cliente vive en otro origen (otro túnel ngrok)
// Taller 7: todas las respuestas dicen QUÉ nodo contestó y con qué rol (el cliente lo muestra en la UI)
app.use((_req, res, next) => { res.set('X-Auth-Id', AUTH_ID); res.set('X-Auth-Role', role); next(); });

// Todas las peticiones las atiende el LÍDER (pedido del profesor): una réplica no hace login ni
// ninguna otra operación; responde 503 not_leader con leaderUrl y el cliente/coordinador repite la
// petición contra el líder (authFetch lo hace solo). Durante una elección responde 503 no_leader.
// Solo se contestan localmente las rutas de diagnóstico, que sirven para ver el estado de CADA nodo.
// REPLICA_READS=true vuelve al modo anterior (las réplicas al día responden /login, /coordinator...).
const REPLICA_READS = process.env.REPLICA_READS === 'true';
const RUTAS_DE_CADA_NODO = new Set(['/', '/health', '/status', '/peers']);
app.use((req, res, next) => {
  if (role === 'leader' || REPLICA_READS || RUTAS_DE_CADA_NODO.has(req.path) || req.method === 'OPTIONS') return next();
  return redirectToLeader(res);
});
app.use(express.json({ limit: '4kb' }));

app.get('/', (_req, res) => res.json({
  service: 'auth-service',
  message: 'Servicio de autenticación en línea',
  endpoints: {
    'POST /register':      `Crea un usuario local. Body: ${BODY_EJEMPLO}`,
    'POST /login':         `Inicia sesión local y devuelve un JWT. Body: ${BODY_EJEMPLO}`,
    'POST /auth/google':   'Inicia sesión con Google. Body: {"idToken":"...","username":"opcional"}',
    'GET /auth/google/config': 'Client ID público que usa el botón de Google del cliente',
    'GET /session-policy': 'Duración actual de los tokens',
    'POST /refresh':       'Renueva un token emitido con una duración menor a la vigente. Body: {"token":"..."}',
    'POST /heartbeat':     'Directory: un coordinador anuncia que sigue vivo (cada 2 s). Body: {coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime}',
    'GET /coordinator':    'Directory: el coordinador vivo con menos jugadores → {coordinatorId, publicUrl} (503 si no hay)',
    'GET /coordinator-peers': 'Directory: coordinadores vivos para formar su mesh → {peers:[{coordinatorId, peerUrl}]}',
    'GET /coordinators':   'Directory (depuración): todos los coordinadores vivos con su carga',
    'GET /status':         'Cluster: authId, role (leader|replica), leaderUrl, lastAppliedSeq, users...',
    'GET /peers':          'Cluster: auth-services conocidos por este nodo → {peers:[{authId, publicUrl, peerUrl, role}]}',
    'GET /health':         'Estado del servicio',
  },
}));

app.get('/health', (_req, res) => res.json({ status: 'ok', message: 'auth-service funcionando', authId: AUTH_ID, role }));

// Duración vigente de los tokens. La consulta el coordinador para aplicar cambios en vivo.
// serverTime (hora de este equipo) le permite al coordinador compensar si los relojes de los
// computadores no coinciden: el iat y el exp de los tokens están escritos con ESTE reloj.
app.get('/session-policy', (_req, res) => res.json({
  expiresIn:  session.label,
  seconds:    session.seconds,
  updatedAt:  session.updatedAt,
  serverTime: Date.now(),
  message:    `Los tokens nuevos duran ${session.label}`,
}));

// ───── Taller 7: líder y réplicas en las rutas ─────
// Una réplica no escribe: manda al cliente al líder. Durante una elección no hay líder: "no_leader".
function redirectToLeader(res) {
  if (role !== 'leader' && leaderFresh() && leaderUrl) {
    return fail(res, 503, 'not_leader', 'Este nodo es una réplica: la petición la atiende el líder',
      `Repite la petición contra leaderUrl (${leaderUrl})`, { leaderUrl });
  }
  return fail(res, 503, 'no_leader', 'No hay líder en este momento (elección en curso)',
    'Es cuestión de unos segundos: vuelve a intentar', { leaderUrl: null });
}

// ¿Puede esta réplica responder una LECTURA que emite token (login, Google existente, refresh)?
//   ok    = no está demasiado atrasada → puede dar respuestas positivas (usuario y contraseña correctos)
//   exact = está al día → también puede decir "credenciales inválidas" (si no está al día, ese usuario
//           podría ser uno nuevo que todavía no le ha llegado: mejor mandarlo al líder)
function consistency() {
  if (role === 'leader') return { ok: true, exact: true };
  if (!everHeardLeader) return { ok: false, exact: false };         // todavía no sabe nada del líder
  const lag = Math.max(0, leaderSeq - lastSeq);
  if (lag >= MAX_REPLICA_LAG) return { ok: false, exact: false };   // muy atrasada: no emite tokens
  return { ok: true, exact: leaderFresh() && lag === 0 && !logDiverged };
}

// POST /refresh { token } → 200 { token, username, expiresIn }
// Si la duración de la sesión AUMENTÓ (por ejemplo de 5m a 1h), los jugadores conectados
// tienen tokens más cortos. El exp va firmado y no se puede cambiar, así que se emite uno
// nuevo con la duración vigente. Solo se permite si el token sigue válido y se emitió con
// una duración MENOR a la actual: así no sirve para alargar una sesión indefinidamente.
app.post('/refresh', (req, res) => {
  const cons = consistency();
  if (!cons.ok) return redirectToLeader(res);                       // réplica muy atrasada: no emite tokens
  const token = req.body && req.body.token;
  if (typeof token !== 'string' || !token) {
    return fail(res, 400, 'missing_token', 'Falta el token', 'Envía {"token":"<tu JWT actual>"}');
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.log(`[refresh] rechazado: ${err.message}`);
    return fail(res, 401, 'invalid_token', 'El token no es válido o ya venció', 'Inicia sesión de nuevo');
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.iat + session.seconds <= now) {
    return fail(res, 401, 'token_expired', 'La sesión ya venció', 'Inicia sesión de nuevo');
  }
  if (payload.exp - payload.iat >= session.seconds) {
    return fail(res, 409, 'refresh_not_needed', 'Tu token ya tiene la duración vigente',
      'Solo se renueva cuando la duración de la sesión aumenta');
  }
  const user = stmts.findById.get(Number(payload.userId));
  if (!user && !cons.exact) return redirectToLeader(res);           // quizá es un usuario que esta réplica aún no conoce
  if (!user) return fail(res, 401, 'invalid_token', 'El usuario ya no existe', 'Inicia sesión de nuevo');

  console.log(`[refresh] ${user.username}: token renovado (${session.label})`);
  return res.json({ token: emitToken(user), username: user.username, provider: user.provider,
    expiresIn: session.label, message: `Sesión renovada: ahora dura ${session.label}` });
});

// POST /register  →  201 { userId, username, message } | 400 | 409
app.post('/register', async (req, res) => {
  if (role !== 'leader') return redirectToLeader(res);              // solo el líder escribe
  const bad = checkBody(req.body);
  if (bad) return fail(res, 400, ...bad);

  const { username, password } = req.body;
  const usernameError = validateUsername(username);
  if (usernameError) return fail(res, 400, 'invalid_username', usernameError, 'Ejemplo válido: alice_01');
  const passwordError = validatePassword(password);
  if (passwordError) return fail(res, 400, 'invalid_password', passwordError, 'Elige otra contraseña');

  const existing = stmts.findByUsername.get(username);
  if (existing) {
    console.log(`[register] rechazado: "${username}" ya existe como "${existing.username}" (${existing.provider})`);
    return fail(res, 409, 'username_taken', `El usuario "${username}" ya existe`,
      'Elige otro username (no importa si cambias mayúsculas o minúsculas)');
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);       // nunca se guarda la contraseña
    // Mientras se calculaba el hash pudo cambiar el líder: se vuelve a comprobar
    if (role !== 'leader') return redirectToLeader(res);
    if (!hasQuorum()) return noQuorum(res);
    // Opción B: se escribe en el log, se propaga y SOLO cuando la mayoría lo confirma se responde 201
    const entry = leaderWrite('register', () => {
      const info = stmts.insertLocal.run(username, hash);
      return stmts.findById.get(Number(info.lastInsertRowid));
    });
    const committed = await commitWrite(entry);
    if (!committed) return replicationTimeout(res, username);
    console.log(`[register] usuario local creado: ${username} (id ${entry.data.userId}, seq ${entry.seq})`);
    return res.status(201).json({
      userId: String(entry.data.userId),
      username,
      message: `Usuario "${username}" registrado. Ahora inicia sesión`,
    });
  } catch (err) {
    if (isUniqueError(err)) {      // dos registros simultáneos con el mismo nombre
      return fail(res, 409, 'username_taken', `El usuario "${username}" ya existe`, 'Elige otro username');
    }
    console.error('[register] error de base de datos:', err.message);
    return fail(res, 500, 'internal', 'No se pudo registrar el usuario', 'Intenta de nuevo en unos segundos');
  }
});

// POST /login  →  200 { token, username, provider, expiresIn, message } | 400 | 401
app.post('/login', async (req, res) => {
  const cons = consistency();
  if (!cons.ok) return redirectToLeader(res);                       // réplica sin líder conocido o muy atrasada
  const bad = checkBody(req.body);
  if (bad) return fail(res, 400, ...bad);

  const { username, password } = req.body;
  try {
    const user = stmts.findByUsername.get(username);
    // Una réplica que no está al día no puede afirmar que el usuario NO existe: lo manda al líder
    if (!user && !cons.exact) return redirectToLeader(res);

    // Un usuario de Google no tiene contraseña: debe entrar con el botón de Google
    if (user && user.provider !== 'local') {
      console.log(`[login] rechazado: "${user.username}" es una cuenta de Google`);
      return fail(res, 401, 'use_google_login', 'Esta cuenta se creó con Google',
        'Inicia sesión con el botón "Iniciar sesión con Google"');
    }

    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {      // mismo mensaje en los dos casos: no revelamos qué usuarios existen
      console.log(`[login] rechazado: credenciales inválidas para "${username}"`);
      return fail(res, 401, 'invalid_credentials', 'Credenciales inválidas: usuario o contraseña incorrectos',
        'Revisa los datos. Si no tienes cuenta, regístrate');
    }

    console.log(`[login] ${user.username} (local, token de ${session.label})`);
    return res.status(200).json({
      token: emitToken(user),
      username: user.username,
      provider: user.provider,
      expiresIn: session.label,
      message: `Bienvenido, ${user.username}`,
    });
  } catch (err) {
    console.error('[login] error interno:', err.message);
    return fail(res, 500, 'internal', 'No se pudo iniciar sesión', 'Intenta de nuevo en unos segundos');
  }
});

// ───────── 6. Inicio de sesión con Google (opción A: Google Identity Services) ─────────

// El Client ID es público (va en el botón de Google). El cliente lo pide aquí para que
// viva en un solo lugar: el .env del auth.
app.get('/auth/google/config', (_req, res) => res.json({ clientId: GOOGLE_CLIENT_ID }));

// POST /auth/google { idToken, username? }
//   200 { token, username }            ya existía o se creó con éxito
//   409 username_required               primer acceso y no mandó username
//   409 username_taken                  el username elegido ya existe (en cualquier proveedor)
//   401 invalid_id_token                el ID Token no es válido (firma, audience o vencido)
//   401 email_not_verified              el correo de Google no está verificado
//   400                                 body inválido o username con formato inválido
app.post('/auth/google', async (req, res) => {
  const { idToken, username } = req.body || {};
  if (typeof idToken !== 'string' || idToken.length < 20) {
    return fail(res, 400, 'missing_id_token', 'Falta el idToken de Google',
      'Envía {"idToken":"<credential que devuelve el botón de Google>"}');
  }
  if (username !== undefined && typeof username !== 'string') {
    return fail(res, 400, 'invalid_username', 'El username debe ser texto', 'Ejemplo válido: bob_google');
  }

  // 1. Verificar el ID Token CONTRA Google: firma, emisor, vencimiento y audience (aud = nuestro Client ID).
  //    No basta con decodificarlo: cualquiera puede fabricar un JSON con esa forma.
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    console.log(`[google] ID Token rechazado: ${err.message}`);
    return fail(res, 401, 'invalid_id_token', 'No se pudo verificar la cuenta de Google',
      'Vuelve a pulsar el botón de Google. Si sigue fallando, revisa que GOOGLE_CLIENT_ID sea el correcto');
  }

  if (payload.email_verified !== true) {
    console.log(`[google] correo no verificado: ${payload.email}`);
    return fail(res, 401, 'email_not_verified', 'El correo de esta cuenta de Google no está verificado',
      'Verifica tu correo en Google o usa otra cuenta');
  }

  // 2. sub es el identificador estable del usuario en Google (el email puede cambiar)
  const googleSub = payload.sub;
  const email     = payload.email || null;

  try {
    // 3. ¿Ya existe este usuario de Google? Entra directo (se ignora el username enviado)
    const existing = stmts.findByGoogle.get(googleSub);
    if (!existing && role !== 'leader') return redirectToLeader(res);   // primera vez = escritura: la decide el líder
    if (existing && !consistency().ok) return redirectToLeader(res);
    if (existing) {
      console.log(`[google] ${existing.username} inició sesión (token de ${session.label})`);
      return res.json({ token: emitToken(existing), username: existing.username, provider: 'google',
        expiresIn: session.label, message: `Bienvenido de nuevo, ${existing.username}` });
    }

    // 4. Primera vez: hace falta elegir un username
    if (!username) {
      console.log(`[google] primer acceso de ${email}: se pide username`);
      return res.status(409).json({ error: 'username_required', message: 'Primer login con Google',
        hint: 'Elige un username y reenvía {"idToken":"...","username":"..."}' });
    }
    const usernameError = validateUsername(username);
    if (usernameError) return fail(res, 400, 'invalid_username', usernameError, 'Ejemplo válido: bob_google');

    const taken = stmts.findByUsername.get(username);       // sin importar mayúsculas ni proveedor
    if (taken) {
      console.log(`[google] username "${username}" ocupado por "${taken.username}" (${taken.provider})`);
      return fail(res, 409, 'username_taken', `El usuario "${username}" ya existe`, 'Elige otro username');
    }

    // 5. Crear el usuario de Google en la MISMA tabla users (mismo camino que el registro: log → mayoría → respuesta)
    if (role !== 'leader') return redirectToLeader(res);
    if (!hasQuorum()) return noQuorum(res);
    const entry = leaderWrite('register_google', () => {
      const info = stmts.insertGoogle.run(username, googleSub, email);
      return stmts.findById.get(Number(info.lastInsertRowid));
    });
    const committed = await commitWrite(entry);
    if (!committed) return replicationTimeout(res, username);
    const newUser = { id: entry.data.userId, username, provider: 'google' };
    console.log(`[google] usuario creado: ${username} (${email}, id ${entry.data.userId}, seq ${entry.seq})`);
    return res.json({ token: emitToken(newUser), username, provider: 'google',
      expiresIn: session.label, message: `Cuenta creada. Bienvenido, ${username}` });
  } catch (err) {
    if (isUniqueError(err)) {      // otro registro tomó el username justo antes
      return fail(res, 409, 'username_taken', `El usuario "${username}" ya existe`, 'Elige otro username');
    }
    console.error('[google] error interno:', err.message);
    return fail(res, 500, 'internal', 'No se pudo iniciar sesión con Google', 'Intenta de nuevo en unos segundos');
  }
});

// ───────── 6b. Directory service (Taller 6) ─────────
// El auth-service también es el "directorio" de coordinadores: ellos se registran con
// heartbeats y los clientes le preguntan a cuál conectarse. Todo en memoria: si el auth se
// reinicia, los coordinadores vuelven a aparecer solos con su siguiente heartbeat (≤ 2 s).
//
// clave = coordinatorId en minúsculas (así 'Coord-A' y 'coord-a' son el MISMO) →
//   { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime, lastSeen, pending: [timestamps] }
const coordinators = new Map();

const isWsUrl = (u) => typeof u === 'string' && u.length <= 300 && /^wss?:\/\/[^\s/]+/i.test(u);
const isAlive = (c, now = Date.now()) => now - c.lastSeen <= COORDINATOR_TTL_MS;

// Carga efectiva = jugadores que el coordinador dice tener + clientes que acabamos de mandarle
// y que quizá todavía no abrieron el WebSocket. Sin esto, 4 clientes que piden coordinador en
// el mismo segundo verían la MISMA carga (el heartbeat llega cada 2 s) y irían los 4 al mismo.
function effectiveLoad(c, now) {
  c.pending = c.pending.filter(t => now - t < PENDING_TTL_MS);
  return c.connectedPlayers + c.pending.length;
}

function aliveCoordinators() {
  const now = Date.now();
  return [...coordinators.values()].filter(c => isAlive(c, now));
}

// Barrido: descarta (y avisa en consola) a los que dejaron de hacer heartbeat
setInterval(() => {
  if (role !== 'leader') return;       // Taller 7: la réplica solo copia lo que anuncia el líder; no descarta nada por su cuenta
  const now = Date.now();
  for (const [id, c] of coordinators) {
    if (!isAlive(c, now)) {
      coordinators.delete(id);
      console.log(`[directory] ${c.coordinatorId} sin heartbeat hace ${((now - c.lastSeen) / 1000).toFixed(1)} s: se descarta ` +
        `(quedan ${coordinators.size}: ${[...coordinators.values()].map(x => x.coordinatorId).join(', ') || 'ninguno'})`);
    }
  }
}, 1000).unref();

// POST /heartbeat → 200 { ok: true } | 400
app.post('/heartbeat', (req, res) => {
  // Taller 7: el directorio lo lleva el LÍDER. Una réplica no lo acepta: manda al coordinador al líder
  // (503 not_leader + leaderUrl) y el líder se lo copia a las réplicas en cada heartbeat del cluster.
  if (role !== 'leader') return redirectToLeader(res);
  const b = req.body;
  const bad = (m) => fail(res, 400, 'invalid_heartbeat', m,
    'Body: {"coordinatorId":"coord-a","publicUrl":"ws://localhost:5001","peerUrl":"ws://localhost:5101","connectedPlayers":0,"uptime":12}');
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('El body debe ser un objeto JSON');
  if (typeof b.coordinatorId !== 'string' || !/^[\w.-]{1,64}$/.test(b.coordinatorId)) return bad('coordinatorId debe ser texto (1-64: letras, números, . _ -)');
  if (!isWsUrl(b.publicUrl)) return bad('publicUrl debe empezar con ws:// o wss://');
  if (!isWsUrl(b.peerUrl))   return bad('peerUrl debe empezar con ws:// o wss://');
  if (!Number.isInteger(b.connectedPlayers) || b.connectedPlayers < 0) return bad('connectedPlayers debe ser un entero ≥ 0');
  if (!Number.isFinite(b.uptime) || b.uptime < 0) return bad('uptime debe ser un número ≥ 0 (segundos)');

  // Nombres únicos sin importar mayúsculas: si OTRO coordinador vivo (otra URL) ya usa ese
  // nombre, se rechaza. La misma URL sí puede volver a registrarse (es el mismo que se reinició).
  const key  = b.coordinatorId.toLowerCase();
  const prev = coordinators.get(key);
  if (prev && isAlive(prev) && prev.publicUrl.toLowerCase() !== b.publicUrl.toLowerCase()) {
    console.log(`[directory] ✘ ${b.coordinatorId} (${b.publicUrl}) rechazado: el nombre ya lo usa ${prev.coordinatorId} (${prev.publicUrl})`);
    return fail(res, 409, 'coordinator_id_taken',
      `Ya hay un coordinador llamado "${prev.coordinatorId}" (${prev.publicUrl})`,
      'Arranca este coordinador con otro nombre: npm start -- otro-nombre (no importan mayúsculas: Coord-A = coord-a)');
  }
  // Tampoco dos nombres con la MISMA URL: el túnel solo llega a uno de los dos procesos, y los
  // jugadores que se le asignen al otro terminarían en el equivocado (su carga nunca subiría).
  const sameUrl = aliveCoordinators().find(c => c.coordinatorId.toLowerCase() !== key &&
    c.publicUrl.toLowerCase() === b.publicUrl.toLowerCase());
  if (sameUrl) {
    console.log(`[directory] ✘ ${b.coordinatorId} rechazado: su URL ${b.publicUrl} ya es de ${sameUrl.coordinatorId}`);
    return fail(res, 409, 'public_url_taken',
      `La URL ${b.publicUrl} ya la usa el coordinador "${sameUrl.coordinatorId}"`,
      'Cada coordinador necesita SU propio túnel: abre ngrok para su puerto y pon esa URL en COORD_PUBLIC_URL');
  }
  // Asignaciones pendientes: si el coordinador ahora reporta MÁS jugadores que antes, esos
  // clientes ya llegaron y ya están en connectedPlayers: se quitan de "pending" para no
  // contarlos dos veces (antes quedaban contados doble hasta 3 s y el reparto salía 3/2/1).
  const pending = prev ? prev.pending : [];
  const llegaron = prev ? Math.max(0, b.connectedPlayers - prev.connectedPlayers) : 0;
  pending.splice(0, Math.min(llegaron, pending.length));          // los más antiguos primero
  coordinators.set(key, {
    coordinatorId: b.coordinatorId, publicUrl: b.publicUrl, peerUrl: b.peerUrl,
    connectedPlayers: b.connectedPlayers, uptime: b.uptime,
    lastSeen: Date.now(), pending, lastMoveAt: prev ? prev.lastMoveAt : 0,
  });
  if (!prev || !isAlive(prev)) {
    console.log(`[directory] ${b.coordinatorId} registrado (cliente ${b.publicUrl}, peers ${b.peerUrl}). ` +
      `Coordinadores vivos: ${[...coordinators.values()].map(x => x.coordinatorId).join(', ')}`);
  }
  res.json({ ok: true, rebalance: cuantosMover(coordinators.get(key)) });
});

// Rebalanceo automático: si ESTE es el coordinador más cargado y le lleva 2 o más jugadores al
// menos cargado, se le pide mover la mitad de la diferencia. Esos clientes vuelven a pedir
// GET /coordinator y el auth los manda a los de menor carga, sin recargar la página.
// Ejemplo: 4/0/0 → mueve 2 → 2/1/1.   2/1/1 → diferencia 1 → no se mueve nada.
function cuantosMover(c) {
  if (!AUTO_REBALANCE) return 0;
  const now  = Date.now();
  // Solo cuentan los que mandaron heartbeat hace poco: uno que se acaba de caer sigue "vivo" hasta
  // 6 s, y no hay que mandarle jugadores
  const vivos = aliveCoordinators().filter(x => now - x.lastSeen <= 3000);
  if (vivos.length < 2 || !vivos.includes(c) || now - c.lastMoveAt < REBALANCE_COOLDOWN_MS) return 0;
  const carga = (x) => effectiveLoad(x, now);
  const max = Math.max(...vivos.map(carga));
  const min = Math.min(...vivos.map(carga));
  const masCargado = vivos.find(x => carga(x) === max);          // solo uno a la vez (el primero)
  if (masCargado !== c || max - min < 2) return 0;
  const mover = Math.min(Math.floor((max - min) / 2), c.connectedPlayers);
  if (mover > 0) {
    c.lastMoveAt = now;
    console.log(`[directory] rebalanceo: ${c.coordinatorId} tiene ${max} y el menos cargado ${min} → mueve ${mover} jugador(es)`);
  }
  return mover;
}

// GET /coordinator → { coordinatorId, publicUrl } del coordinador vivo con menos carga.
// Es client-side load balancing: el auth NO proxea tráfico, solo dice a dónde conectarse.
app.get('/coordinator', (req, res) => {
  if (directoryBlocked(res)) return;
  const now  = Date.now();
  // ?exclude=daniela,camilo → el cliente acaba de perder esos coordinadores: aunque sigan en el
  // directorio (hasta 6 s sin heartbeat), no se le devuelven si hay otro vivo. Así se reconecta ya.
  const excluir = String(req.query.exclude || '').toLowerCase().split(',').filter(Boolean);
  const todos = aliveCoordinators();
  const sinExcluidos = todos.filter(c => !excluir.includes(c.coordinatorId.toLowerCase()));
  const candidatos = sinExcluidos.length ? sinExcluidos : todos;
  // Entre los vivos se prefieren los que mandaron heartbeat hace ≤ 3 s (uno recién caído aún no se
  // descarta hasta los 6 s, pero ya no se le asignan jugadores si hay otro sano)
  const frescos = candidatos.filter(c => now - c.lastSeen <= 3000);
  const vivos = frescos.length ? frescos : candidatos;
  if (!vivos.length) {
    console.log('[directory] GET /coordinator → 503 (no hay coordinadores vivos)');
    return fail(res, 503, 'no_coordinators_available', 'No hay coordinadores disponibles en este momento',
      'Enciende al menos un coordinador (npm start en coordinator/) y espera su primer heartbeat (≤ 2 s)');
  }
  let best = null, bestLoad = Infinity;
  for (const c of vivos) {                         // el primero que encuentre gana los empates
    const load = effectiveLoad(c, now);
    if (load < bestLoad) { best = c; bestLoad = load; }
  }
  best.pending.push(now);
  console.log(`[directory] GET /coordinator → ${best.coordinatorId} (carga ${bestLoad}; ` +
    vivos.map(c => `${c.coordinatorId}=${c.connectedPlayers}+${c.pending.length}`).join(' ') + ')');
  res.json({ coordinatorId: best.coordinatorId, publicUrl: best.publicUrl });
});

// GET /coordinator-peers → { peers: [{ coordinatorId, peerUrl }] }  (cada coordinador se filtra a sí mismo)
// (Antes del Taller 7 era GET /peers; ese nombre ahora es para los auth-services, como pide el PDF)
app.get('/coordinator-peers', (_req, res) => {
  if (directoryBlocked(res)) return;
  res.json({ peers: aliveCoordinators().map(c => ({ coordinatorId: c.coordinatorId, peerUrl: c.peerUrl })) });
});

// GET /coordinators → vista de depuración (no está en el PDF)
app.get('/coordinators', (_req, res) => {
  if (directoryBlocked(res)) return;
  const now = Date.now();
  res.json({
    ttlMs: COORDINATOR_TTL_MS,
    coordinators: [...coordinators.values()].map(c => ({
      coordinatorId: c.coordinatorId, publicUrl: c.publicUrl, peerUrl: c.peerUrl,
      connectedPlayers: c.connectedPlayers, pendingAssignments: effectiveLoad(c, now) - c.connectedPlayers,
      uptime: c.uptime, lastSeenMsAgo: now - c.lastSeen, alive: isAlive(c, now),
    })),
  });
});

// ───────── 6c. Cluster de auth-services (Taller 7): un líder, réplicas pasivas ─────────
// single-writer replication: solo el LÍDER acepta escrituras. Las réplicas guardan su propia copia de
// la BD, la mantienen al día con lo que el líder les propaga por WebSocket y, si el líder muere
// (6 s sin heartbeat), eligen uno nuevo entre ellas.
//
// Consistencia (Opción B del PDF): el líder escribe en su log, propaga, espera la confirmación de la
// MAYORÍA de los nodos (él cuenta como uno) y SOLO entonces responde 201 al cliente. Así, si el líder
// muere justo después de responder, el cambio ya está en otro nodo: nunca se pierde una escritura
// que el cliente vio como exitosa. Detalles y justificación en el README.

let leaderId = null, leaderUrl = null;                  // el líder según ESTE nodo
let leaderSeq = 0, leaderHash = null, everHeardLeader = false, logDiverged = false;
let lastLeaderHb = Date.now() - LEADER_TTL_MS + INITIAL_GRACE_MS;   // al arrancar se espera INITIAL_GRACE_MS antes de dudar
let candidate = false, votes = new Set();
let electionAt = 0, electionDeadline = 0, voteGrantedAt = 0, lastHbSent = 0, syncAskedAt = 0;
let noQuorumLogged = false, aheadBeats = 0;

const known = new Map();      // authId → { authId, publicUrl, peerUrl }   todos los nodos que conozco, vivos o no
const peers = new Map();      // authId → { ws, outbound, matchSeq, info }  los que tienen el mesh abierto (con hello hecho)
const connecting = new Set();
const selfUrls = new Set([normUrl(AUTH_PUBLIC_URL)]);   // URLs que resultaron ser la mía
const peerLogged = new Set();
const waiters = [];           // escrituras esperando confirmación de la mayoría

// Tamaño CONFIGURADO del cluster (yo + conocidos + URLs de AUTH_URLS que aún no contestan): solo informativo.
const clusterSize = () => 1 + known.size + SEEDS.filter(u => !selfUrls.has(normUrl(u)) &&
  ![...known.values()].some(k => normUrl(k.publicUrl) === normUrl(u))).length;
// La mayoría se cuenta sobre los nodos ENCENDIDOS y conectados (yo + los que tienen el mesh abierto):
//   solo 1 encendido → mayoría 1 → él solo es el líder (no hace falta esperar a los demás)
//   2 encendidos → mayoría 2 · 3 encendidos → mayoría 2 → ahí sí hay elección entre ellos
const activeSize = () => 1 + peers.size;
const majority  = () => Math.floor(activeSize() / 2) + 1;
const hasQuorum = () => peers.size + 1 >= majority();     // con mayoría "de los encendidos" siempre se cumple
// Si se juntan DOS líderes (p. ej. cada uno estuvo solo y se hizo líder, o se cortó la red), gana el
// que tiene MÁS datos (lastSeq); en empate, el authId menor. El ganador sube su término por encima del
// otro y lo anuncia; el perdedor pasa a réplica y se sincroniza. Así no se pierden escrituras confirmadas.
const soyMejorLider = (otroId, otroSeq) => lastSeq > (Number(otroSeq) || 0) || (lastSeq === (Number(otroSeq) || 0) && AUTH_ID < otroId);
function ganarDuelo(otroId, otroTerm) {
  setTerm(Math.max(term, Number(otroTerm) || 0) + 1, AUTH_ID);
  console.log(`[líder] encontré otro líder (${otroId}); me quedo yo por tener más datos: término ${term}`);
  broadcastPeers({ type: 'new_leader', leader: AUTH_ID, term });
  sendHeartbeats();
}
const leaderFresh = () => role === 'leader' || (leaderId !== null && Date.now() - lastLeaderHb <= LEADER_TTL_MS);

const isUrl = (u) => typeof u === 'string' && u.length <= 300 && /^(https?|wss?):\/\/[^\s/]+/i.test(u);
const sendWs = (ws, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
function broadcastPeers(payload) {
  const raw = JSON.stringify(payload);
  for (const p of peers.values()) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
}

function noQuorum(res) {
  return fail(res, 503, 'no_quorum', 'El líder no alcanza a la mayoría de los auth-services: no puede confirmar escrituras',
    'Enciende otro auth-service y reintenta en unos segundos', { leaderUrl: AUTH_PUBLIC_URL });
}
function replicationTimeout(res, username) {
  return fail(res, 503, 'replication_timeout', `No se pudo confirmar en las réplicas el alta de "${username}"`,
    'Puede que el usuario ya exista (queda en el líder): intenta iniciar sesión; si no, regístralo de nuevo', { leaderUrl: AUTH_PUBLIC_URL });
}

// ── Confirmación por mayoría ──
function ackedCount(seq) {
  let n = 1;                                              // el propio líder
  for (const p of peers.values()) if (p.matchSeq >= seq) n++;
  return n;
}
function checkWaiters() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (ackedCount(waiters[i].seq) >= majority()) {
      clearTimeout(waiters[i].timer);
      waiters[i].resolve(true);
      waiters.splice(i, 1);
    }
  }
}
// Propaga la entrada a las réplicas y espera la mayoría (o ACK_TIMEOUT_MS)
function commitWrite(entry) {
  broadcastPeers({ type: 'write_propagate', term: entry.term, seq: entry.seq, op: entry.op, data: entry.data,
    hash: entry.hash, authId: AUTH_ID });
  if (ackedCount(entry.seq) >= majority()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const w = { seq: entry.seq, resolve, timer: setTimeout(() => {
      waiters.splice(waiters.indexOf(w), 1);
      console.log(`[líder] ✘ la entrada seq ${entry.seq} no recibió confirmación de la mayoría en ${ACK_TIMEOUT_MS / 1000} s`);
      resolve(false);
    }, ACK_TIMEOUT_MS) };
    waiters.push(w);
  });
}

// ── Roles ──
function becomeLeader() {
  role = 'leader'; candidate = false; leaderId = AUTH_ID; leaderUrl = AUTH_PUBLIC_URL; everHeardLeader = true; logDiverged = false;
  const now = Date.now();
  for (const c of coordinators.values()) { c.lastSeen = now; c.pending = []; }   // gracia: los coordinadores tienen 6 s para volver a reportarse
  for (const p of peers.values()) p.matchSeq = 0;
  console.log(`[elección] ✔ ${AUTH_ID} es el LÍDER (término ${term}, seq ${lastSeq}, ${countUsers()} usuarios)`);
  broadcastPeers({ type: 'new_leader', leader: AUTH_ID, term });
  sendHeartbeats();
}
function stepDown(why) {
  if (role !== 'leader') return;
  role = 'replica';
  console.log(`[líder] ${AUTH_ID} deja el liderazgo: ${why}`);
  for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(false); }
}
// Un mensaje de un líder válido (heartbeat, new_leader, write_propagate, hello de un líder)
function acceptLeader(id, t, url) {
  if (t > term) setTerm(t);
  if (role === 'leader' && id !== AUTH_ID) stepDown(`${id} es líder en el término ${t}`);
  candidate = false; electionAt = 0;
  if (leaderId !== id) console.log(`[líder] ${id} es el líder (término ${term})`);
  leaderId = id;
  leaderUrl = (known.get(id) || {}).publicUrl || url || leaderUrl;
  lastLeaderHb = Date.now(); everHeardLeader = true;
}

// ── Heartbeat del líder (cada 2 s a todas las réplicas): trae la punta del log, la duración de la
//    sesión y una copia del directorio de coordinadores (para que una réplica que llegue a líder no empiece de cero) ──
function sendHeartbeats(onlyTo) {
  if (role !== 'leader') return;
  lastHbSent = Date.now();
  const now = lastHbSent;
  const msg = { type: 'heartbeat', authId: AUTH_ID, term, lastSeq, lastHash, publicUrl: AUTH_PUBLIC_URL, peerUrl: AUTH_PEER_URL,
    session: { label: session.label, seconds: session.seconds, updatedAt: session.updatedAt },
    directory: aliveCoordinators().map(c => ({ coordinatorId: c.coordinatorId, publicUrl: c.publicUrl, peerUrl: c.peerUrl,
      connectedPlayers: c.connectedPlayers, uptime: c.uptime })) };
  if (onlyTo) return sendWs(onlyTo, msg);
  broadcastPeers(msg);
}
// Réplica: copia el directorio del líder (todos los que él daba por vivos, lo están "ahora" a efectos de servir)
function adoptDirectory(list) {
  const now = Date.now();
  const old = new Map(coordinators);
  coordinators.clear();
  for (const c of list) {
    if (!c || typeof c.coordinatorId !== 'string' || !isUrl(c.publicUrl) || !isUrl(c.peerUrl)) continue;
    const key = c.coordinatorId.toLowerCase();
    coordinators.set(key, { coordinatorId: c.coordinatorId, publicUrl: c.publicUrl, peerUrl: c.peerUrl,
      connectedPlayers: Number(c.connectedPlayers) || 0, uptime: Number(c.uptime) || 0, lastSeen: now,
      pending: old.has(key) ? old.get(key).pending : [], lastMoveAt: 0 });
  }
}
// El directorio solo se sirve si hay un líder vigente (o si soy yo): sin líder la copia podría estar vieja
function directoryBlocked(res) {
  if (role === 'leader' || leaderFresh()) return false;
  redirectToLeader(res);
  return true;
}

// ── Sincronización (réplica → líder) ──
function requestSync(ws, force) {
  const now = Date.now();
  if (!force && now - syncAskedAt < 3000) return;
  syncAskedAt = now;
  console.log(`[réplica] pide sincronización al líder: tengo seq ${lastSeq}`);
  sendWs(ws, { type: 'request_sync', fromSeq: lastSeq, lastHash });
}

// ── Elección ──
// Turnos escalonados para que dos réplicas no se postulen a la vez (votos divididos = otra ronda de
// 3 s). Entre los nodos que veo conectados (sin el líder caído), el de authId menor espera ~0.2 s,
// el siguiente ~1.7 s, etc. Si el primero no puede ganar (log atrasado), el siguiente lo intenta en su turno.
// La espera se cumple con su propio temporizador (no con el ciclo de 500 ms, que las igualaba).
let electionTimer = null;
function electionDelay(base) {
  const ids  = [AUTH_ID, ...[...peers.keys()].filter(id => id !== leaderId)].sort();
  const rank = Math.max(0, ids.indexOf(AUTH_ID));
  return base + rank * ELECTION_STAGGER_MS + Math.random() * ELECTION_JITTER_MS;
}
function scheduleElectionCheck(at) {
  clearTimeout(electionTimer);
  electionTimer = setTimeout(() => maybeStartElection(Date.now()), Math.max(0, at - Date.now()) + 5);
}
function maybeStartElection(now) {
  if (role === 'leader') return;
  if (candidate) {                                         // ya hay una elección en marcha: ¿se venció?
    if (now > electionDeadline) { candidate = false; electionAt = now + electionDelay(300); scheduleElectionCheck(electionAt); }
    return;
  }
  if (now - voteGrantedAt < ELECTION_TIMEOUT_MS) return;   // acabo de votar por otro: le doy tiempo
  if (now - lastLeaderHb <= LEADER_TTL_MS) { electionAt = 0; noQuorumLogged = false; return; }   // oí a un líder hace poco
  if (!electionAt) {                                       // silencio: el líder murió o todavía no hay ninguno
    electionAt = now + electionDelay(200);
    scheduleElectionCheck(electionAt);
    console.log(leaderId
      ? `[elección] ${leaderId} no da heartbeat hace ${((now - lastLeaderHb) / 1000).toFixed(1)} s: se inicia una elección (espera aleatoria de ${((electionAt - now) / 1000).toFixed(1)} s)`
      : `[elección] no hay líder: se inicia una elección (espera aleatoria de ${((electionAt - now) / 1000).toFixed(1)} s)`);
  }
  if (now < electionAt) return;
  if (!hasQuorum()) {                                      // sin mayoría conectada no tiene sentido subir el término
    if (!noQuorumLogged) { noQuorumLogged = true;
      console.log(`[elección] sin líder y sin mayoría: veo ${peers.size + 1} de ${clusterSize()} nodos (hacen falta ${majority()}). Espero a que vuelvan`); }
    electionAt = now + 1000;
    return;
  }
  startElection();
}
function startElection() {
  noQuorumLogged = false;
  setTerm(term + 1, AUTH_ID);                              // voto por mí en el término nuevo
  candidate = true; votes = new Set([AUTH_ID]); electionDeadline = Date.now() + ELECTION_TIMEOUT_MS;
  leaderId = null;
  console.log(`[elección] ${AUTH_ID} se postula en el término ${term} (seq ${lastSeq}); necesita ${majority()} de ${clusterSize()} votos`);
  broadcastPeers({ type: 'election', candidate: AUTH_ID, term, lastSeq, lastTerm: lastLogTerm });
  if (votes.size >= majority()) becomeLeader();            // cluster de uno solo
}
function handleElection(ws, msg) {
  const from = ws.peerId;
  const deny = () => sendWs(ws, { type: 'vote', voter: AUTH_ID, term, voteGranted: false });
  if (!Number.isInteger(msg.term)) return;
  if (msg.term < term) return deny();
  // Si oigo a un líder vivo, no apoyo a nadie más (así un nodo suelto no tumba a un líder sano)
  if ((role === 'leader' || leaderFresh()) && msg.candidate !== leaderId) return deny();
  if (msg.term > term) {
    if (role === 'leader') stepDown(`${from} pidió votos en el término ${msg.term}`);
    candidate = false;
    setTerm(msg.term);
  }
  // Solo se vota por quien tiene un log al menos tan completo como el mío
  const theirTerm = Number(msg.lastTerm) || 0, theirSeq = Number(msg.lastSeq) || 0;
  const upToDate = theirTerm > lastLogTerm || (theirTerm === lastLogTerm && theirSeq >= lastSeq);
  const grant = upToDate && (votedFor === null || votedFor === from);
  if (grant) {
    setTerm(term, from);
    voteGrantedAt = Date.now(); electionAt = 0;
    console.log(`[elección] voto por ${from} en el término ${term}`);
  } else {
    console.log(`[elección] niego el voto a ${from} (término ${msg.term}): ${!upToDate ? 'su log está más atrasado que el mío' : `ya voté por ${votedFor}`}`);
  }
  sendWs(ws, { type: 'vote', voter: AUTH_ID, term, voteGranted: grant });
}

// ── Mensajes del mesh ──
function handlePeerMessage(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  const from = ws.peerId;
  const peer = peers.get(from);
  switch (msg.type) {
    case 'heartbeat': {
      if (!Number.isInteger(msg.term)) return;
      if (role === 'leader') {                                               // dos líderes a la vez: decide quién tiene más datos
        if (soyMejorLider(from, msg.lastSeq)) { if (msg.term >= term) ganarDuelo(from, msg.term); return; }
        if (msg.term <= term) return;                                        // él gana: espero a que suba su término
      }
      if (msg.term < term) return;                                           // líder viejo: se ignora
      acceptLeader(from, msg.term, msg.publicUrl);
      leaderSeq = Number(msg.lastSeq) || 0; leaderHash = msg.lastHash || null;
      adoptSession(msg.session);
      if (Array.isArray(msg.directory)) adoptDirectory(msg.directory);
      // ¿Estoy al día? Atrasada, o mi log ya no es prefijo del suyo (hash distinto en el mismo seq)
      if (leaderSeq > lastSeq) {                                              // atrasada: el líder decide qué mandarme
        logDiverged = false; aheadBeats = 0;
        requestSync(ws, false);
      } else {
        // Igual o por delante del líder. Por delante solo es normal un instante (me llegó una escritura
        // después de su heartbeat). Si esas entradas son de un término ANTERIOR, el líder actual nunca las tuvo:
        // eran de un líder viejo que no alcanzó a replicarlas → hay que descartarlas.
        // Si el término no basta para saberlo (p. ej. una BD que se usó sola y también estaba en el término 1),
        // se mira si sigue por delante en dos heartbeats SEGUIDOS: lo normal es que el líder me alcance en el siguiente.
        aheadBeats = lastSeq > leaderSeq ? aheadBeats + 1 : 0;
        logDiverged = hashAt(leaderSeq) !== msg.lastHash || (lastSeq > leaderSeq && (lastLogTerm < msg.term || aheadBeats >= 2));
        if (logDiverged) requestSync(ws, false);
      }
      sendWs(ws, { type: 'heartbeat_ack', authId: AUTH_ID, term, lastSeq, lastHash });
      return;
    }
    case 'heartbeat_ack':
    case 'write_ack': {
      if (role !== 'leader' || !peer) return;
      const seq = Number(msg.type === 'write_ack' ? msg.seq : msg.lastSeq);
      if (!Number.isInteger(seq) || seq < 0) return;
      // Cuenta solo si su log coincide con el mío hasta ese seq (mismo hash); si no, tiene otra historia
      peer.matchSeq = (seq <= lastSeq && hashAt(seq) === msg.lastHash) ? seq : 0;
      checkWaiters();
      return;
    }
    case 'write_propagate': {
      if (!Number.isInteger(msg.term) || msg.term < term) return;
      if (role === 'leader') return;
      acceptLeader(from, msg.term, null);
      const e = { seq: msg.seq, term: msg.term, op: msg.op, data: msg.data, hash: msg.hash };
      if (Number.isInteger(e.seq) && e.seq <= lastSeq) {                      // ya tengo ese seq: ¿es la MISMA entrada?
        if (hashAt(e.seq) !== e.hash) return requestSync(ws, true);           // no: mi log es de otra historia
        return sendWs(ws, { type: 'write_ack', authId: AUTH_ID, term, seq: lastSeq, lastHash });
      }
      if (e.seq !== lastSeq + 1) return requestSync(ws, false);               // se perdió alguna: pide lo que falta
      try {
        applyEntry(e);
        leaderSeq = Math.max(leaderSeq, lastSeq); logDiverged = false;
        console.log(`[réplica] aplicada seq ${lastSeq} (${e.op} ${e.data.username}). Usuarios: ${countUsers()}`);
        sendWs(ws, { type: 'write_ack', authId: AUTH_ID, term, seq: lastSeq, lastHash });
      } catch (err) {
        console.log(`[réplica] no pude aplicar seq ${e.seq}: ${err.message}`);
        requestSync(ws, true);
      }
      return;
    }
    case 'request_sync': {
      if (role !== 'leader') return;
      const from0 = Number(msg.fromSeq);
      if (!Number.isInteger(from0) || from0 < 0) return;
      // La réplica solo recibe lo que le falta si su log es un prefijo del mío (mismo hash en fromSeq).
      // Si no (BD de otra historia, o líder viejo con escrituras que no llegaron a la mayoría), se le manda todo de nuevo.
      const prefixOk = from0 <= lastSeq && (from0 === 0 || hashAt(from0) === msg.lastHash);
      const entries = prefixOk ? entriesSince(from0) : entriesSince(0);
      console.log(`[líder] sync para ${from}: ${prefixOk ? `${entries.length} entrada(s) desde seq ${from0}` : `su log no coincide con el mío: se reenvía todo (${entries.length} entradas)`}`);
      sendWs(ws, { type: 'sync_response', reset: !prefixOk, entries, leaderSeq: lastSeq });
      return;
    }
    case 'sync_response': {
      if (role === 'leader' || from !== leaderId || !Array.isArray(msg.entries)) return;
      try {
        if (msg.reset) {
          console.log(`[réplica] ${from} tiene otra historia: se reconstruye la BD local con ${msg.entries.length} entradas`);
          resetFromLeader(msg.entries);
        } else {
          for (const e of msg.entries) if (e.seq > lastSeq) applyEntry(e);
        }
        leaderSeq = Math.max(leaderSeq, Number(msg.leaderSeq) || 0, lastSeq); logDiverged = false;
        console.log(`[réplica] sincronizada con ${from}: seq ${lastSeq}, ${countUsers()} usuarios`);
        sendWs(ws, { type: 'write_ack', authId: AUTH_ID, term, seq: lastSeq, lastHash });
      } catch (err) {
        console.log(`[réplica] falló la sincronización: ${err.message}`);
        syncAskedAt = 0;
      }
      return;
    }
    case 'election':
      return handleElection(ws, msg);
    case 'vote': {
      if (!Number.isInteger(msg.term)) return;
      if (msg.term > term) { setTerm(msg.term); candidate = false; return; }
      if (candidate && msg.term === term && msg.voteGranted === true) {
        votes.add(from);
        console.log(`[elección] voto de ${from}: ${votes.size}/${majority()}`);
        if (votes.size >= majority()) becomeLeader();
      }
      return;
    }
    case 'new_leader': {
      if (!Number.isInteger(msg.term) || msg.term < term || msg.leader !== from) return;
      acceptLeader(from, msg.term, null);
      return;
    }
    default:
      return;
  }
}

// ── Conexiones del mesh: UNA por par; la inicia el authId menor (lexicográfico) ──
function helloMsg() {
  return { type: 'hello', authId: AUTH_ID, role, term, publicUrl: AUTH_PUBLIC_URL, peerUrl: AUTH_PEER_URL, lastSeq,
    ...(MESH_SECRET ? { secret: MESH_SECRET } : {}) };
}
function upsertKnown(id, publicUrl, peerUrl) {
  if (id === AUTH_ID || !/^[\w.-]{1,64}$/.test(id) || !isUrl(publicUrl) || !isUrl(peerUrl)) return;
  const prev = known.get(id);
  known.set(id, { authId: id, publicUrl: publicUrl.replace(/\/+$/, ''), peerUrl });
  if (!prev) console.log(`[cluster] nodo conocido: ${id} (${publicUrl}). Cluster de ${clusterSize()}, mayoría = ${majority()}`);
}

function handleHello(ws, msg) {
  const id = msg.authId;
  const reject = (why) => { console.log(`[mesh] hello rechazado (${why})`); ws.duplicate = true; ws.close(CLOSE_PEER_REJECTED, why); };
  if (typeof id !== 'string' || !/^[\w.-]{1,64}$/.test(id)) return reject('authId inválido');
  if (id === AUTH_ID) return reject('es mi propio id (¿dos nodos con el mismo nombre?)');
  if (MESH_SECRET && msg.secret !== MESH_SECRET) return reject('secreto del mesh incorrecto');

  const existing = peers.get(id);
  if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
    const validaEsSaliente = AUTH_ID < id;                  // si mi id es menor, la válida es la que yo inicié
    if (ws.outbound !== validaEsSaliente) {
      console.log(`[mesh] conexión duplicada con ${id}: se cierra la nueva`);
      ws.duplicate = true;
      return ws.close(CLOSE_PEER_REJECTED, 'duplicate connection');
    }
    console.log(`[mesh] ${id} se reconectó: se reemplaza la conexión anterior`);
    existing.ws.duplicate = true;
    existing.ws.close(CLOSE_PEER_REJECTED, 'replaced');
  }

  ws.peerId = id;
  upsertKnown(id, msg.publicUrl, msg.peerUrl);
  peers.set(id, { ws, outbound: ws.outbound, matchSeq: 0, info: { role: msg.role, term: msg.term, lastSeq: msg.lastSeq } });
  peerLogged.delete(id);
  console.log(`[mesh] ✔ conectado con ${id} (${ws.outbound ? 'yo inicié' : 'él inició'}). Mesh: ${[...peers.keys()].join(', ')}`);

  if (msg.role === 'leader' && Number.isInteger(msg.term)) {
    if (role === 'leader') {                                 // nos encontramos dos líderes
      if (soyMejorLider(id, msg.lastSeq)) ganarDuelo(id, msg.term);
      else if (msg.term > term) acceptLeader(id, msg.term, msg.publicUrl);
    } else if (msg.term >= term) acceptLeader(id, msg.term, msg.publicUrl);
  }
  if (role === 'leader') sendHeartbeats(ws);                // que el recién llegado me conozca y se sincronice ya
  checkWaiters();
}

function setupPeer(ws, outbound) {
  ws.outbound = outbound; ws.peerId = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  if (outbound) ws.on('open', () => sendWs(ws, helloMsg())); else sendWs(ws, helloMsg());
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!ws.peerId) {                                       // el primer mensaje DEBE ser hello
      if (ws.duplicate) return;
      if (msg && msg.type === 'hello') return handleHello(ws, msg);
      ws.duplicate = true;
      return ws.close(CLOSE_PEER_REJECTED, 'hello expected');
    }
    handlePeerMessage(ws, msg);
  });
  ws.on('close', () => {
    if (ws.peerId && peers.get(ws.peerId)?.ws === ws) {
      peers.delete(ws.peerId);
      console.log(`[mesh] ✘ se perdió ${ws.peerId}. Mesh: ${[...peers.keys()].join(', ') || '(ninguno)'}`);
    }
  });
  ws.on('error', () => {});
}

const peerWss = new WebSocketServer({ noServer: true });
peerWss.on('connection', (ws) => setupPeer(ws, false));

function connectPeer(id, url) {
  connecting.add(id);
  const ws = new WebSocket(url, { handshakeTimeout: 4000, headers: { 'ngrok-skip-browser-warning': 'true' } });
  setupPeer(ws, true);
  ws.on('error', (err) => {
    if (!peerLogged.has(id)) { peerLogged.add(id); console.log(`[mesh] no se pudo conectar con ${id} (${url}): ${err.message}. Se reintenta`); }
  });
  ws.on('close', () => connecting.delete(id));
}

// ── Descubrimiento: cada DISCOVERY_MS se pregunta GET /peers a los nodos de AUTH_URLS y a los ya conocidos ──
async function discoverNodes() {
  const urls = new Set(SEEDS);
  for (const k of known.values()) if (!selfUrls.has(normUrl(k.publicUrl))) urls.add(k.publicUrl);
  await Promise.all([...urls].map(async (url) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const res = await fetch(`${url}/peers`, { headers: { 'ngrok-skip-browser-warning': 'true' }, signal: ctl.signal });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.peers)) return;
      for (const p of data.peers) {
        if (!p || typeof p.authId !== 'string') continue;
        if (p.self === true && p.authId === AUTH_ID) selfUrls.add(normUrl(url));   // esa URL era la mía
        else upsertKnown(p.authId, p.publicUrl, p.peerUrl);
      }
    } catch { /* ese nodo no responde: se reintenta en el siguiente ciclo */ }
    finally { clearTimeout(timer); }
  }));
  for (const [id, k] of known) {                            // el authId menor inicia la conexión
    if (AUTH_ID < id && !peers.has(id) && !connecting.has(id)) connectPeer(id, k.peerUrl);
  }
}

// ── Reloj del cluster ──
function clusterTick() {
  const now = Date.now();
  if (role === 'leader') { if (now - lastHbSent >= LEADER_HB_MS) sendHeartbeats(); return; }
  maybeStartElection(now);
}
setInterval(clusterTick, 500);
setInterval(discoverNodes, DISCOVERY_MS);
setInterval(() => {                                         // peers congelados (sin "close"): ping/pong de protocolo
  for (const { ws } of peers.values()) {
    if (!ws.isAlive) { console.log(`[mesh] ${ws.peerId} no responde al ping: se termina la conexión`); ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, PEER_PING_MS);

// ── GET /status y GET /peers (los pide el PDF) ──
const roleOf = (id) => (id === AUTH_ID ? role : (id === leaderId && leaderFresh() ? 'leader' : 'replica'));
app.get('/status', (_req, res) => res.json({
  authId: AUTH_ID,
  role,
  publicUrl: AUTH_PUBLIC_URL,
  peerUrl: AUTH_PEER_URL,
  leaderUrl: role === 'leader' ? AUTH_PUBLIC_URL : (leaderFresh() ? leaderUrl : null),
  knownPeers: [...known.keys()],
  lastAppliedSeq: lastSeq,
  users: countUsers(),
  // Extras para depurar y para la demo
  term,
  leaderId: role === 'leader' ? AUTH_ID : (leaderFresh() ? leaderId : null),
  electing: role !== 'leader' && !leaderFresh(),
  connectedPeers: [...peers.keys()],
  clusterSize: clusterSize(),
  quorum: majority(),
  lag: role === 'leader' ? 0 : Math.max(0, leaderSeq - lastSeq),
  replicas: role === 'leader' ? [...peers.entries()].map(([id, p]) => ({ authId: id, matchSeq: p.matchSeq })) : undefined,
  sessionDuration: session.label,
}));

app.get('/peers', (_req, res) => res.json({
  peers: [
    { authId: AUTH_ID, publicUrl: AUTH_PUBLIC_URL, peerUrl: AUTH_PEER_URL, role, self: true, connected: true },
    ...[...known.values()].map(k => ({ authId: k.authId, publicUrl: k.publicUrl, peerUrl: k.peerUrl,
      role: roleOf(k.authId), connected: peers.has(k.authId) })),
  ],
}));

// ───────── 7. Rutas inexistentes y errores ─────────
app.use((req, res) => {
  fail(res, 404, 'not_found', `No existe ${req.method} ${req.path}`,
    'Endpoints disponibles: POST /register, POST /login, POST /auth/google, POST /refresh, POST /heartbeat, GET /coordinator, GET /coordinator-peers, GET /coordinators, GET /status, GET /peers, GET /auth/google/config, GET /session-policy, GET /health');
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return fail(res, 400, 'invalid_json', 'El body no es un JSON válido', `Ejemplo: ${BODY_EJEMPLO}`);
  }
  if (err.type === 'entity.too.large') {
    return fail(res, 413, 'body_too_large', 'El body supera 4 KB', 'Envía solo los campos necesarios');
  }
  console.error('[error]', err.message);
  fail(res, 500, 'internal', 'Error interno del servidor', 'Intenta de nuevo en unos segundos');
});

// Un solo servidor para HTTP y para el mesh: /peer = otros auth-services (WebSocket), el resto = HTTP
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] === '/peer') peerWss.handleUpgrade(req, socket, head, (ws) => peerWss.emit('connection', ws, req));
  else socket.destroy();
});

// Un auth sin compañeros (AUTH_URLS vacío) es su propio líder desde el primer segundo, como antes del Taller 7
if (clusterSize() === 1) {
  setTerm(Math.max(term, 0) + 1, AUTH_ID);
  becomeLeader();
}

server.listen(PORT, () => {
  console.log(`[${AUTH_ID}] Auth service en puerto ${PORT} (${AUTH_PUBLIC_URL}) · tokens de ${session.label} · base ${path.basename(DB_PATH)}`);
  console.log(`[${AUTH_ID}] ${role === 'leader' ? 'LÍDER (cluster de un solo nodo)' : `réplica hasta que haya líder`} · término ${term} · seq ${lastSeq} · ${countUsers()} usuarios`);
  if (SEEDS.length) console.log(`[${AUTH_ID}] Mesh por la misma URL: ${AUTH_PEER_URL} · buscando a: ${SEEDS.join(', ')}`);
  discoverNodes();
});

// Ctrl+C: cierra limpio. Las réplicas lo notan a los 6 s sin heartbeat y eligen líder.
function shutdown() {
  console.log(`\n[${AUTH_ID}] Apagando…`);
  for (const { ws } of peers.values()) ws.close(1001, 'auth going away');
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);