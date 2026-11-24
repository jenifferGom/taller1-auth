// Prueba de las SALAS DE PARQUÉS con servicios de verdad: auth-service y DOS coordinadores encendidos.
//   node salas-test.js http://localhost:4000 ws://localhost:5001 ws://localhost:5002 [--matar-dueno]
// Valen y Mafe se conectan al coordinador 1 y Juanes al 2. Se prueba la sala privada por código,
// la partida pública (búsqueda), una partida jugada y que los tres ven EXACTAMENTE la misma sala.
// Con --matar-dueno, al final imprime MATAR_AHORA: quien corre la prueba apaga el coordinador dueño
// y la prueba verifica que el otro coordinador adopta la sala y la partida sigue.
const WebSocket = require('ws');
const [AUTH, C1, C2] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const MATAR = process.argv.includes('--matar-dueno');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sufijo = Math.random().toString(36).slice(2, 6);
let ok = 0, mal = 0;
const check = (n, c, info) => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { mal++; console.log(`  ✘ ${n}${info !== undefined ? `\n      ${JSON.stringify(info)}` : ''}`); } };

async function token(nombre) {
  const body = JSON.stringify({ username: `${nombre}_${sufijo}`, password: 'secret123' });
  const H = { 'Content-Type': 'application/json' };
  await fetch(`${AUTH}/register`, { method: 'POST', headers: H, body });
  return (await (await fetch(`${AUTH}/login`, { method: 'POST', headers: H, body })).json()).token;
}
function jugador(nombre, url, tk) {
  const j = { nombre, sala: undefined, jugadas: [], busqueda: null, errores: [], ws: null, userId: null };
  j.conectar = (u) => new Promise((listo) => {
    j.ws = new WebSocket(`${u}/connect?token=${tk}&seq=${Date.now()}`);
    j.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'welcome') { j.userId = m.you.userId; listo(); }
      if (m.type === 'sala_estado') { j.sala = m.sala; j.jugadas = m.jugadas || []; }
      if (m.type === 'busqueda_estado') j.busqueda = m;
      if (m.type === 'sala_error') j.errores.push(m.code);
    });
    j.ws.on('error', () => {});
  });
  j.enviar = (m) => j.ws.send(JSON.stringify(m));
  return j.conectar(url).then(() => j);
}
async function esperar(cond, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await sleep(40); } return false; }
const firma = (s) => s && JSON.stringify({ v: s.v, estado: s.estado, game: s.game, shots: s.shots });

async function jugar(js, n) {
  for (let i = 0; i < n; i++) {
    const s = js[0].sala;
    if (!s || s.estado !== 'jugando') return;
    const v = s.v, quien = (id) => js.find(j => j.userId === id);
    if (s.shots.length) {
      const sh = s.shots[0];
      if (sh.tipo === 'elegir') quien(sh.por).enviar({ type: 'sala_elegir', shotId: sh.id, jugadorId: s.game.jugadores.find(x => x.id !== sh.por && !x.fuera).id });
      else quien(sh.jugadorId).enviar({ type: 'sala_shot_ok', shotId: sh.id });
    } else {
      const yo = quien(s.game.jugadores[s.game.turno].id);
      if (s.game.fase === 'tirar') yo.enviar({ type: 'sala_tirar', v: yo.sala.v });
      else { await esperar(() => yo.jugadas.length, 2000); const m = yo.jugadas[0]; yo.enviar({ type: 'sala_mover', v: yo.sala.v, ficha: m.ficha, dados: m.dados }); }
    }
    if (!await esperar(() => js.every(j => j.sala && j.sala.v > v))) { console.log('    (sin cambio tras una acción)', js.map(j => j.errores.slice(-1))); return; }
  }
}

