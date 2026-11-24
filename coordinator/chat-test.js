// Prueba del CHAT DISTRIBUIDO con servicios de verdad: auth + TRES coordinadores (5001, 5002, 5003).
//   node chat-test.js http://localhost:4000 ws://localhost:5001 ws://localhost:5002 ws://localhost:5003 [--reinicio]
// Alicia, Bruno y Carla, cada uno en un coordinador distinto, escriben a la vez: todos deben terminar con
// los MISMOS mensajes en el MISMO orden. También: autor desde el JWT, longitud, caracteres de control,
// texto con HTML que viaja como texto, rate limit y silencio, e historial para quien llega tarde.
// Con --reinicio imprime REINICIAR_C: quien corre la prueba reinicia el tercer coordinador, y la prueba
// verifica que al volver recupera el historial desde sus peers (el chat vive en memoria).
const WebSocket = require('ws');
const [AUTH, C1, C2, C3] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const REINICIO = process.argv.includes('--reinicio');
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
/** Cliente que arma su lista como lo hace el navegador: cada mensaje en su lugar según (t, c, origin, seq) */
function cliente(nombre, url, tk) {
  const c = { nombre, lista: [], errores: [], historial: null, username: null };
  const clave = (m) => [m.t, m.c, m.origin, m.seq];
  const menor = (a, b) => { const x = clave(a), y = clave(b); for (let i = 0; i < 4; i++) { if (x[i] < y[i]) return true; if (x[i] > y[i]) return false; } return false; };
  const poner = (m) => { if (c.lista.some(x => x.id === m.id)) return; let i = c.lista.length; while (i > 0 && menor(m, c.lista[i - 1])) i--; c.lista.splice(i, 0, m); };
  return new Promise((listo) => {
    c.ws = new WebSocket(`${url}/connect?token=${tk}&seq=${Date.now()}`);
    c.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'welcome') c.username = m.you.username;
      if (m.type === 'chat_historial') { c.historial = m.mensajes; m.mensajes.forEach(poner); listo(c); }
      if (m.type === 'chat_msg') poner(m.msg);
      if (m.type === 'chat_error') c.errores.push(m.code);
    });
    c.ws.on('error', () => {});
    c.enviar = (o) => c.ws.send(JSON.stringify(o));
    c.decir = (text) => c.enviar({ type: 'chat_send', text });
  });
}
const textos = (c) => c.lista.map(m => `${m.username}: ${m.text}`);

