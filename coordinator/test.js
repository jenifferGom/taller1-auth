// Pruebas del juego. Necesita el auth-service y el coordinador encendidos.
// Uso:  npm test
//       node test.js <URL_AUTH> <URL_COORDINADOR>
//       ej: node test.js https://xxxx.ngrok-free.dev wss://yyyy.ngrok-free.dev
// Crea dos usuarios de prueba (j1_XXXX y j2_XXXX), los conecta y mide lo que hace el servidor.

const WebSocket = require('ws');

const AUTH  = (process.argv[2] || 'http://localhost:4000').replace(/\/$/, '');
const COORD = (process.argv[3] || 'ws://localhost:5000').replace(/\/$/, '');
const sufijo = Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, info) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}${info !== undefined ? `\n      recibido: ${JSON.stringify(info)}` : ''}`); }
}

async function tokenPara(username) {
  const opts = (body) => ({ method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' } });
  await fetch(`${AUTH}/register`, opts({ username, password: 'secret123' }));
  const res = await fetch(`${AUTH}/login`, opts({ username, password: 'secret123' }));
  return (await res.json()).token;
}

// Conecta un jugador y guarda todo lo que recibe
function conectar(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${COORD}/connect?token=${encodeURIComponent(token)}`);
    const c = { ws, msgs: [], states: [], errors: [], welcome: null, closed: null };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      c.msgs.push(m);
      if (m.type === 'welcome') { c.welcome = m; resolve(c); }
      if (m.type === 'state') c.states.push(m);
      if (m.type === 'error') c.errors.push(m);
    });
    ws.on('close', (code, reason) => { c.closed = { code, reason: reason.toString() }; resolve(c); });
    ws.on('error', () => {});
  });
}

const enviar  = (c, obj) => c.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
const intent  = (c, x, y) => enviar(c, { type: 'intent', intent: { dir: { x, y } } });
const ultimo  = (c) => c.states[c.states.length - 1];
const posDe   = (c, username) => ultimo(c).players.find(p => p.username === username);
const ultimoError = (c) => c.errors[c.errors.length - 1];

// Mueve al jugador durante "ms" y devuelve cuánto avanzó, medido por lo que ve el OTRO jugador
async function medir(quien, observador, username, x, y, ms) {
  await sleep(150);
  const a = posDe(observador, username);
  intent(quien, x, y); await sleep(ms); intent(quien, 0, 0); await sleep(150);
  const b = posDe(observador, username);
  return { dx: b.x - a.x, dy: b.y - a.y, a, b };
}

