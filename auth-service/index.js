require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  console.error('Falta JWT_SECRET en el archivo .env');
  process.exit(1);
}

const db = new Database('users.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

const app = express();
app.use(cors());
app.use(express.json());

function bodyValido(body) {
  return (
    body &&
    typeof body.username === 'string' &&
    typeof body.password === 'string' &&
    body.username.trim().length > 0 &&
    body.password.length >= 6
  );
}

app.post('/register', async (req, res) => {
  if (!bodyValido(req.body)) {
    return res.status(400).json({
      error: 'Envía username y password (mínimo 6 caracteres)',
    });
  }
  const username = req.body.username.trim();

  try {
    const existe = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(username);
    if (existe) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }

    const hash = await bcrypt.hash(req.body.password, 10);
    const info = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, hash);

    res.status(201).json({ userId: info.lastInsertRowid, username });
  } catch (err) {
    console.error('Error en /register:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/login', async (req, res) => {
  if (!bodyValido(req.body)) {
    return res.status(400).json({ error: 'Envía username y password' });
  }
  const username = req.body.username.trim();

  try {
    const user = db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username);

    const ok = user && (await bcrypt.compare(req.body.password, user.password_hash));
    if (!ok) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.status(200).json({ token, username: user.username });
  } catch (err) {
    console.error('Error en /login:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// JSON mal formado -> 400
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(process.env.PORT || 4000, () => {
  console.log(`Auth service en puerto ${process.env.PORT || 4000}`);
});