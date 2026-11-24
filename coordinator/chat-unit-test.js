// Pruebas del chat SIN red: orden con entregas desordenadas, relojes desfasados, historial y saneo.
//   node chat-unit-test.js
// Tres coordinadores en el mismo proceso; el mesh falso entrega cada mensaje con un retraso AL AZAR
// (así llegan en distinto orden a cada uno) y cada coordinador puede tener el reloj corrido.
const assert = require('assert');
const { crearChat, limpiarTexto, comparar } = require('./chat');

let ok = 0, mal = 0;
const pruebas = [];
const prueba = (n, f) => pruebas.push([n, f]);
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

function red(ids, { desfase = {}, retrasoMax = 30, env = {} } = {}) {
  const nodos = new Map();
  for (const id of ids) {
    const nodo = { id, peers: new Set(), recibidos: [] };
    const ahora = () => Date.now() + (desfase[id] || 0);
    const entregar = (para, payload) => setTimeout(() => nodos.get(para) && nodos.get(para).chat.alMensajePeer(JSON.parse(JSON.stringify({ ...payload, origin: id })), id), Math.random() * retrasoMax);
    nodo.chat = crearChat({ COORDINATOR_ID: id, ahora, env: { CHAT_POR_VENTANA: '1000', ...env },
      replicate: (p) => { for (const otro of nodo.peers) entregar(otro, p); },
      sendPeer: (otro, p) => { entregar(otro, p); return true; },
      send: (_ws, p) => nodo.recibidos.push(p),
      difundir: (p) => nodo.recibidos.push(p) });
    nodos.set(id, nodo);
  }
  for (const a of ids) for (const b of ids) if (a !== b) nodos.get(a).peers.add(b);
  const ws = {};
  return { nodos, decir: (id, user, text) => nodos.get(id).chat.alMensajeCliente(ws, user, user, { type: 'chat_send', text }) };
}
const ids = (n) => n.chat.mensajes.map(m => m.id);

prueba('entregas desordenadas: los tres coordinadores terminan con el MISMO historial y el mismo orden', async () => {
  const r = red(['coord-a', 'coord-b', 'coord-c'], { retrasoMax: 40 });
  for (let i = 0; i < 15; i++) { r.decir('coord-a', 'alicia', `a${i}`); r.decir('coord-b', 'bruno', `b${i}`); r.decir('coord-c', 'carla', `c${i}`); await esperar(Math.random() * 5); }
  await esperar(150);
  const [a, b, c] = [...r.nodos.values()];
  assert.strictEqual(a.chat.mensajes.length, 45);
  assert.deepStrictEqual(ids(a), ids(b)); assert.deepStrictEqual(ids(a), ids(c));
  for (const p of ['a', 'b', 'c']) {                                // el orden de cada autor se respeta
    const suyos = a.chat.mensajes.filter(m => m.text[0] === p).map(m => Number(m.text.slice(1)));
    assert.deepStrictEqual(suyos, [...suyos].sort((x, y) => x - y));
  }
});

prueba('causalidad: si B respondió después de ver el mensaje de A, va después aunque el reloj de B esté atrasado 5 s', async () => {
  const r = red(['coord-a', 'coord-b'], { desfase: { 'coord-b': -5000 }, retrasoMax: 1 });
  r.decir('coord-a', 'alicia', 'hola');
  await esperar(20);
  r.decir('coord-b', 'bruno', 'qué tal (respuesta)');
  await esperar(20);
  for (const n of r.nodos.values()) assert.deepStrictEqual(n.chat.mensajes.map(m => m.text), ['hola', 'qué tal (respuesta)']);
});

prueba('un peer con el reloj 10 minutos adelantado no arrastra el reloj de los demás', async () => {
  const r = red(['coord-a', 'coord-b'], { desfase: { 'coord-b': 600000 }, retrasoMax: 1 });
  r.decir('coord-b', 'bruno', 'vengo del futuro');
  await esperar(20);
  const a = r.nodos.get('coord-a').chat;
  assert(a.reloj().t < Date.now() + 1000, 'coord-a adoptó el reloj adelantado');
  assert.strictEqual(a.mensajes.length, 1);                         // el mensaje sí se guarda (ordenado con su marca)
});

