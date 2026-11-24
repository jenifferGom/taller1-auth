// Prueba del cluster de auth-services (Taller 7).
// Levanta TRES auth-services reales en este mismo computador (puertos 4101-4103, bases de datos
// temporales) y repite los pasos de la sustentación: líder + 2 réplicas, escritura que se propaga,
// elección al matar al líder, registro con el líder nuevo y regreso del nodo caído como réplica.
//
//   npm run test:cluster            (tarda ~1 minuto: hay que esperar heartbeats y elecciones de verdad)
//   npm run test:cluster -- --verbose   (muestra también la consola de los tres nodos)
//
// No usa tu .env ni tu users.db: todo va a una carpeta temporal que se borra al terminar.

const { spawn }  = require('child_process');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');

const VERBOSE = process.argv.includes('--verbose');
const DIR     = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cluster-'));
const NAMES   = ['auth-a', 'auth-b', 'auth-c'];
const PORTS   = { 'auth-a': 4101, 'auth-b': 4102, 'auth-c': 4103 };
const URL_OF  = Object.fromEntries(NAMES.map(n => [n, `http://localhost:${PORTS[n]}`]));
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));
const sufijo  = Math.random().toString(36).slice(2, 6);

let passed = 0, failed = 0;
function check(name, cond, info) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}${info !== undefined ? `\n      recibido: ${JSON.stringify(info)}` : ''}`); }
}

// ───── Procesos ─────
const procs = {};
const logs  = Object.fromEntries(NAMES.map(n => [n, []]));

function start(name, dbFile) {
  const env = {
    ...process.env,
    PORT: String(PORTS[name]),
    AUTH_PUBLIC_URL: URL_OF[name],
    AUTH_URLS: NAMES.map(n => URL_OF[n]).join(','),
    DB_PATH: dbFile || path.join(DIR, `${name}.db`),
    JWT_SECRET: 'clave_de_prueba_del_cluster_0123456789abcdef',
    JWT_EXPIRES_IN: '30m',
    GOOGLE_CLIENT_ID: 'prueba.apps.googleusercontent.com',
  };
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'index.js', name], { cwd: __dirname, env });
  const onData = (d) => d.toString().split('\n').filter(Boolean).forEach(l => {
    logs[name].push(l);
    if (VERBOSE) console.log(`      [${name}] ${l}`);
  });
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  procs[name] = p;
  return p;
}
function stop(name, signal = 'SIGINT') {
  return new Promise((resolve) => {
    const p = procs[name];
    if (!p || p.exitCode !== null) return resolve();
    p.once('exit', resolve);
    p.kill(signal);
    setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 2000);
  });
}

// ───── HTTP ─────
// Como el cliente (authFetch): si una réplica responde 503 not_leader, se repite contra leaderUrl
async function viaLider(name, method, ruta, body) {
  const first = await http(name, method, ruta, body);
  if (first.status === 503 && first.data.error === 'not_leader' && first.data.leaderUrl) {
    const lider = NAMES.find(n => URL_OF[n] === String(first.data.leaderUrl).replace(/\/+$/, ''));
    if (lider) return { ...(await http(lider, method, ruta, body)), redirigido: true, first };
  }
  return { ...first, redirigido: false, first };
}
async function http(name, method, ruta, body) {
  try {
    const res = await fetch(`${URL_OF[name]}${ruta}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(6000),
    });
    return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
  } catch (err) {
    return { status: 0, data: {}, error: err.message };
  }
}
const status = async (name) => (await http(name, 'GET', '/status')).data;

