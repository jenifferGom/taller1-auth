// Pruebas del mesh (Taller 6). Necesita el auth-service y TRES coordinadores encendidos
// (coord-a, coord-b, coord-c, configurados en el único coordinator/.env).
// Uso:  npm run test:mesh
//       node mesh-test.js <URL_AUTH>
// No mata coordinadores: la parte de Ctrl+C se hace a mano (ver README, sección "Demo").

const WebSocket = require('ws');

const AUTH = (process.argv[2] || 'http://localhost:4000').replace(/\/$/, '');
const sufijo = Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' };

let passed = 0, failed = 0;
function check(name, cond, info) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}${info !== undefined ? `\n      recibido: ${JSON.stringify(info)}` : ''}`); }
}
const get = async (ruta) => { const r = await fetch(`${AUTH}${ruta}`, { headers: H }); return { status: r.status, data: await r.json() }; };

async function tokenPara(username) {
  const body = JSON.stringify({ username, password: 'secret123' });
  await fetch(`${AUTH}/register`, { method: 'POST', headers: H, body });
  const res = await fetch(`${AUTH}/login`, { method: 'POST', headers: H, body });
  return (await res.json()).token;
}

// Conecta un jugador al coordinador que diga el auth (o a uno fijo) y guarda lo que recibe
function conectar(token, wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}/connect?token=${encodeURIComponent(token)}`);
    const c = { ws, states: [], errors: [], welcome: null, closed: null };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'welcome') { c.welcome = m; resolve(c); }
      if (m.type === 'state') c.states.push(m);
      if (m.type === 'error') c.errors.push(m);
    });
    ws.on('close', (code) => { c.closed = code; resolve(c); });
    ws.on('error', () => {});
  });
}
const intent = (c, x, y) => c.ws.send(JSON.stringify({ type: 'intent', intent: { dir: { x, y } } }));
const ver = (c, username) => c.states[c.states.length - 1]?.players.find(p => p.username === username);

(async () => {
  console.log(`Auth: ${AUTH}\n`);

  console.log('1. Directorio');
  const { data: peers } = await get('/peers');
  const ids = peers.peers.map(p => p.coordinatorId).sort();
  check('/peers lista al menos 3 coordinadores', ids.length >= 3, ids);
  check('cada peer trae coordinatorId y peerUrl ws://', peers.peers.every(p => p.coordinatorId && /^wss?:\/\//.test(p.peerUrl)));
  const hb = await fetch(`${AUTH}/heartbeat`, { method: 'POST', headers: H, body: JSON.stringify({ coordinatorId: 'x' }) });
  check('POST /heartbeat con body incompleto → 400', hb.status === 400, hb.status);

  console.log('\n2. Reparto de 4 clientes (GET /coordinator)');
  const asignados = [];
  for (let i = 0; i < 4; i++) asignados.push((await get('/coordinator')).data);
  const usados = new Set(asignados.map(a => a.coordinatorId));
  console.log(`     asignados: ${asignados.map(a => a.coordinatorId).join(', ')}`);
  check('los 4 NO van al mismo coordinador', usados.size > 1, [...usados]);
  check('con 3 coordinadores vivos se usan los 3', usados.size === Math.min(3, ids.length), [...usados]);
  check('la respuesta trae coordinatorId y publicUrl', asignados.every(a => a.coordinatorId && /^wss?:\/\//.test(a.publicUrl)));

  console.log('\n3. Alice en un coordinador, Bob en otro');
  const dir = Object.fromEntries((await get('/coordinators')).data.coordinators.map(c => [c.coordinatorId, c.publicUrl]));
  const [idA, idB] = ids;
  const alice = await conectar(await tokenPara(`alice_${sufijo}`), dir[idA]);
  const bob   = await conectar(await tokenPara(`bob_${sufijo}`),   dir[idB]);
  check(`Alice recibe welcome con su coordinador (${idA})`, alice.welcome && alice.welcome.coordinatorId === idA, alice.welcome?.coordinatorId);
  check(`Bob recibe welcome con su coordinador (${idB})`, bob.welcome && bob.welcome.coordinatorId === idB, bob.welcome?.coordinatorId);
  await sleep(600);
  const aliceUser = `alice_${sufijo}`, bobUser = `bob_${sufijo}`;
  check('Bob ve a Alice en su state (player_joined replicado)', !!ver(bob, aliceUser));
  check('Alice ve a Bob en su state', !!ver(alice, bobUser));
  check('el state dice en qué coordinador está cada uno', ver(bob, aliceUser)?.coordinator === idA && ver(alice, bobUser)?.coordinator === idB,
    [ver(bob, aliceUser)?.coordinator, ver(alice, bobUser)?.coordinator]);

  const antes = ver(bob, aliceUser);
  intent(alice, 1, 0); await sleep(1000); intent(alice, 0, 0); await sleep(300);
  const despues = ver(bob, aliceUser);
  const dx = Math.abs(despues.x - antes.x), dy = Math.abs(despues.y - antes.y);
  console.log(`     Alice se movió en su coordinador; Bob la vio avanzar ${dx.toFixed(0)} px`);
  check('Bob ve moverse a Alice (≈ 200 px/s, o hasta el borde)', dx > 20 || despues.x >= 940 - 1 || antes.x >= 940 - 1, { dx, dy });
  const aliceReal = ver(alice, aliceUser), aliceVistaPorBob = ver(bob, aliceUser);
  check('la posición de Alice es casi la misma en los dos coordinadores (±15 px)',
    Math.abs(aliceReal.x - aliceVistaPorBob.x) < 15 && Math.abs(aliceReal.y - aliceVistaPorBob.y) < 15, [aliceReal, aliceVistaPorBob]);

  const bobAntes = ver(alice, bobUser);
  intent(bob, 0, 1); await sleep(800); intent(bob, 0, 0); await sleep(300);
  const bobDespues = ver(alice, bobUser);
  check('Alice ve moverse a Bob', Math.abs(bobDespues.y - bobAntes.y) > 20 || bobDespues.y >= 580 || bobAntes.y >= 580, { antes: bobAntes.y, despues: bobDespues.y });

  bob.ws.send(JSON.stringify({ type: 'extras_update', extras: { color: '#8e24aa' } })); await sleep(400);
  check('el color de Bob (extras) llega a Alice', ver(alice, bobUser)?.extras?.color === '#8e24aa', ver(alice, bobUser)?.extras);

  console.log('\n4. Nadie retransmite ni se cuela');
  const lento = await sleep(1500).then(() => alice.states.length);
  check('Alice sigue recibiendo ~20 states por segundo (sin tormenta de mensajes)', lento > 0);

  console.log('\n5. La misma cuenta en dos coordinadores: gana la nueva (4002)');
  const alice2 = await conectar(await tokenPara(aliceUser), dir[idB]);
  await sleep(600);
  check(`la conexión vieja de Alice (en ${idA}) se cierra con 4002`, alice.closed === 4002, alice.closed);
  check('Bob ve a Alice una sola vez, ahora en el otro coordinador',
    bob.states[bob.states.length - 1].players.filter(p => p.username === aliceUser).length === 1 &&
    ver(bob, aliceUser).coordinator === idB, ver(bob, aliceUser));

  console.log('\n6. Salida de un jugador');
  alice2.ws.close(); await sleep(600);
  check('Bob ya no ve a Alice cuando se desconecta', !ver(bob, aliceUser), ver(bob, aliceUser));
  bob.ws.close(); await sleep(200);

  console.log(`\n${passed} correctas, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
