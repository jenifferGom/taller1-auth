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

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET falta o tiene menos de 32 caracteres. Genera uno con:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
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

// watchFile revisa el archivo cada segundo; es más confiable que fs.watch en Windows y OneDrive
fs.watchFile(ENV_PATH, { interval: 1000 }, () => {
  try {
    const vars = dotenv.parse(fs.readFileSync(ENV_PATH));
    applyExpiresIn(vars.JWT_EXPIRES_IN, 'archivo');
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
function fail(res, status, error, message, hint) {
  return res.status(status).json({ error, message, hint });
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
app.use(cors());                                // el cliente vive en otro origen (otro túnel ngrok)
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
    'GET /peers':          'Directory: coordinadores vivos para formar el mesh → {peers:[{coordinatorId, peerUrl}]}',
    'GET /coordinators':   'Directory (depuración): todos los coordinadores vivos con su carga',
    'GET /health':         'Estado del servicio',
  },
}));

app.get('/health', (_req, res) => res.json({ status: 'ok', message: 'auth-service funcionando' }));

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

// POST /refresh { token } → 200 { token, username, expiresIn }
// Si la duración de la sesión AUMENTÓ (por ejemplo de 5m a 1h), los jugadores conectados
// tienen tokens más cortos. El exp va firmado y no se puede cambiar, así que se emite uno
// nuevo con la duración vigente. Solo se permite si el token sigue válido y se emitió con
// una duración MENOR a la actual: así no sirve para alargar una sesión indefinidamente.
app.post('/refresh', (req, res) => {
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
  if (!user) return fail(res, 401, 'invalid_token', 'El usuario ya no existe', 'Inicia sesión de nuevo');

  console.log(`[refresh] ${user.username}: token renovado (${session.label})`);
  return res.json({ token: emitToken(user), username: user.username, provider: user.provider,
    expiresIn: session.label, message: `Sesión renovada: ahora dura ${session.label}` });
});

// POST /register  →  201 { userId, username, message } | 400 | 409
app.post('/register', async (req, res) => {
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
    const info = stmts.insertLocal.run(username, hash);
    console.log(`[register] usuario local creado: ${username}`);
    return res.status(201).json({
      userId: String(info.lastInsertRowid),
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
  const bad = checkBody(req.body);
  if (bad) return fail(res, 400, ...bad);

  const { username, password } = req.body;
  try {
    const user = stmts.findByUsername.get(username);

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

    // 5. Crear el usuario de Google en la MISMA tabla users
    const info = stmts.insertGoogle.run(username, googleSub, email);
    const newUser = { id: info.lastInsertRowid, username, provider: 'google' };
    console.log(`[google] usuario creado: ${username} (${email})`);
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

// GET /peers → { peers: [{ coordinatorId, peerUrl }] }  (cada coordinador se filtra a sí mismo)
app.get('/peers', (_req, res) => {
  res.json({ peers: aliveCoordinators().map(c => ({ coordinatorId: c.coordinatorId, peerUrl: c.peerUrl })) });
});

// GET /coordinators → vista de depuración (no está en el PDF)
app.get('/coordinators', (_req, res) => {
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

// ───────── 7. Rutas inexistentes y errores ─────────
app.use((req, res) => {
  fail(res, 404, 'not_found', `No existe ${req.method} ${req.path}`,
    'Endpoints disponibles: POST /register, POST /login, POST /auth/google, POST /refresh, POST /heartbeat, GET /coordinator, GET /peers, GET /coordinators, GET /auth/google/config, GET /session-policy, GET /health');
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

app.listen(PORT, () => {
  console.log(`Auth service en puerto ${PORT} (tokens de ${session.label}, base ${path.basename(DB_PATH)})`);
});