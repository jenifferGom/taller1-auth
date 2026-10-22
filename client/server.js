require('dotenv').config();
const express = require('express');
const path    = require('path');

// Servidor mínimo: solo entrega los archivos estáticos del cliente (HTML, CSS y JS).
// Las URLs de auth y del coordinador NO están aquí: viven en js/config.js.
const PORT = parseInt(process.env.PORT, 10) || 3000;

const app = express();
// Solo se publican las carpetas y páginas del cliente (no server.js, package.json ni .env)
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js',  express.static(path.join(__dirname, 'js')));
app.get('/', (_req, res) => res.redirect('/login.html'));
app.get(['/login.html', '/lobby.html'], (req, res) => res.sendFile(path.join(__dirname, req.path)));

app.listen(PORT, () => console.log(`Cliente en http://localhost:${PORT}`));