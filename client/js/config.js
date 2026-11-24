// ─────────────────────────────────────────────────────────────
// Configuración del cliente: el ÚNICO lugar donde van las URLs.
// ─────────────────────────────────────────────────────────────
//
// Desde el Taller 7 hay VARIOS auth-services (un líder y réplicas), en computadores distintos.
// El cliente conoce la lista completa: prueba con uno y, si no responde, con el siguiente.
// Si una réplica le dice "not_leader", repite la petición contra el líder (leaderUrl).
//
// Una URL por auth-service (la de ngrok de cada computador). El orden no importa:
//   const AUTH_URLS = [
//     'https://aaaa.ngrok-free.dev',   // auth-a
//     'https://bbbb.ngrok-free.dev',   // auth-b
//     'https://cccc.ngrok-free.dev',   // auth-c
//   ];
//
// Local, con tres auth-services en este equipo (puertos 4001, 4002, 4003):
//   const AUTH_URLS = ['http://localhost:4001', 'http://localhost:4002', 'http://localhost:4003'];
//
// Y con un solo auth-service (como antes): una sola URL en la lista.
//
// El cliente NO conoce los coordinadores: se los pide al auth (GET /coordinator) después del login.
//
// Después de cambiarla, recarga la página (Ctrl+F5).

const AUTH_URLS = [
  'https://episode-headrest-ocean.ngrok-free.dev', 
  'https://employer-strategy-proponent.ngrok-free.dev',
  'https://overbook-overplay-ranging.ngrok-free.dev'
];

const AUTH_URL = AUTH_URLS[0];   // compatibilidad: código que aún use un solo aut
