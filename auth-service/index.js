require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { DatabaseSync } = require('node:sqlite');   // SQLite incluido en Node 22.5+ (no hay que compilar nada)
const bcrypt   = require('bcryptjs');                // bcrypt en JavaScript puro (mismo algoritmo y formato de hash)
const jwt      = require('jsonwebtoken');

// ───────── 1. Configuración (todo por variables de entorno, nada hardcodeado) ─────────
const PORT           = parseInt(process.env.PORT, 10) || 4000;
const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';   // en la sustentación: 30s
const BCRYPT_ROUNDS  = Math.max(10, parseInt(process.env.BCRYPT_ROUNDS, 10) || 10); // mínimo 10
const DB_PATH        = process.env.DB_PATH || 'users.db';

if (!JWT_SECRET) {
  console.error('Falta JWT_SECRET en el .env (copia .env.example como .env y llénalo)');
  process.exit(1);
}

// ───────── 2. Base de datos SQLite (propia de este servicio) ─────────
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
// Consultas preparadas: evitan inyección SQL
const findUser   = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');
const insertUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');

// Hash "señuelo": si el usuario no existe igual se ejecuta un bcrypt.compare,
// así el tiempo de respuesta no revela qué usuarios están registrados.
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_ROUNDS);

// ───────── 3. Formato único de respuestas ─────────
// Éxito: los campos que pide el enunciado + "message".
// Error: { error: CÓDIGO, message: qué pasó, hint: cómo solucionarlo }.
function fail(res, status, error, message, hint) {
  return res.status(status).json({ error, message, hint });
}

const BODY_EJEMPLO = '{"username":"alice","password":"secret123"}';

// Revisa que el body tenga username y password como texto. Devuelve un error o null.
function checkBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['MISSING_BODY', 'La petición no trae un body JSON',
      `Envía el header "Content-Type: application/json" y un body como ${BODY_EJEMPLO}`];
  }
  const faltan = ['username', 'password'].filter(k => typeof body[k] !== 'string' || body[k] === '');
  if (faltan.length) {
    return ['MISSING_FIELDS', `Falta o no es texto: ${faltan.join(' y ')}`,
      `El body debe ser como ${BODY_EJEMPLO}`];
  }
  return null;
}

// Reglas extra que solo aplican al registrar
function checkNewCredentials(username, password) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return ['INVALID_USERNAME', `El username "${username}" no es válido`,
      'Usa de 3 a 20 caracteres: letras sin tildes, números o guion bajo (_)'];
  }
  if (password.length < 6) {
    return ['INVALID_PASSWORD', 'La contraseña es demasiado corta', 'Usa mínimo 6 caracteres'];
  }
  if (Buffer.byteLength(password) > 72) {                   // bcrypt solo usa 72 bytes
    return ['INVALID_PASSWORD', 'La contraseña es demasiado larga', 'Usa máximo 72 caracteres'];
  }
  return null;
}

// ───────── 4. App ─────────
const app = express();
app.use(cors());                                // el cliente vive en otro origen (otro túnel ngrok)
app.use(express.json({ limit: '10kb' }));

// Información del servicio (útil para probar que el túnel de ngrok responde)
app.get('/', (_req, res) => res.json({
  service: 'auth-service',
  message: 'Servicio de autenticación en línea',
  endpoints: {
    'POST /register': `Crea un usuario. Body: ${BODY_EJEMPLO}`,
    'POST /login':    `Devuelve un JWT válido por ${JWT_EXPIRES_IN}. Body: ${BODY_EJEMPLO}`,
    'GET /health':    'Estado del servicio',
  },
}));

app.get('/health', (_req, res) => res.json({ status: 'ok', message: 'auth-service funcionando' }));

// POST /register  →  201 { userId, username, message } | 400 | 409
app.post('/register', async (req, res) => {
  const bad = checkBody(req.body) || checkNewCredentials(req.body.username, req.body.password);
  if (bad) return fail(res, 400, ...bad);

  const { username, password } = req.body;
  if (findUser.get(username)) {
    return fail(res, 409, 'USERNAME_TAKEN', `El usuario "${username}" ya existe`,
      'Elige otro username, o inicia sesión con POST /login si la cuenta es tuya');
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const info = insertUser.run(username, hash);
    console.log(`[register] usuario creado: ${username}`);          // nunca se loguea la contraseña
    return res.status(201).json({
      userId: String(info.lastInsertRowid),
      username,
      message: `Usuario "${username}" registrado. Ahora inicia sesión con POST /login`,
    });
  } catch (e) {
    // Carrera: dos registros simultáneos con el mismo nombre
    if (/UNIQUE constraint failed/.test(e.message)) {
      return fail(res, 409, 'USERNAME_TAKEN', `El usuario "${username}" ya existe`, 'Elige otro username');
    }
    console.error('[register] error interno:', e.message);
    return fail(res, 500, 'INTERNAL_ERROR', 'No se pudo registrar el usuario', 'Intenta de nuevo en unos segundos');
  }
});

// POST /login  →  200 { token, username, expiresIn, message } | 400 | 401
app.post('/login', async (req, res) => {
  const bad = checkBody(req.body);
  if (bad) return fail(res, 400, ...bad);

  const { username, password } = req.body;
  try {
    const user = findUser.get(username);
    const ok   = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    // Mismo mensaje si el usuario no existe o si la contraseña está mal: no filtramos información
    if (!user || !ok) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Credenciales inválidas: usuario o contraseña incorrectos',
        'Revisa los datos. Si no tienes cuenta, créala con POST /register');
    }

    const token = jwt.sign(
      { userId: String(user.id), username: user.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }        // jsonwebtoken agrega iat y exp automáticamente
    );
    console.log(`[login] ${user.username} (token expira en ${JWT_EXPIRES_IN})`);
    return res.status(200).json({
      token,
      username: user.username,
      expiresIn: JWT_EXPIRES_IN,
      message: `Bienvenido, ${user.username}. Usa el token para conectarte al coordinador: /connect?token=...`,
    });
  } catch (e) {
    console.error('[login] error interno:', e.message);
    return fail(res, 500, 'INTERNAL_ERROR', 'No se pudo iniciar sesión', 'Intenta de nuevo en unos segundos');
  }
});

// ───────── 5. Rutas inexistentes y errores ─────────
app.use((req, res) => {
  fail(res, 404, 'NOT_FOUND', `No existe ${req.method} ${req.path}`,
    'Endpoints disponibles: POST /register, POST /login, GET /health');
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return fail(res, 400, 'INVALID_JSON', 'El body no es un JSON válido',
      `Revisa comillas y llaves. Ejemplo: ${BODY_EJEMPLO}`);
  }
  if (err.type === 'entity.too.large') {
    return fail(res, 413, 'BODY_TOO_LARGE', 'El body supera 10 KB', 'Envía solo username y password');
  }
  console.error('[error]', err.message);
  fail(res, 500, 'INTERNAL_ERROR', 'Error interno del servidor', 'Intenta de nuevo en unos segundos');
});

app.listen(PORT, () => {
  console.log(`Auth service en puerto ${PORT} (tokens de ${JWT_EXPIRES_IN})`);
});