prueba('historial: guarda solo los últimos CHAT_HISTORIAL y descarta duplicados', async () => {
  const r = red(['coord-a', 'coord-b'], { env: { CHAT_HISTORIAL: '10' }, retrasoMax: 1 });
  for (let i = 0; i < 25; i++) r.decir('coord-a', 'alicia', `m${i}`);
  await esperar(30);
  const b = r.nodos.get('coord-b').chat;
  assert.strictEqual(b.mensajes.length, 10);
  assert.strictEqual(b.mensajes[0].text, 'm15');
  const copia = b.mensajes[3];
  b.alMensajePeer({ type: 'chat_msg', msg: copia, origin: 'coord-a' }, 'coord-a');
  assert.strictEqual(b.mensajes.length, 10);
});

prueba('un coordinador que entra al mesh mezcla el historial de sus peers (chat_historial)', async () => {
  const r = red(['coord-a', 'coord-b', 'coord-c'], { retrasoMax: 1 });
  r.nodos.get('coord-a').peers.delete('coord-c'); r.nodos.get('coord-b').peers.delete('coord-c');
  r.nodos.get('coord-c').peers.clear();
  r.decir('coord-a', 'alicia', 'uno'); r.decir('coord-b', 'bruno', 'dos');
  await esperar(20);
  assert.strictEqual(r.nodos.get('coord-c').chat.mensajes.length, 0);
  r.nodos.get('coord-a').chat.alConectarPeer('coord-c');             // como hace handleHello
  await esperar(20);
  assert.deepStrictEqual(r.nodos.get('coord-c').chat.mensajes.map(m => m.text), r.nodos.get('coord-a').chat.mensajes.map(m => m.text));
});

prueba('no se acepta por el mesh un mensaje "en vivo" cuyo origin no es quien lo manda, ni uno mal formado', () => {
  const r = red(['coord-a', 'coord-b']);
  const b = r.nodos.get('coord-b').chat;
  const falso = { id: 'coord-x:1:1', origin: 'coord-x', seq: 1, t: Date.now(), c: 0, userId: '9', username: 'impostor', text: 'hola' };
  b.alMensajePeer({ type: 'chat_msg', msg: falso }, 'coord-a');
  b.alMensajePeer({ type: 'chat_msg', msg: { ...falso, origin: 'coord-a', text: 'x'.repeat(500) } }, 'coord-a');
  b.alMensajePeer({ type: 'chat_msg', msg: { ...falso, origin: 'coord-a', t: 'mañana' } }, 'coord-a');
  assert.strictEqual(b.mensajes.length, 0);
});

prueba('limpiarTexto: sin control, sin bidi, una sola línea; el HTML queda como texto', () => {
  assert.strictEqual(limpiarTexto('  hola\n\tmundo\u0000‮  '), 'hola mundo');
  assert.strictEqual(limpiarTexto('<b>hola</b>'), '<b>hola</b>');
});

prueba('orden total: (t, c, origin, seq)', () => {
  const m = (t, c, origin, seq) => ({ t, c, origin, seq });
  assert(comparar(m(1, 0, 'b', 1), m(2, 0, 'a', 1)) < 0);
  assert(comparar(m(1, 1, 'a', 1), m(1, 0, 'b', 1)) > 0);
  assert(comparar(m(1, 0, 'a', 9), m(1, 0, 'b', 1)) < 0);
});

(async () => {
  for (const [n, f] of pruebas) {
    try { await f(); ok++; console.log(`  ✔ ${n}`); } catch (e) { mal++; console.log(`  ✘ ${n}\n      ${e.message}`); }
  }
  console.log(`\n${ok} correctas, ${mal} fallidas`);
  process.exit(mal ? 1 : 0);
})();
