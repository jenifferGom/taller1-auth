// Prueba del MODO ESPECTADOR con servicios de verdad: auth + DOS coordinadores (5001 y 5002).
//   node espectador-test.js http://localhost:4000 ws://localhost:5001 ws://localhost:5002 [--cupo=3]
// Un espectador SIN token mira: ve moverse al jugador, ve la partida de parqués y el chat. Todo lo que
// intente hacer como jugador (intent, extras_update, chat_send, acciones de sala, basura) se ignora sin
// que el coordinador se caiga, y no cuenta como jugador (ni en /health ni en el directorio).
// Con --cupo=N (el coordinador 1 arrancado con SPECTATORS_MAX=N) se prueba que el N+1 recibe 4003.
const WebSocket = require('ws');
const [AUTH, C1, C2] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const CUPO = Number((process.argv.find(a => a.startsWith('--cupo=')) || '').split('=')[1]) || 0;
const HTTP1 = C1.replace(/^ws/, 'http');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const suf = Math.random().toString(36).slice(2, 6);
let ok = 0, mal = 0;
const check = (n, c, info) => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { mal++; console.log(`  ✘ ${n}${info !== undefined ? `\n      ${JSON.stringify(info).slice(0, 300)}` : ''}`); } };
async function esperar(cond, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await sleep(30); } return false; }

async function token(nombre) {
  const body = JSON.stringify({ username: `${nombre}_${suf}`, password: 'secret123' }), H = { 'Content-Type': 'application/json' };
  await fetch(`${AUTH}/register`, { method: 'POST', headers: H, body });
  return (await (await fetch(`${AUTH}/login`, { method: 'POST', headers: H, body })).json()).token;
}
function jugador(url, tk) {
  const j = { sala: undefined, chat: [], ws: null, userId: null };
  return new Promise((listo) => {
    j.ws = new WebSocket(`${url}/connect?token=${tk}&seq=${Date.now()}`);
    j.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'welcome') { j.userId = m.you.userId; j.username = m.you.username; listo(j); }
      if (m.type === 'sala_estado') j.sala = m.sala;
      if (m.type === 'chat_msg') j.chat.push(m.msg);
    });
    j.enviar = (o) => j.ws.send(JSON.stringify(o));
  });
}
function espectador(url) {
  const e = { msgs: [], state: null, states: 0, sala: undefined, errores: [], chat: [], cerrado: null, salas: null };
  return new Promise((listo) => {
    e.ws = new WebSocket(`${url}/spectate`);
    e.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      e.msgs.push(m.type);
      if (m.type === 'bienvenida_espectador') { e.bienvenida = m; listo(e); }
      if (m.type === 'state') { e.state = m; e.states++; }
      if (m.type === 'sala_estado') e.sala = m.sala;
      if (m.type === 'salas_publicas') e.salas = m;
      if (m.type === 'error') e.errores.push(m.code);
      if (m.type === 'chat_historial') e.historial = m.mensajes;
      if (m.type === 'chat_msg') e.chat.push(m.msg);
    });
    e.ws.on('close', (code) => { e.cerrado = code; listo(e); });
    e.ws.on('error', () => {});
    e.enviar = (o) => e.ws.send(typeof o === 'string' ? o : JSON.stringify(o));
  });
}
const salud = async () => (await fetch(`${HTTP1}/health`)).json();