(async () => {
  console.log(`Auth: ${AUTH} · Coordinador: ${COORD}\n`);
  const n1 = `j1_${sufijo}`, n2 = `j2_${sufijo}`;
  const [t1, t2] = [await tokenPara(n1), await tokenPara(n2)];
  if (!t1 || !t2) throw new Error('No se pudo obtener token del auth');

  const A = await conectar(t1);
  const B = await conectar(t2);
  check('Dos jugadores conectados reciben welcome', A.welcome && B.welcome);
  const w = A.welcome.world;
  check('welcome trae world {width, height, playerRadius, tickRate}', w && w.width > 0 && w.height > 0 && w.playerRadius > 0 && w.tickRate === 20, w);
  check('welcome trae you {userId, username}', A.welcome.you && A.welcome.you.username === n1, A.welcome.you);

  // Ritmo de los mensajes state
  B.states.length = 0; await sleep(1000);
  check(`Llegan ~20 mensajes state por segundo (${B.states.length})`, B.states.length >= 16 && B.states.length <= 24);
  const s = ultimo(B);
  check('state incluye a los dos jugadores con x, y, extras y badge',
    s.players.length >= 2 && s.players.every(p => 'x' in p && 'y' in p && 'extras' in p && p.badge), s.players[0]);

  // Llevamos a A al centro para que los límites no interfieran en las mediciones
  const cx = w.width / 2, cy = w.height / 2;
  for (let i = 0; i < 2; i++) {
    const p = posDe(A, n1);
    const tx = Math.sign(cx - p.x), ty = Math.sign(cy - p.y);
    const ms = Math.max(Math.abs(cx - p.x), Math.abs(cy - p.y)) / 200 * 1000;
    intent(A, tx, ty); await sleep(Math.min(ms, 3000)); intent(A, 0, 0); await sleep(150);
  }

  let m = await medir(A, B, n1, 1, 0, 1000);
  check(`Movimiento horizontal: ~200 px en 1 s (${m.dx.toFixed(0)} px, y sin cambio)`, m.dx > 160 && m.dx < 240 && Math.abs(m.dy) < 1, m);

  m = await medir(A, B, n1, 0, -1, 1000);
  check(`Movimiento vertical: ~200 px en 1 s (${(-m.dy).toFixed(0)} px hacia arriba)`, -m.dy > 160 && -m.dy < 240 && Math.abs(m.dx) < 1, m);

  m = await medir(A, B, n1, -1, 1, 1000);
  const dist = Math.hypot(m.dx, m.dy);
  check(`Diagonal normalizada: ~200 px en 1 s, no ~283 (${dist.toFixed(0)} px)`, dist > 160 && dist < 240, m);

  m = await medir(A, B, n1, 9999, 0, 500);
  check(`intent {x: 9999} se recorta a 1: ~100 px en 0,5 s (${m.dx.toFixed(0)} px), sin teletransporte`, m.dx > 70 && m.dx < 130, m);

  // Límites: empujamos a A hacia la esquina superior izquierda
  intent(A, -1, -1); await sleep(Math.max(w.width, w.height) / 200 * 1000 + 500); intent(A, 0, 0); await sleep(150);
  let p = posDe(B, n1);
  check(`Límites del mundo: se queda en (${p.x}, ${p.y}) = (radio, radio)`, p.x === w.playerRadius && p.y === w.playerRadius, p);

  // Mensajes inválidos
  enviar(A, { type: 'intent', intent: { dir: { x: 'derecha', y: 0 } } }); await sleep(150);
  check('intent con texto → error invalid_intent', ultimoError(A)?.code === 'invalid_intent', ultimoError(A));
  enviar(A, 'hola'); await sleep(150);
  check('Texto que no es JSON → error invalid_json', ultimoError(A)?.code === 'invalid_json', ultimoError(A));
  enviar(A, { type: 'volar' }); await sleep(150);
  check('Tipo desconocido → error unknown_type', ultimoError(A)?.code === 'unknown_type', ultimoError(A));
  enviar(A, { type: 'extras_update', extras: ['rojo'] }); await sleep(150);
  check('extras como arreglo → error invalid_extras', ultimoError(A)?.code === 'invalid_extras', ultimoError(A));
  enviar(A, { type: 'extras_update', extras: { color: '#e53935', basura: 'x'.repeat(2000) } }); await sleep(150);
  check('extras de más de 1024 caracteres → error extras_too_large', ultimoError(A)?.code === 'extras_too_large', ultimoError(A));
  enviar(A, { type: 'extras_update', extras: { color: '<script>alert(1)</script>' } }); await sleep(150);
  check('Color fuera de la paleta → error invalid_color', ultimoError(A)?.code === 'invalid_color', ultimoError(A));

  // Característica extra replicada
  const color = A.welcome.colors[2];
  enviar(A, { type: 'extras_update', extras: { color } }); await sleep(300);
  check('Color válido → extras_ok', A.msgs.some(x => x.type === 'extras_ok'));
  check(`El otro jugador ve el color nuevo en el state (${color})`, posDe(B, n1).extras.color === color, posDe(B, n1));
  await sleep(1000);
  check('El color se mantiene en los siguientes ticks', posDe(B, n1).extras.color === color, posDe(B, n1));

  // Desconexión
  B.ws.close(); await sleep(400);
  check('Al desconectarse un jugador, desaparece del state de los demás', !posDe(A, n2));
  check('… y los demás reciben players_update "salió"', A.msgs.some(x => x.type === 'players_update' && x.event?.action === 'left' && x.event.username === n2));

  // Token inválido
  const X = await conectar(t1.slice(0, -3) + 'abc');
  check('Token alterado → cierre 4001 "invalid token"', X.closed && X.closed.code === 4001 && X.closed.reason === 'invalid token', X.closed);

  A.ws.close();
  console.log(`\n${passed} correctas, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(`\nError: ${err.message}`);
  console.error('¿Están encendidos el auth-service y el coordinador? ¿Las URLs son correctas?');
  process.exit(1);
});
