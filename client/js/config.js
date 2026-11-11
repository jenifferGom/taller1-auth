// ─────────────────────────────────────────────────────────────
// Configuración del cliente: el ÚNICO lugar donde va una URL.
// ─────────────────────────────────────────────────────────────
//
// Desde el Taller 6 el cliente YA NO conoce la URL del coordinador: se la pide al auth-service
// (GET /coordinator) después del login, y el auth elige el coordinador vivo con menos jugadores.
// Por eso solo hace falta AUTH_URL.
//
// Local:
//   AUTH_URL = 'http://localhost:4000'
//
// Con ngrok (el auth tiene su propio túnel):
//   AUTH_URL = 'https://xxxx.ngrok-free.dev'   ← túnel del puerto 4000
//
// Los coordinadores publican su propia URL pública (PUBLIC_URL en su .env), así que cada uno
// necesita su túnel de ngrok y esa URL (wss://...) es la que llega al navegador.
//
// Después de cambiarla, recarga la página (Ctrl+F5).

const AUTH_URL = 'https://episode-headrest-ocean.ngrok-free.dev';