(async () => {
  const [ta, tb, tc] = await Promise.all(['alicia', 'bruno', 'carla'].map(token));
  const alicia = await cliente('Alicia', C1, ta), bruno = await cliente('Bruno', C2, tb), carla = await cliente('Carla', C3, tc);
  const todos = [alicia, bruno, carla];

  console.log('\nConexión');
  check('cada cliente recibe el historial al conectarse (chat_historial)', todos.every(c => Array.isArray(c.historial)));

  console.log('\nMensajes entre tres coordinadores');
  const base = alicia.lista.length;
  alicia.decir('hola desde coord-a'); bruno.decir('qué tal desde coord-b'); carla.decir('buenas desde coord-c');
  check('los tres reciben los tres mensajes', await esperar(() => todos.every(c => c.lista.length >= base + 3)), todos.map(c => c.lista.length));
  check('y en el MISMO orden', todos.every(c => JSON.stringify(textos(c)) === JSON.stringify(textos(alicia))), todos.map(textos));
  check('el autor es el del JWT', alicia.lista.some(m => m.username === bruno.username && m.text === 'qué tal desde coord-b'));

  // Ráfaga concurrente: 3 mensajes cada uno, entrelazados
  for (let i = 0; i < 3; i++) { alicia.decir(`a${i}`); bruno.decir(`b${i}`); carla.decir(`c${i}`); }
  check('ráfaga de 9 mensajes concurrentes: todos con la misma lista', await esperar(() => todos.every(c => c.lista.length >= base + 12)
    && todos.every(c => JSON.stringify(textos(c)) === JSON.stringify(textos(alicia)))), todos.map(c => c.lista.length));
  const deA = alicia.lista.filter(m => /^a\d$/.test(m.text)).map(m => m.text);
  check('los mensajes de una misma persona conservan su orden (a0, a1, a2)', JSON.stringify(deA) === JSON.stringify(['a0', 'a1', 'a2']), deA);
  await sleep(10500);                                              // se vacía la ventana del rate limit

  console.log('\nValidación');
  alicia.enviar({ type: 'chat_send', text: 'soy otro', username: 'admin', userId: '1' });
  check('no se puede falsificar el autor', await esperar(() => bruno.lista.some(m => m.text === 'soy otro' && m.username === alicia.username)));
  alicia.decir('x'.repeat(201));
  check('más de 200 caracteres → chat_muy_largo', await esperar(() => alicia.errores.includes('chat_muy_largo')));
  alicia.decir('   \u0000\u0007 ​ ');
  check('vacío o solo caracteres de control → chat_vacio', await esperar(() => alicia.errores.includes('chat_vacio')));
  alicia.enviar({ type: 'chat_send', text: 12345 });
  check('texto que no es string → chat_invalido', await esperar(() => alicia.errores.includes('chat_invalido')));
  alicia.decir('linea1\nlinea2‮\u0008fin');
  check('saltos de línea y caracteres de control se limpian', await esperar(() => carla.lista.some(m => m.text === 'linea1 linea2fin')));
  const xss = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  bruno.decir(xss);
  check('el HTML viaja como TEXTO sin interpretar (el navegador lo pinta con textContent)', await esperar(() => carla.lista.some(m => m.text === xss)));
  await sleep(10500);

  console.log('\nRate limit');
  const antes = bruno.errores.length;
  for (let i = 0; i < 8; i++) bruno.decir(`spam ${i}`);
  await sleep(800);
  const llegaron = alicia.lista.filter(m => m.text.startsWith('spam ')).length;
  check('de 8 mensajes seguidos pasan 5 (5 cada 10 s)', llegaron === 5, llegaron);
  check('el resto recibe chat_rate_limited', bruno.errores.slice(antes).includes('chat_rate_limited'), bruno.errores.slice(antes));
  check('quien insiste queda silenciado (chat_silenciado)', bruno.errores.slice(antes).includes('chat_silenciado'), bruno.errores.slice(antes));
  bruno.decir('¿ya puedo?');
  await sleep(500);
  check('silenciado: tampoco pasa el siguiente', !alicia.lista.some(m => m.text === '¿ya puedo?'));
  carla.decir('los demás sí pueden hablar');
  check('el límite es por persona: los demás siguen escribiendo', await esperar(() => alicia.lista.some(m => m.text === 'los demás sí pueden hablar')));

  console.log('\nHistorial');
  const tarde = await cliente('Alicia (otra pestaña)', C3, ta);
  check('quien entra tarde recibe los últimos mensajes, en el mismo orden', JSON.stringify(textos(tarde).slice(-10)) === JSON.stringify(textos(alicia).slice(-10)), textos(tarde).slice(-3));

  if (REINICIO) {
    const ultimo = textos(alicia).at(-1);
    console.log('\nReinicia ahora el tercer coordinador. Esperando…');
    console.log('REINICIAR_C');
    await sleep(9000);
    let nuevo = null;
    for (let i = 0; i < 20 && !nuevo; i++) { try { nuevo = await Promise.race([cliente('Carla (vuelve)', C3, tc), sleep(1500).then(() => null)]); } catch { /* aún no */ } if (!nuevo) await sleep(500); }
    check('el coordinador reiniciado recupera el historial desde sus peers', !!nuevo && await esperar(() => textos(nuevo).includes(ultimo), 6000), nuevo && textos(nuevo).slice(-3));
  }

  console.log(`\n${ok} correctas, ${mal} fallidas`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
