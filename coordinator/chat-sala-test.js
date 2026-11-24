// Prueba del CHAT INDEPENDIENTE POR SALA (partida), con servicios de verdad: auth + TRES coordinadores.
//   node chat-sala-test.js http://localhost:4000 ws://localhost:5001 ws://localhost:5002 ws://localhost:5003
// Valen (coord 1) crea una sala y Juanes (coord 2) entra. Carla (coord 3) NO está en la sala.
// Un espectador (coord 3) mira la partida. Se comprueba que:
//   · los mensajes del canal "sala:CODIGO" llegan a los jugadores de esa sala, estén en el coordinador que estén,
//     y a los espectadores que la miran; a Carla NO le llegan;
//   · Carla no puede escribir en ese canal (chat_no_en_sala) ni pedir su historial;
//   · el chat general sigue funcionando para todos;
//   · quien entra después a la sala recibe el historial de la partida;
//   · al cerrarse la sala, su canal se borra.
const WebSocket = require('ws');
const [AUTH, C1, C2, C3] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const suf = Math.random().toString(36).slice(2, 6);
let ok = 0, mal = 0;
const check = (n, c, info) => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { mal++; console.log(`  ✘ ${n}${info !== undefined ? `\n      ${JSON.stringify(info).slice(0, 400)}` : ''}`); } };
async function esperar(cond, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await sleep(30); } return false; }

async function token(nombre) {
  const body = JSON.stringify({ username: `${nombre}_${suf}`, password: 'secret123' }), H = { 'Content-Type': 'application/json' };
  await fetch(`${AUTH}/register`, { method: 'POST', headers: H, body });
  return (await (await fetch(`${AUTH}/login`, { method: 'POST', headers: H, body })).json()).token;
}
function nuevo(nombre) {
  const c = { nombre, sala: undefined, msgs: [], historiales: [], errores: [], userId: null };
  c.de = (canal) => c.msgs.filter(m => (m.canal || 'general') === canal).map(m => m.text);
  c.on = (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') c.userId = m.you.userId;
    if (m.type === 'sala_estado') c.sala = m.sala;
    if (m.type === 'chat_msg') c.msgs.push(m.msg);
    if (m.type === 'chat_historial') c.historiales.push(m);
    if (m.type === 'chat_error' || m.type === 'error') c.errores.push(m.code);
  };
  c.enviar = (o) => c.ws.send(JSON.stringify(o));
  c.decir = (text, canal) => c.enviar({ type: 'chat_send', text, canal });
  return c;
}
function jugador(nombre, url, tk) {
  const c = nuevo(nombre);
  return new Promise((listo) => {
    c.ws = new WebSocket(`${url}/connect?token=${tk}&seq=${Date.now()}`);
    c.ws.on('message', (raw) => { c.on(raw); if (c.userId && c.historiales.length) listo(c); });
    c.ws.on('error', () => {});
  });
}
function espectador(url) {
  const c = nuevo('Espectador');
  return new Promise((listo) => {
    c.ws = new WebSocket(`${url}/spectate`);
    c.ws.on('message', (raw) => { c.on(raw); if (c.historiales.length) listo(c); });
    c.ws.on('error', () => {});
  });
}

