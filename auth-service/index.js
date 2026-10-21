require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const Database = require('better-sqlite3');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');

// ───────── configuración (todo por variables de entorno) ─────────
const PORT           = parseInt(process.env.PORT, 10) || 4000;
const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const BCRYPT_ROUNDS  = Math.max(10, parseInt(process.env.BCRYPT_ROUNDS, 10) || 10); // mínimo 10
const DB_PATH        = process.env.DB_PATH || 'users.db';

if (!JWT_SECRET) { console.error('JWT_SECRET no definido'); process.exit(1); }

// ───────── base de datos ─────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
const findUser   = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');
const insertUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');

// Hash falso: se compara igual cuando el usuario no existe para que el tiempo de
// respuesta no revele qué usuarios están registrados.
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_ROUNDS);

// ───────── validación ─────────
function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string')
    return 'username y password deben ser texto';
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username))
    return 'username inválido: 3 a 32 caracteres (letras, números o _)';
  if (password.length < 6 || Buffer.byteLength(password) > 72)
    return 'password inválida: mínimo 6 caracteres y máximo 72 bytes';
  return null;
}

// ───────── app ─────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));

app.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  const err = validateCredentials(username, password);
  if (err) return res.status(400).json({ error: err });

  if (findUser.get(username)) return res.status(409).json({ error: 'El usuario ya existe' });

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const info = insertUser.run(username, hash);
    console.log(`[register] usuario creado: ${username}`);
    return res.status(201).json({ userId: String(info.lastInsertRowid), username });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'El usuario ya existe' });
    console.error('[register] error interno:', e.message);
    return res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password)
    return res.status(400).json({ error: 'Se requieren username y password' });

  try {
    const user = findUser.get(username);
    const ok   = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign(
      { userId: String(user.id), username: user.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }          // agrega iat y exp automáticamente
    );
    console.log(`[login] ${user.username}`);
    return res.status(200).json({ token, username: user.username });
  } catch (e) {
    console.error('[login] error interno:', e.message);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ───────── registro simple de coordinadores (lo usa el coordinador del juego) ─────────
const coordinators = new Map();

app.post('/heartbeat', (req, res) => {
  const { coordinatorId, publicUrl, peerUrl } = req.body || {};
  if (typeof coordinatorId !== 'string' || !coordinatorId) return res.status(400).json({ error: 'coordinatorId requerido' });
  coordinators.set(coordinatorId, {
    coordinatorId,
    publicUrl: String(publicUrl || ''), peerUrl: String(peerUrl || ''), lastSeen: Date.now(),
  });
  res.json({ ok: true });
});

app.get('/coordinator-peers', (_req, res) => {
  const now = Date.now();
  for (const [id, c] of coordinators) if (now - c.lastSeen > 10000) coordinators.delete(id);
  res.json({ peers: Array.from(coordinators.values()).map(({ coordinatorId, publicUrl, peerUrl }) => ({ coordinatorId, publicUrl, peerUrl })) });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ───────── errores ─────────
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError)
    return res.status(400).json({ error: 'JSON inválido' });
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Error interno' });
});

app.listen(PORT, () => console.log(`Auth service en puerto ${PORT}`));