(async () => {
  const [tv, tj, tm] = await Promise.all(['valen', 'juanes', 'mafe'].map(token));
  const valen = await jugador('Valen', C1, tv), juanes = await jugador('Juanes', C2, tj), mafe = await jugador('Mafe', C1, tm);
  const js = [valen, juanes, mafe];

  console.log('\nSala privada');
  valen.enviar({ type: 'sala_crear', maxJugadores: 4, nivel: 'guaro' });
  check('Valen crea una sala privada con código', await esperar(() => valen.sala && /^[A-Z2-9]{6}$/.test(valen.sala.codigo)), valen.errores);
  const codigo = valen.sala.codigo;
  await sleep(300);
  juanes.enviar({ type: 'sala_unirse', codigo: 'ZZZZZZ' });
  check('Juanes con un código equivocado: codigo_invalido', await esperar(() => juanes.errores.includes('codigo_invalido')));
  juanes.enviar({ type: 'sala_unirse', codigo }); mafe.enviar({ type: 'sala_unirse', codigo });
  check('Juanes (otro coordinador) y Mafe entran con el código: los tres ven 3 jugadores', await esperar(() => js.every(j => j.sala && j.sala.jugadores.length === 3)));
  juanes.enviar({ type: 'sala_empezar' });
  check('solo el anfitrión empieza', await esperar(() => juanes.errores.includes('solo_anfitrion')));
  for (const j of js) j.enviar({ type: 'sala_listo', listo: true });
  await esperar(() => js.every(j => j.sala.jugadores.every(x => x.listo)));
  valen.enviar({ type: 'sala_empezar' });
  check('Valen empieza: los tres en "jugando"', await esperar(() => js.every(j => j.sala.estado === 'jugando')));

  console.log('\nPartida');
  const actual = () => valen.sala.game.jugadores[valen.sala.game.turno].id;
  const otro = js.find(j => j.userId !== actual());
  otro.enviar({ type: 'sala_tirar', v: otro.sala.v });
  check('si no es tu turno, no puedes tirar', await esperar(() => otro.errores.includes('no_es_tu_turno')));
  await jugar(js, 80);
  // Los shots dependen de los dados: se sigue jugando hasta que alguien tome (máx. 250 acciones)
  for (let k = 0; k < 17 && valen.sala.estado === 'jugando' && !valen.sala.game.jugadores.some(x => x.shots > 0); k++) await jugar(js, 10);
  check('tras 80 acciones o más los tres ven la MISMA sala (versión, dados, fichas y shots)', js.every(j => firma(j.sala) === firma(valen.sala)), js.map(j => j.sala.v));
  check('hubo shots confirmados', valen.sala.game.jugadores.some(x => x.shots > 0), valen.sala.game.jugadores.map(x => x.shots));

  if (MATAR) {
    const dueno = valen.sala.duenio;
    console.log(`\nApaga ahora el coordinador "${dueno}" (el dueño). Esperando…`);
    console.log('MATAR_AHORA');
    check('Juanes recibe la sala adoptada por su coordinador', await esperar(() => juanes.sala && juanes.sala.duenio !== dueno, 15000), juanes.sala && juanes.sala.duenio);
    await Promise.all([valen.conectar(C2), mafe.conectar(C2)]);
    check('Valen y Mafe se reconectan al coordinador 2 y les llega su sala',
      await esperar(() => [valen, mafe].every(j => j.sala && j.sala.duenio === juanes.sala.duenio && j.sala.v === juanes.sala.v)));
    const antes = valen.sala.seq;
    await jugar(js, 30);
    check('la partida sigue: hubo jugadas nuevas', valen.sala.seq > antes, [antes, valen.sala.seq]);
    check('los tres siguen viendo la misma sala', js.every(j => firma(j.sala) === firma(valen.sala)));
  } else {
    console.log('\nPartida pública');
    for (const j of js) j.enviar({ type: 'sala_salir' });
    await esperar(() => js.every(j => j.sala === null));
    valen.enviar({ type: 'partida_buscar' }); juanes.enviar({ type: 'partida_buscar' });
    check('buscando: ven 2 en cola y la hora de arranque', await esperar(() => juanes.busqueda && juanes.busqueda.enCola === 2 && juanes.busqueda.empiezaEn));
    mafe.enviar({ type: 'partida_buscar' });
    check('los tres (en dos coordinadores) quedan en la MISMA sala pública', await esperar(() => js.every(j => j.sala && j.sala.tipo === 'publica' && j.sala.codigo === valen.sala.codigo), 30000));
    check('la pública empieza sola tras la cuenta', await esperar(() => js.every(j => j.sala.estado === 'jugando'), 20000));
  }

  console.log(`\n${ok} correctas, ${mal} fallidas`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