(async () => {
  const [tv, tj, tc, tm] = await Promise.all(['valen', 'juanes', 'carla', 'mafe'].map(token));
  const valen = await jugador('Valen', C1, tv), juanes = await jugador('Juanes', C2, tj), carla = await jugador('Carla', C3, tc);

  console.log('\nSala');
  valen.enviar({ type: 'sala_crear', maxJugadores: 4, nivel: 'suave' });
  check('Valen crea una sala', await esperar(() => valen.sala && valen.sala.codigo));
  const codigo = valen.sala.codigo, canal = `sala:${codigo}`;
  await sleep(300);
  juanes.enviar({ type: 'sala_unirse', codigo });
  check('Juanes (otro coordinador) entra a la sala', await esperar(() => juanes.sala && juanes.sala.codigo === codigo && valen.sala.jugadores.length === 2));
  const esp = await espectador(C3);
  esp.enviar({ type: 'espectar_sala', codigo });
  check('el espectador (coord 3) recibe el historial del chat de la sala al mirarla',
    await esperar(() => esp.historiales.some(h => h.canal === canal)));

  console.log('\nChat de la partida');
  valen.decir('hola sala desde coord-1', canal);
  juanes.decir('hola sala desde coord-2', canal);
  check('los dos jugadores (en coordinadores distintos) reciben los dos mensajes de la sala',
    await esperar(() => [valen, juanes].every(j => j.de(canal).length === 2)), [valen.de(canal), juanes.de(canal)]);
  check('los mensajes llevan su canal', valen.msgs.filter(m => m.canal === canal).length === 2);
  check('el espectador que mira la sala también los recibe', await esperar(() => esp.de(canal).length === 2), esp.de(canal));
  await sleep(600);
  check('a Carla (fuera de la sala) NO le llega nada de la sala', carla.msgs.every(m => m.canal !== canal), carla.msgs);
  check('los mensajes de la sala no aparecen en el canal general', valen.de('general').length === 0);

  carla.decir('me cuelo', canal);
  check('Carla no puede escribir en una sala ajena → chat_no_en_sala', await esperar(() => carla.errores.includes('chat_no_en_sala')));
  carla.enviar({ type: 'chat_historial_pedir', canal });
  await sleep(500);
  check('ni pedir su historial', !carla.historiales.some(h => h.canal === canal));
  carla.decir('canal raro', 'sala:../../x');
  check('un canal con formato inválido se rechaza', await esperar(() => carla.errores.length >= 2), carla.errores);
  esp.decir('soy espectador', canal);
  check('el espectador no puede escribir (spectator_read_only)', await esperar(() => esp.errores.includes('spectator_read_only')));

  console.log('\nChat general (sigue igual)');
  carla.decir('hola a todos');
  check('el general llega a todos, en la sala o fuera', await esperar(() => [valen, juanes, carla, esp].every(c => c.de('general').includes('hola a todos'))));

  console.log('\nHistorial al entrar');
  const mafe = await jugador('Mafe', C3, tm);
  mafe.enviar({ type: 'sala_unirse', codigo });
  await esperar(() => mafe.sala && mafe.sala.codigo === codigo);
  mafe.enviar({ type: 'chat_historial_pedir', canal });
  check('Mafe (coord 3) entra y recibe el historial de la partida (2 mensajes)',
    await esperar(() => mafe.historiales.some(h => h.canal === canal && h.mensajes.length === 2)), mafe.historiales.map(h => [h.canal, h.mensajes.length]));
  mafe.decir('llegué', canal);
  check('y ya puede escribir: le llega a los demás', await esperar(() => [valen, juanes, esp].every(c => c.de(canal).includes('llegué'))));

  console.log('\nSalir y cerrar');
  mafe.enviar({ type: 'sala_salir' });
  await esperar(() => mafe.sala === null);
  await sleep(300);
  mafe.decir('ya no estoy', canal);
  check('quien sale de la sala ya no puede escribir en ella', await esperar(() => mafe.errores.includes('chat_no_en_sala')));
  valen.enviar({ type: 'sala_salir' }); juanes.enviar({ type: 'sala_salir' });
  check('todos salen: la sala se cierra', await esperar(() => valen.sala === null && juanes.sala === null));
  await sleep(500);
  const esp2 = await espectador(C1);
  esp2.enviar({ type: 'espectar_sala', codigo });
  await sleep(500);
  check('la sala cerrada ya no se puede mirar ni trae su chat', !esp2.historiales.some(h => h.canal === canal));

  console.log(`\n${ok} correctas, ${mal} fallidas`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
