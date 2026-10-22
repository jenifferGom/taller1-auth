// ─────────────────────────────────────────────────────────────
// Configuración del cliente: el ÚNICO lugar donde van las URLs.
// ─────────────────────────────────────────────────────────────
//
// Local:
//   AUTH_URL       = 'http://localhost:4000'
//   COORDINATOR_WS = 'ws://localhost:5000'
//
// Con ngrok (la página se sirve por HTTPS, así que el WebSocket DEBE ser wss://):
//   AUTH_URL       = 'https://xxxx.ngrok-free.app'   ← túnel del puerto 4000
//   COORDINATOR_WS = 'wss://yyyy.ngrok-free.app'     ← túnel del puerto 5000
//
// Después de cambiarlas, recarga la página (Ctrl+F5).

const AUTH_URL       = 'https://episode-headrest-ocean.ngrok-free.dev';
const COORDINATOR_WS = 'wss://tactical-basket-illusive.ngrok-free.dev';