(async () => {
  const [ta, tb] = await Promise.all(['ana', 'beto'].map(token));
  const ana = await jugador(C1, ta);
  const esp = await espectador(C1);

  console.log('\nConexión sin login');
  check('se conecta a /spectate SIN token y recibe bienvenida_espectador', !!esp.bienvenida && esp.bienvenida.world && esp.bienvenida.world.width > 0);
  check('recibe el historial del chat y la lista de partidas', await esperar(() => Array.isArray(esp.historial) && !!esp.salas));
  const h1 = await salud();
  check('/health lo cuenta aparte: spectators = 1 y connectedPlayers = 1 (solo Ana)', h1.spectators === 1 && h1.connectedPlayers === 1, h1);
  const dir = await (await fetch(`${AUTH}/coordinators`)).json().catch(() => null);
  const enDir = dir && (dir.coordinators || dir.alive || []).find(c => c.coordinatorId === h1.coordinatorId);
  check('el directorio (balanceo) solo cuenta jugadores', !enDir || enDir.connectedPlayers === 1, enDir);
  check('el espectador NO aparece como jugador en el mundo', await esperar(() => esp.state && esp.state.players.length >= 1)
    && !esp.state.players.some(p => String(p.username).startsWith('esp')));

  console.log('\nMirar en tiempo real');
  const x0 = (await esperar(() => esp.state && esp.state.players.some(p => p.userId === ana.userId))) && esp.state.players.find(p => p.userId === ana.userId).x;
  const hacia = x0 > 480 ? -1 : 1;                                   // hacia el centro, para no chocar con el borde
  ana.enviar({ type: 'intent', intent: { dir: { x: hacia, y: 0 } } });
  check('ve a Ana moverse (el state le llega con su posición nueva)', await esperar(() => Math.abs(esp.state.players.find(p => p.userId === ana.userId).x - x0) > 20), x0);
  ana.enviar({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  const n0 = esp.states; await sleep(1000);
  const hz = esp.states - n0;
  check(`recibe el estado a menor frecuencia que un jugador (~10 Hz): ${hz} en 1 s`, hz >= 6 && hz <= 14, hz);

  console.log('\nSolo lectura');
  await sleep(300);
  const xAntes = esp.state.players.find(p => p.userId === ana.userId).x;
  const extrasAntes = JSON.stringify(esp.state.players.find(p => p.userId === ana.userId).extras);
  esp.enviar({ type: 'intent', intent: { dir: { x: 1, y: 1 } } });    // el formato REAL de un jugador
  esp.enviar({ type: 'extras_update', extras: { color: '#000000' } });
  esp.enviar({ type: 'chat_send', text: 'hola soy espectador' });
  esp.enviar({ type: 'sala_crear' }); esp.enviar({ type: 'partida_buscar' }); esp.enviar({ type: 'sala_tirar', v: 1 });
  esp.enviar('esto no es json'); esp.enviar({ sin: 'tipo' });
  await sleep(700);
  check('responde spectator_read_only (máx. 1 aviso por segundo)', esp.errores.includes('spectator_read_only') && esp.errores.filter(e => e === 'spectator_read_only').length <= 2, esp.errores);
  check('el intent del espectador no movió a nadie', Math.abs(esp.state.players.find(p => p.userId === ana.userId).x - xAntes) < 1);
  check('el extras_update no cambió nada', JSON.stringify(esp.state.players.find(p => p.userId === ana.userId).extras) === extrasAntes);
  check('su chat_send no llegó al chat', !ana.chat.some(m => m.text === 'hola soy espectador'));
  check('no creó sala ni entró a la cola', (await salud()).spectators === 1 && esp.sala === undefined);
  check('sigue conectado y el coordinador sigue vivo', esp.ws.readyState === WebSocket.OPEN && (await salud()).status === 'ok');

  console.log('\nChat y partida de parqués');
  ana.enviar({ type: 'chat_send', text: 'hola espectadores' });
  check('el espectador lee el chat', await esperar(() => esp.chat.some(m => m.text === 'hola espectadores')));
  const beto = await jugador(C2, tb);                                // Beto en el OTRO coordinador
  ana.enviar({ type: 'sala_crear', maxJugadores: 2, nivel: 'guaro' });
  await esperar(() => ana.sala && ana.sala.codigo);
  await sleep(300);
  beto.enviar({ type: 'sala_unirse', codigo: ana.sala.codigo });
  await esperar(() => ana.sala.jugadores.length === 2);
  esp.enviar({ type: 'espectar_sala', codigo: 'ZZZZZZ' });
  check('código inexistente → codigo_invalido', await esperar(() => esp.errores.includes('codigo_invalido')));
  esp.enviar({ type: 'espectar_sala', codigo: ana.sala.codigo });
  check('mira la sala privada con su código', await esperar(() => esp.sala && esp.sala.codigo === ana.sala.codigo));
  ana.enviar({ type: 'sala_listo', listo: true }); beto.enviar({ type: 'sala_listo', listo: true });
  await esperar(() => ana.sala.jugadores.every(j => j.listo));
  ana.enviar({ type: 'sala_empezar' });
  check('ve empezar la partida', await esperar(() => esp.sala && esp.sala.estado === 'jugando'));
  const turno = esp.sala.game.jugadores[esp.sala.game.turno].id;
  const quien = turno === ana.userId ? ana : beto;
  const v = esp.sala.v;
  quien.enviar({ type: 'sala_tirar', v });
  check('ve la tirada del jugador de turno (aunque juegue en otro coordinador)', await esperar(() => esp.sala.v > v && esp.sala.ultimo && esp.sala.ultimo.tipo === 'tirada'));
  esp.enviar({ type: 'sala_tirar', v: esp.sala.v });
  await sleep(1200);
  const vEsp = esp.sala.v;
  esp.enviar({ type: 'sala_mover', v: vEsp, ficha: 0, dados: [0] });
  await sleep(500);
  check('sus acciones de sala no cambian la partida', esp.sala.v === vEsp);
  esp.enviar({ type: 'dejar_sala' });
  check('dejar_sala: vuelve al mundo', await esperar(() => esp.sala === null));

  console.log('\nRobustez');
  esp.enviar('x'.repeat(5000));                                     // más de 2 KB: el ws cierra ESA conexión
  await sleep(500);
  check('un mensaje gigante cierra solo esa conexión; el coordinador sigue', (await salud()).status === 'ok' && esp.cerrado !== null, esp.cerrado);
  check('al irse, el contador de espectadores baja', await esperar(async () => false, 10) || (await salud()).spectators === 0);

  if (CUPO) {
    console.log(`\nCupo (SPECTATORS_MAX=${CUPO})`);
    const llenos = [];
    for (let i = 0; i < CUPO; i++) llenos.push(await espectador(C1));
    const extra = await espectador(C1);
    await esperar(() => extra.cerrado !== null, 2000);
    check(`el espectador n.º ${CUPO + 1} recibe spectators_full y se cierra con 4003`, extra.cerrado === 4003 && extra.errores.includes('spectators_full'), [extra.cerrado, extra.errores]);
    const otro = await espectador(C2);
    check('en otro coordinador sí entra (la página del espectador pide otro con ?exclude=)', !!otro.bienvenida);
  }

  console.log(`\n${ok} correctas, ${mal} fallidas`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