async function waitFor(fn, ms, every = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

async function leaderAmong(names) {
  const st = await Promise.all(names.map(async n => ({ n, s: await status(n) })));
  const leaders = st.filter(x => x.s.role === 'leader');
  return leaders.length === 1 ? leaders[0].n : null;
}
const jwtPayload = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

async function cleanup() {
  await Promise.all(NAMES.map(n => stop(n, 'SIGKILL')));
  fs.rmSync(DIR, { recursive: true, force: true });
}

(async () => {
  console.log(`Carpeta temporal: ${DIR}\n`);

  // Una BD "con pasado": un auth que se usó solo y tiene un usuario que el cluster no conoce.
  // Al entrar al cluster debe descartar su copia y adoptar la del líder (con copia de seguridad).
  const dbC = path.join(DIR, 'auth-c.db');
  console.log('0. Preparación: se crea una BD propia (la de auth-c) con un usuario "fantasma"');
  {
    const env = { ...process.env, PORT: '4199', AUTH_PUBLIC_URL: 'http://localhost:4199', AUTH_URLS: '', DB_PATH: dbC,
      JWT_SECRET: 'clave_de_prueba_del_cluster_0123456789abcdef', GOOGLE_CLIENT_ID: 'prueba.apps.googleusercontent.com' };
    const solo = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'index.js'], { cwd: __dirname, env });
    await waitFor(async () => (await fetch('http://localhost:4199/status').then(r => r.json()).catch(() => ({}))).role === 'leader', 8000, 300);
    await fetch('http://localhost:4199/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `fantasma_${sufijo}`, password: 'secret123' }) });
    solo.kill('SIGKILL');
    await sleep(500);
  }

  // auth-a y auth-b forman el cluster primero (2 de 3 ya son mayoría) y registran dos usuarios;
  // después entra auth-c, que trae una historia distinta.
  start('auth-a'); start('auth-b');
  console.log('\n1. auth-a y auth-b arrancan (mayoría 2 de 3) y se elige líder; luego entra auth-c con su BD propia');
  const primero = await waitFor(() => leaderAmong(['auth-a', 'auth-b']), 30000);
  check('con 2 de 3 nodos ya hay quórum y se elige UN líder', !!primero, primero);
  if (!primero) { console.log('\nSin líder no se puede seguir.'); await cleanup(); process.exit(1); }
  for (const u of ['base1', 'base2']) {
    await http(primero, 'POST', '/register', { username: `${u}_${sufijo}`, password: 'secret123' });
  }
  start('auth-c', dbC);

  console.log('\n   Los tres nodos: uno es leader, dos son replicas');
  const lider = await waitFor(() => leaderAmong(NAMES), 30000);
  check('hay exactamente UN líder entre los tres', !!lider, lider);
  if (!lider) { console.log('\nSin líder no se puede seguir.'); await cleanup(); process.exit(1); }
  const replicas = NAMES.filter(n => n !== lider);
  console.log(`     líder: ${lider}; réplicas: ${replicas.join(', ')}`);

  await waitFor(async () => {
    const all = await Promise.all(NAMES.map(status));
    return all.every(s => s.users === all[0].users && s.lastAppliedSeq === all[0].lastAppliedSeq);
  }, 15000);
  const st1 = await Promise.all(NAMES.map(status));
  const stL = st1[NAMES.indexOf(lider)];
  check('/status del líder dice role "leader"', stL.role === 'leader', stL.role);
  check('las réplicas dicen role "replica"', replicas.every(r => st1[NAMES.indexOf(r)].role === 'replica'));
  check('todos apuntan al mismo leaderUrl', st1.every(s => s.leaderUrl === URL_OF[lider]), st1.map(s => s.leaderUrl));
  check('los tres tienen users: N igual (el "fantasma" de auth-c se descartó)', st1.every(s => s.users === st1[0].users) && st1[0].users === 2,
    st1.map(s => s.users));
  const loginFantasma = await http(lider, 'POST', '/login', { username: `fantasma_${sufijo}`, password: 'secret123' });
  const loginFantasmaC = await http('auth-c', 'POST', '/login', { username: `fantasma_${sufijo}`, password: 'secret123' });
  check('el usuario fantasma ya no existe en ningún nodo', loginFantasma.status === 401 && loginFantasmaC.status !== 200, [loginFantasma.status, loginFantasmaC.status]);
  const respaldos = fs.readdirSync(DIR).filter(f => f.startsWith('auth-c-backup'));
  check('auth-c guardó una copia de seguridad de su BD antes de reemplazarla', respaldos.length === 1, respaldos);
  check('/status trae authId, publicUrl, peerUrl, knownPeers, lastAppliedSeq, users',
    ['authId', 'publicUrl', 'peerUrl', 'knownPeers', 'lastAppliedSeq', 'users'].every(k => k in stL), Object.keys(stL));
  check('knownPeers lista a los otros dos', stL.knownPeers.length === 2, stL.knownPeers);
  const peersRes = (await http(replicas[0], 'GET', '/peers')).data;
  check('GET /peers lista a los tres con su rol', Array.isArray(peersRes.peers) && peersRes.peers.length === 3 &&
    peersRes.peers.filter(p => p.role === 'leader').length === 1 && peersRes.peers.every(p => p.authId && p.publicUrl && p.peerUrl), peersRes);
  const N = st1[0].users;

  // ───────── 2. Registrar propaga ─────────
  console.log('\n2. Registrar a alice: la escritura se propaga a los tres');
  const r1 = await http(replicas[0], 'POST', '/register', { username: `alice_${sufijo}`, password: 'secret123' });
  check('una réplica rechaza el registro: 503 not_leader con leaderUrl', r1.status === 503 && r1.data.error === 'not_leader' &&
    r1.data.leaderUrl === URL_OF[lider], r1);
  const reg = await http(lider, 'POST', '/register', { username: `alice_${sufijo}`, password: 'secret123' });
  check('el líder registra a alice: 201', reg.status === 201, reg);
  const okProp = await waitFor(async () => (await Promise.all(NAMES.map(status))).every(s => s.users === N + 1), 5000, 200);
  const st2 = await Promise.all(NAMES.map(status));
  check(`los tres auths tienen users: ${N + 1}`, !!okProp, st2.map(s => s.users));
  check('los tres tienen el mismo lastAppliedSeq', st2.every(s => s.lastAppliedSeq === st2[0].lastAppliedSeq), st2.map(s => s.lastAppliedSeq));
  const directo = await http(replicas[0], 'POST', '/login', { username: `alice_${sufijo}`, password: 'secret123' });
  check('una réplica NO hace el login: 503 not_leader con leaderUrl (todo va al líder)',
    directo.status === 503 && directo.data.error === 'not_leader' && !!directo.data.leaderUrl, directo);
  const tokens = [];
  for (const n of NAMES) tokens.push((await viaLider(n, 'POST', '/login', { username: `alice_${sufijo}`, password: 'secret123' })));
  check('empezando por CUALQUIER nodo, alice entra (las réplicas la mandan al líder)',
    tokens.every(t => t.status === 200 && t.data.token && t.headers.get('X-Auth-Role') === 'leader'),
    tokens.map(t => [t.status, t.redirigido]));
  const ids = tokens.map(t => t.data.token && jwtPayload(t.data.token).userId);
  check('el userId que firma cada nodo es el MISMO', ids.every(i => i && i === ids[0]), ids);
  const bad = await viaLider(replicas[0], 'POST', '/login', { username: `alice_${sufijo}`, password: 'otra_clave' });
  check('contraseña incorrecta (vía réplica → líder) → 401', bad.status === 401, bad.status);
  check('toda respuesta dice qué nodo contestó (X-Auth-Id / X-Auth-Role)', tokens[0].headers.get('x-auth-id') === NAMES[0] &&
    ['leader', 'replica'].includes(tokens[0].headers.get('x-auth-role')), [tokens[0].headers.get('x-auth-id'), tokens[0].headers.get('x-auth-role')]);

  // Directorio de coordinadores: el heartbeat es una escritura (solo el líder); las réplicas lo copian
  console.log('\n   Directorio de coordinadores');
  const hb = { coordinatorId: 'coord-test', publicUrl: 'wss://coord-test.example', peerUrl: 'wss://coord-test.example/peer', connectedPlayers: 3, uptime: 5 };
  const h1 = await http(replicas[0], 'POST', '/heartbeat', hb);
  check('POST /heartbeat en una réplica → 503 not_leader', h1.status === 503 && h1.data.error === 'not_leader', h1);
  const h2 = await http(lider, 'POST', '/heartbeat', hb);
  check('POST /heartbeat en el líder → 200', h2.status === 200 && h2.data.ok === true, h2);
  await sleep(2600);
  const c1 = await viaLider(replicas[1], 'GET', '/coordinator');
  check('GET /coordinator en una réplica → not_leader → el líder responde', c1.redirigido && c1.status === 200 && c1.data.coordinatorId === 'coord-test', c1);
  const cp = await viaLider(replicas[1], 'GET', '/coordinator-peers');
  check('y GET /coordinator-peers igual', cp.redirigido && cp.status === 200 && cp.data.peers.some(p => p.coordinatorId === 'coord-test'), cp);

  // ───────── 3. Matar al líder ─────────
  console.log(`\n3. Se mata al líder (${lider}) con Ctrl+C y se esperan ~10 s`);
  const t0 = Date.now();
  await stop(lider);
  const nuevo = await waitFor(() => leaderAmong(replicas), 25000);
  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  check(`una de las dos réplicas vivas pasó a role "leader" (${seg} s)`, !!nuevo, nuevo);
  if (!nuevo) { await cleanup(); process.exit(1); }
  const otra = replicas.find(r => r !== nuevo);
  console.log(`     nuevo líder: ${nuevo}; réplica: ${otra}`);
  const sN = await status(nuevo), sO = await status(otra);
  check('el término subió (hubo elección)', sN.term > stL.term, [stL.term, sN.term]);
  check('la otra réplica reconoce al nuevo líder', sO.leaderUrl === URL_OF[nuevo] && sO.role === 'replica', sO);
  check('el nuevo líder conserva a alice (users y seq)', sN.users === N + 1 && sN.lastAppliedSeq === st2[0].lastAppliedSeq, sN);

  // El directorio no se pierde: el nuevo líder lo heredó y le da gracia a los coordinadores
  const cN = await http(nuevo, 'GET', '/coordinator');
  check('el nuevo líder heredó el directorio de coordinadores', cN.status === 200 && cN.data.coordinatorId === 'coord-test', cN);

  // ───────── 4. Registrar a bob con el líder nuevo ─────────
  console.log('\n4. Se registra a bob después de la elección');
  const rb = await http(nuevo, 'POST', '/register', { username: `bob_${sufijo}`, password: 'secret123' });
  check('el nuevo líder acepta el registro: 201', rb.status === 201, rb);
  const idBob = rb.data.userId;
  const okB = await waitFor(async () => (await status(otra)).users === N + 2, 5000, 200);
  check(`la réplica viva también tiene users: ${N + 2}`, !!okB, (await status(otra)).users);
  const lb = await viaLider(otra, 'POST', '/login', { username: `bob_${sufijo}`, password: 'secret123' });
  check('bob inicia sesión empezando por la réplica (la atiende el líder) y su userId es el del registro', lb.status === 200 && jwtPayload(lb.data.token).userId === idBob,
    [lb.status, idBob]);

  // Con solo 2 de 3 nodos hay mayoría; si cae otro más ya no se puede escribir (no hay quórum)
  // (no se prueba aquí para no tumbar el cluster, está explicado en el README)

  // ───────── 5. Vuelve el nodo caído ─────────
  console.log(`\n5. Vuelve ${lider}: debe sincronizarse y entrar como réplica (no recupera el liderazgo)`);
  start(lider);
  const sync = await waitFor(async () => {
    const s = await status(lider);
    return s.role === 'replica' && s.users === N + 2 ? s : null;
  }, 25000, 500);
  const sLast = await status(lider);
  check(`${lider} volvió con role "replica"`, sLast.role === 'replica', sLast.role);
  check(`su contador users está al día (${N + 2})`, !!sync, sLast.users);
  const seqNuevo = (await status(nuevo)).lastAppliedSeq;
  check('su lastAppliedSeq coincide con el del líder', sLast.lastAppliedSeq === seqNuevo, [sLast.lastAppliedSeq, seqNuevo]);
  check(`el líder sigue siendo ${nuevo}`, (await status(nuevo)).role === 'leader');
  const lAgain = await viaLider(lider, 'POST', '/login', { username: `bob_${sufijo}`, password: 'secret123' });
  check('el nodo que volvió manda el login de bob al líder actual (200)', lAgain.redirigido && lAgain.status === 200, [lAgain.redirigido, lAgain.status]);
  const rr = await http(lider, 'POST', '/register', { username: `carol_${sufijo}`, password: 'secret123' });
  check('y como réplica redirige las escrituras al líder actual', rr.status === 503 && rr.data.leaderUrl === URL_OF[nuevo], rr);

  console.log(`\n${passed} correctas, ${failed} fallidas`);
  if (failed && !VERBOSE) console.log('(vuelve a correr con  -- --verbose  para ver la consola de los nodos)');
  await cleanup();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });