// Pruebas del parqués de Guaro Royal SIN red: reglas, partida, salas y cola de partidas públicas.
//   npm run test:parques        (o: node parques-test.js)
// Para probar lo distribuido se arman varios "coordinadores" en este mismo proceso, cada uno con su
// propio Map de jugadores y un mesh falso que entrega los mensajes como lo haría el WebSocket /peer.
const assert = require('assert');
const R = require('./parques/GameRules');
const GM = require('./parques/GameManager');
const { aplicarSala, nuevaSala } = require('./parques/RoomManager');
const { crearParques } = require('./parques');

let ok = 0, mal = 0;
const pendientes = [];
function prueba(nombre, fn) { pendientes.push([nombre, fn]); }
function seccion(nombre) { pendientes.push([null, nombre]); }
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function hasta(cond, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await esperar(5); } return false; }

// ── Mesh falso: N coordinadores en el mismo proceso ──
const OPEN = 1;
function crearRed(ids, env = {}) {
  const nodos = new Map();
  for (const id of ids) {
    const nodo = { id, players: new Map(), peers: new Map() };
    const replicate = (payload) => { for (const [, r] of nodo.peers) r.ws.send(JSON.stringify({ ...payload, origin: id })); };
    const send = (ws, payload) => ws.recibir(payload);
    nodo.parques = crearParques({ COORDINATOR_ID: id, players: nodo.players, peers: nodo.peers, replicate, send,
      WebSocket: { OPEN }, env: { PUBLICA_ESPERA_MS: '300', PUBLICA_CUENTA_MS: '200', SALA_ABANDONADA_MS: '60000', ...env } });
    nodos.set(id, nodo);
  }
  const conectar = (a, b) => {
    const A = nodos.get(a), B = nodos.get(b);
    const enlace = (de, para) => ({ readyState: OPEN, send: (raw) => setImmediate(() => {
      if (!para.peers.has(de.id)) return;                           // ya se cortó
      const msg = JSON.parse(raw);
      if (msg.origin !== de.id) return;
      para.parques.alMensajePeer(msg, msg.origin);
    }) });
    A.peers.set(b, { ws: enlace(A, B) }); B.peers.set(a, { ws: enlace(B, A) });
    A.parques.alConectarPeer(b); B.parques.alConectarPeer(a);
  };
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) conectar(ids[i], ids[j]);
  const red = {
    nodos,
    /** un jugador conectado al coordinador `en`; los demás lo ven como remoto (como hace player_joined) */
    jugador(userId, nombre, en) {
      const j = { userId, nombre, en, msgs: [], sala: undefined, jugadas: [], busqueda: null, errores: [] };
      j.ws = { readyState: OPEN, recibir: (m) => {
        j.msgs.push(m);
        if (m.type === 'sala_estado') { j.sala = m.sala; j.jugadas = m.jugadas || []; }
        if (m.type === 'busqueda_estado') j.busqueda = m;
        if (m.type === 'sala_error') j.errores.push(m.code);
      } };
      for (const [id, n] of nodos) n.players.set(userId, { username: nombre, origin: en, socket: id === en ? j.ws : null });
      nodos.get(en).parques.alBienvenida(j.ws, userId);
      j.enviar = (msg) => nodos.get(j.en).parques.alMensajeCliente(j.ws, userId, nombre, msg);
      /** se pasa a otro coordinador (rebalanceo o recarga) */
      j.mudarA = (otro) => {
        j.en = otro;
        for (const [id, n] of nodos) n.players.set(userId, { username: nombre, origin: otro, socket: id === otro ? j.ws : null });
        nodos.get(otro).parques.alBienvenida(j.ws, userId);
      };
      return j;
    },
    /** espera a que todos los coordinadores tengan la sala (la réplica viaja por el mesh) */
    replicada: (codigo) => hasta(() => [...nodos.values()].every(n => n.parques.rooms.salas.has(codigo))),
    /** se cae un coordinador: los demás lo sacan de sus peers y sus jugadores quedan sin coordinador */
    apagar(id) {
      const caido = nodos.get(id);
      for (const [otro, n] of nodos) if (n.peers.delete(id)) n.parques.alPerderPeer(id);
      caido.peers.clear();
      nodos.delete(id);
    },
  };
  return red;
}

// ─────────────────────────────────────────────────────────────
seccion('Paso 1 · Salas (RoomManager)');

prueba('crear sala privada: código de 6, el creador es anfitrión y queda en espera', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a');
  ana.enviar({ type: 'sala_crear', maxJugadores: 3, nivel: 'guaro' });
  assert(await hasta(() => ana.sala));
  assert.match(ana.sala.codigo, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.strictEqual(ana.sala.tipo, 'privada');
  assert.strictEqual(ana.sala.anfitrion, '1');
  assert.strictEqual(ana.sala.maxJugadores, 3);
  assert.strictEqual(ana.sala.nivel, 'guaro');
  assert.strictEqual(ana.sala.duenio, 'coord-a');
});

prueba('la sala se replica: el otro coordinador tiene la copia con la misma versión', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a');
  ana.enviar({ type: 'sala_crear' });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  assert(await hasta(() => red.nodos.get('coord-b').parques.rooms.salas.has(ana.sala.codigo)));
  assert.strictEqual(red.nodos.get('coord-b').parques.rooms.salas.get(ana.sala.codigo).v, ana.sala.v);
});

prueba('unirse con el código correcto desde OTRO coordinador', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b');
  ana.enviar({ type: 'sala_crear' });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  beto.enviar({ type: 'sala_unirse', codigo: ana.sala.codigo.toLowerCase() });   // minúsculas también sirven
  assert(await hasta(() => beto.sala && ana.sala.jugadores.length === 2));
  assert.strictEqual(beto.sala.v, ana.sala.v);
  assert.deepStrictEqual(beto.sala.jugadores.map(j => j.color), [0, 1]);
});

prueba('código incorrecto: error sin revelar qué salas existen', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b');
  ana.enviar({ type: 'sala_crear' });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  beto.enviar({ type: 'sala_unirse', codigo: 'ZZZZZZ' });
  assert(await hasta(() => beto.errores.includes('codigo_invalido')));
  beto.enviar({ type: 'sala_unirse', codigo: 'abc' });
  assert(await hasta(() => beto.errores.filter(e => e === 'codigo_invalido').length === 2));
  assert(!beto.sala);
});

prueba('cupo lleno y no se puede estar en dos salas', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b'), caro = red.jugador('3', 'Caro', 'coord-b');
  ana.enviar({ type: 'sala_crear', maxJugadores: 2 });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  beto.enviar({ type: 'sala_unirse', codigo: ana.sala.codigo });
  await hasta(() => beto.sala);
  caro.enviar({ type: 'sala_unirse', codigo: ana.sala.codigo });
  assert(await hasta(() => caro.errores.includes('sala_llena')));
  beto.enviar({ type: 'sala_crear' });
  assert(await hasta(() => beto.errores.includes('ya_en_sala')));
});

prueba('la capacidad se acota al rango del .env (SALA_PRIVADA_MAX=3)', async () => {
  const red = crearRed(['coord-a'], { SALA_PRIVADA_MAX: '3' });
  const ana = red.jugador('1', 'Ana', 'coord-a');
  ana.enviar({ type: 'sala_crear', maxJugadores: 9 });
  assert(await hasta(() => ana.sala));
  assert.strictEqual(ana.sala.maxJugadores, 3);
});

prueba('salir: en espera se borra al jugador; el anfitrión pasa al siguiente; sala vacía se cierra', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b');
  ana.enviar({ type: 'sala_crear' });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  const codigo = ana.sala.codigo;
  beto.enviar({ type: 'sala_unirse', codigo });
  await hasta(() => beto.sala);
  ana.enviar({ type: 'sala_salir' });
  assert(await hasta(() => ana.sala === null && beto.sala.anfitrion === '2' && beto.sala.jugadores.length === 1));
  beto.enviar({ type: 'sala_salir' });
  assert(await hasta(() => beto.sala === null && !red.nodos.get('coord-b').parques.rooms.salas.has(codigo)));
});

prueba('el dueño rechaza una acción que llega por el mesh de un coordinador que NO es el del jugador', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a');
  red.jugador('2', 'Beto', 'coord-b');
  ana.enviar({ type: 'sala_crear' });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  const a = red.nodos.get('coord-a');
  // coord-b intenta hacer pasar a Ana (que está en coord-a) por otra acción: se descarta
  a.parques.alMensajePeer({ type: 'sala_accion', origin: 'coord-b', codigo: ana.sala.codigo, accion: { tipo: 'salir', userId: '1' } }, 'coord-b');
  await esperar(30);
  assert.strictEqual(ana.sala.jugadores.length, 1);
});

prueba('recargar o cambiar de coordinador: al volver recibe su sala', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-a');
  ana.enviar({ type: 'sala_crear' });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  beto.enviar({ type: 'sala_unirse', codigo: ana.sala.codigo });
  await hasta(() => beto.sala);
  await esperar(20);
  beto.sala = undefined;
  beto.mudarA('coord-b');
  assert(await hasta(() => beto.sala && beto.sala.codigo === ana.sala.codigo));
  beto.enviar({ type: 'sala_listo', listo: true });                  // sigue pudiendo actuar desde el otro coordinador
  assert(await hasta(() => ana.sala.jugadores.find(j => j.id === '2').listo));
});

prueba('se cae el dueño: el coordinador vivo de id menor adopta la sala y sube la versión', async () => {
  const red = crearRed(['coord-a', 'coord-b', 'coord-c']);
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b'), caro = red.jugador('3', 'Caro', 'coord-c');
  ana.enviar({ type: 'sala_crear' });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  const codigo = ana.sala.codigo;
  beto.enviar({ type: 'sala_unirse', codigo }); caro.enviar({ type: 'sala_unirse', codigo });
  await hasta(() => beto.sala && caro.sala && caro.sala.jugadores.length === 3);
  const v = beto.sala.v;
  red.apagar('coord-a');
  assert(await hasta(() => beto.sala.duenio === 'coord-b' && caro.sala.duenio === 'coord-b', 5000), 'nadie adoptó la sala');
  assert(beto.sala.v > v);
  caro.enviar({ type: 'sala_listo', listo: true });                  // el nuevo dueño atiende
  assert(await hasta(() => beto.sala.jugadores.find(j => j.id === '3').listo));
});

prueba('gana la versión más alta; en empate, el dueño de id menor', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a');
  ana.enviar({ type: 'sala_crear' });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  const b = red.nodos.get('coord-b').parques.rooms;
  await hasta(() => b.salas.has(ana.sala.codigo));
  const vieja = { ...ana.sala, v: ana.sala.v - 1, nombre: 'vieja' };
  b.alMensajePeer({ type: 'sala_upsert', sala: vieja }, 'coord-a');
  assert.notStrictEqual(b.salas.get(ana.sala.codigo).nombre, 'vieja');
  const empate = { ...ana.sala, duenio: 'coord-z', marca: 'z' };
  b.alMensajePeer({ type: 'sala_upsert', sala: empate }, 'coord-a');
  assert.notStrictEqual(b.salas.get(ana.sala.codigo).marca, 'z');
});

// ─────────────────────────────────────────────────────────────
seccion('Paso 2 · Partida pública (Matchmaking)');

prueba('cuatro jugadores en tres coordinadores buscan y quedan en la MISMA sala pública', async () => {
  const red = crearRed(['coord-a', 'coord-b', 'coord-c']);
  const js = [red.jugador('1', 'Ana', 'coord-b'), red.jugador('2', 'Beto', 'coord-c'), red.jugador('3', 'Caro', 'coord-c'), red.jugador('4', 'Dani', 'coord-a')];
  for (const j of js) j.enviar({ type: 'partida_buscar' });
  assert(await hasta(() => js.every(j => j.sala && j.sala.jugadores.length === 4)), 'no se formó la sala');
  assert(js.every(j => j.sala.codigo === js[0].sala.codigo));
  assert.strictEqual(js[0].sala.tipo, 'publica');
  assert.strictEqual(js[0].sala.duenio, 'coord-a');                  // la crea quien lleva la cola (id menor)
  assert(js.every(j => j.busqueda && j.busqueda.buscando === false));
});

prueba('con el mínimo (2) arranca al vencer PUBLICA_ESPERA_MS; la sala empieza sola tras la cuenta', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b');
  ana.enviar({ type: 'partida_buscar' }); beto.enviar({ type: 'partida_buscar' });
  assert(await hasta(() => beto.busqueda && beto.busqueda.enCola === 2 && beto.busqueda.empiezaEn));
  assert(!ana.sala);
  assert(await hasta(() => ana.sala && beto.sala && ana.sala.jugadores.length === 2, 2000));
  assert.strictEqual(ana.sala.estado, 'espera');
  assert(await hasta(() => ana.sala.estado === 'jugando' && beto.sala.estado === 'jugando', 2000), 'no empezó sola');
});

prueba('un solo jugador espera sin formar sala; cancelar lo saca de la cola', async () => {
  const red = crearRed(['coord-a', 'coord-b']);
  const ana = red.jugador('1', 'Ana', 'coord-b');
  ana.enviar({ type: 'partida_buscar' });
  assert(await hasta(() => red.nodos.get('coord-a').parques.matchmaking.cola.size === 1));
  await esperar(400);
  assert(!ana.sala);
  ana.enviar({ type: 'partida_cancelar' });
  assert(await hasta(() => red.nodos.get('coord-a').parques.matchmaking.cola.size === 0 && ana.busqueda.buscando === false));
});

prueba('nadie queda en dos salas: buscar dos veces o buscar estando en una sala', async () => {
  const red = crearRed(['coord-a', 'coord-b'], { SALA_PUBLICA_MIN: '2', SALA_PUBLICA_MAX: '2' });
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b'), caro = red.jugador('3', 'Caro', 'coord-b');
  ana.enviar({ type: 'partida_buscar' }); ana.enviar({ type: 'partida_buscar' });
  beto.enviar({ type: 'partida_buscar' }); caro.enviar({ type: 'partida_buscar' });
  assert(await hasta(() => [ana, beto, caro].filter(j => j.sala).length === 2));
  await esperar(50);
  const salas = [...red.nodos.get('coord-a').parques.rooms.salas.values()];
  assert.strictEqual(salas.length, 1);
  assert.strictEqual(new Set(salas[0].jugadores.map(j => j.id)).size, 2);
  const conSala = [ana, beto, caro].find(j => j.sala);
  conSala.enviar({ type: 'partida_buscar' });
  assert(await hasta(() => conSala.errores.includes('ya_en_sala')));
  conSala.enviar({ type: 'sala_unirse', codigo: conSala.sala.codigo });   // a una pública no se entra con código
  const sinSala = [ana, beto, caro].find(j => !j.sala);
  sinSala.enviar({ type: 'partida_cancelar' });
  sinSala.enviar({ type: 'sala_unirse', codigo: conSala.sala.codigo });
  assert(await hasta(() => sinSala.errores.includes('sala_publica')));
});

prueba('se cae quien lleva la cola: el siguiente la reconstruye y la partida se forma igual', async () => {
  const red = crearRed(['coord-a', 'coord-b', 'coord-c'], { SALA_PUBLICA_MAX: '3' });
  const beto = red.jugador('2', 'Beto', 'coord-b'), caro = red.jugador('3', 'Caro', 'coord-c');
  beto.enviar({ type: 'partida_buscar' });
  assert(await hasta(() => red.nodos.get('coord-a').parques.matchmaking.cola.size === 1));
  red.apagar('coord-a');
  caro.enviar({ type: 'partida_buscar' });
  assert(await hasta(() => red.nodos.get('coord-b').parques.matchmaking.cola.size === 2), 'coord-b no reconstruyó la cola');
  assert(await hasta(() => beto.sala && caro.sala && beto.sala.codigo === caro.sala.codigo, 2000));
  assert.strictEqual(beto.sala.duenio, 'coord-b');
});

prueba('nivel en partidas públicas: solo se juntan los del mismo nivel y la sala lo guarda', async () => {
  const red = crearRed(['coord-a', 'coord-b'], { SALA_PUBLICA_MAX: '2' });
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b');
  const caro = red.jugador('3', 'Caro', 'coord-b'), dani = red.jugador('4', 'Dani', 'coord-a');
  ana.enviar({ type: 'partida_buscar', nivel: 'guaro' }); beto.enviar({ type: 'partida_buscar', nivel: 'suave' });
  await esperar(100);
  assert(!ana.sala && !beto.sala, 'no deben juntarse dos niveles distintos');
  assert.strictEqual(beto.busqueda.nivel, 'suave');
  caro.enviar({ type: 'partida_buscar', nivel: 'guaro' }); dani.enviar({ type: 'partida_buscar', nivel: 'suave' });
  assert(await hasta(() => [ana, beto, caro, dani].every(j => j.sala)));
  assert.strictEqual(ana.sala.codigo, caro.sala.codigo); assert.strictEqual(beto.sala.codigo, dani.sala.codigo);
  assert.strictEqual(ana.sala.nivel, 'guaro'); assert.strictEqual(beto.sala.nivel, 'suave');
  assert.deepStrictEqual(ana.sala.tablaShots, R.NIVELES.guaro);         // la tabla del recuadro de reglas es la del nivel
  assert(await hasta(() => ana.sala.estado === 'jugando', 2000));
  assert.strictEqual(ana.sala.game.nivel, 'guaro');                     // se mantiene en toda la partida
});

prueba('nivel inválido en la búsqueda: el servidor usa PUBLICA_NIVEL', async () => {
  const red = crearRed(['coord-a'], { PUBLICA_NIVEL: 'suave' });
  const ana = red.jugador('1', 'Ana', 'coord-a');
  ana.enviar({ type: 'partida_buscar', nivel: '<script>' });
  assert(await hasta(() => ana.busqueda && ana.busqueda.nivel === 'suave'));
});

prueba('cambiar de nivel mientras se busca: queda en la cola del nivel nuevo', async () => {
  const red = crearRed(['coord-a', 'coord-b'], { SALA_PUBLICA_MAX: '2' });
  const ana = red.jugador('1', 'Ana', 'coord-b'), beto = red.jugador('2', 'Beto', 'coord-a');
  ana.enviar({ type: 'partida_buscar', nivel: 'normal' });
  ana.enviar({ type: 'partida_buscar', nivel: 'guaro' });
  beto.enviar({ type: 'partida_buscar', nivel: 'guaro' });
  assert(await hasta(() => ana.sala && beto.sala && ana.sala.nivel === 'guaro'));
  assert.strictEqual(red.nodos.get('coord-a').parques.matchmaking.cola.size, 0);
});

prueba('crear o unirse a una privada mientras se busca: error claro', async () => {
  const red = crearRed(['coord-a']);
  const ana = red.jugador('1', 'Ana', 'coord-a');
  ana.enviar({ type: 'partida_buscar' });
  ana.enviar({ type: 'sala_crear' });
  assert(await hasta(() => ana.errores.includes('buscando_partida')));
});

// ─────────────────────────────────────────────────────────────
seccion('Pasos 3 y 4 · Reglas del parqués y de los shots (GameRules)');
const { CARCEL, CIELO, SALIDAS, SEGUROS } = R;
const J = (n) => [{ id: 'a', nombre: 'Ana', color: 0 }, { id: 'b', nombre: 'Beto', color: 1 },
  { id: 'c', nombre: 'Caro', color: 2 }, { id: 'd', nombre: 'Dani', color: 3 }].slice(0, n);
const con = (g, cambios) => ({ ...g, ...cambios, fichas: { ...g.fichas, ...(cambios.fichas || {}) } });

prueba('tablero: 8 seguros (2 por brazo) y las 4 salidas aparte', () => {
  assert.strictEqual(SEGUROS.length, 8); for (const s of SALIDAS) assert(!SEGUROS.includes(s));
});
prueba('dados del servidor: aplicarTirada rechaza dados fuera de 1..6', () => {
  assert.throws(() => R.aplicarTirada(R.crearPartida(J(2)), [7, 1]));
  assert.throws(() => R.aplicarTirada(R.crearPartida(J(2)), [1]));
});
prueba('todas en la cárcel: sin par, otro intento; al tercero shot de "noSale" (Modo Guaro) y pasa el turno', () => {
  let r = R.aplicarTirada(R.crearPartida(J(2), { nivel: 'guaro' }), [1, 2]);
  assert.strictEqual(r.game.turno, 0);
  r = R.aplicarTirada(r.game, [3, 4]); r = R.aplicarTirada(r.game, [5, 6]);
  assert.strictEqual(r.game.turno, 1);
  assert.deepStrictEqual(R.checkShotEvents(r.eventos, r.game).map(s => [s.jugadorId, s.razon]), [['a', 'noSale']]);
});
prueba('con par salen todas las fichas y vuelve a tirar', () => {
  const r = R.aplicarTirada(R.crearPartida(J(2)), [4, 4]);
  assert.deepStrictEqual(r.game.fichas.a, [0, 0, 0, 0]); assert.strictEqual(r.game.fase, 'tirar'); assert.strictEqual(r.game.turno, 0);
});
prueba('cada dado mueve una ficha distinta, o los dos la misma', () => {
  const g = R.aplicarTirada(con(R.crearPartida(J(2)), { fichas: { a: [0, 10, CARCEL, CARCEL] } }), [3, 5]).game;
  const movs = R.getValidMoves(g);
  assert(movs.some(m => m.ficha === 0 && m.hasta === 3) && movs.some(m => m.ficha === 1 && m.hasta === 15));
  assert(movs.some(m => m.ficha === 0 && m.dados.length === 2 && m.hasta === 8));
  const r1 = R.aplicarMovimiento(g, movs.find(m => m.ficha === 0 && m.dados.length === 1 && m.dados[0] === 0));
  assert.strictEqual(r1.game.fase, 'mover');
  const r2 = R.aplicarMovimiento(r1.game, R.getValidMoves(r1.game).find(m => m.ficha === 1));
  assert.deepStrictEqual(r2.game.fichas.a.slice(0, 2), [3, 15]); assert.strictEqual(r2.game.turno, 1);
});
prueba('al cielo solo con el número exacto; sin jugadas pasa el turno', () => {
  const g = R.aplicarTirada(con(R.crearPartida(J(2)), { fichas: { a: [CIELO - 3, CARCEL, CARCEL, CARCEL] } }), [5, 3]).game;
  assert(R.getValidMoves(g).some(m => m.alCielo) && !R.getValidMoves(g).some(m => m.hasta > CIELO));
  const r = R.aplicarTirada(con(R.crearPartida(J(2)), { fichas: { a: [CIELO - 1, CIELO, CIELO, CIELO] } }), [5, 6]);
  assert(r.eventos.some(e => e.tipo === 'sinMovimientos')); assert.strictEqual(r.game.turno, 1);
});
prueba('tres pares seguidos: sube al cielo la más adelantada y toman todos los demás', () => {
  const r = R.aplicarTirada(con(R.crearPartida(J(3)), { fichas: { a: [20, 5, CIELO, CIELO] }, paresSeguidos: 2 }), [6, 6]);
  assert.deepStrictEqual(r.game.fichas.a, [CIELO, 5, CIELO, CIELO]);
  assert.deepStrictEqual(R.checkShotEvents(r.eventos, r.game).filter(x => x.razon === 'tresPares').map(x => x.jugadorId).sort(), ['b', 'c']);
});
prueba('comer: el rival vuelve a la cárcel; no se come en seguro ni en la salida del otro', () => {
  const g = R.crearPartida(J(2));
  const abs = R.casillaAbsoluta(0, 10);
  g.fichas.a = [7, CARCEL, CARCEL, CARCEL]; g.fichas.b = [(abs - SALIDAS[1] + 68) % 68, CARCEL, CARCEL, CARCEL];
  const r = R.moveToken(g, 'a', 0, 3);
  assert.strictEqual(r.game.fichas.b[0], CARCEL);
  const g2 = R.crearPartida(J(2));
  const seguro = SEGUROS.find(s => s !== R.casillaAbsoluta(0, 0));
  g2.fichas.b = [(seguro - SALIDAS[1] + 68) % 68, 0, CARCEL, CARCEL];
  assert.strictEqual(R.checkCapture(g2, 'a', (seguro - SALIDAS[0] + 68) % 68).length, 0);
  assert.strictEqual(R.checkCapture(g2, 'a', (SALIDAS[1] - SALIDAS[0] + 68) % 68).length, 0);
});
prueba('las SALIDAS son seguro: ni al caer ni al salir de la cárcel se come a quien esté ahí', () => {
  // Beto (azul) está parado en la salida de Ana (amarilla)
  const relBetoEnSalidaDeAna = (SALIDAS[0] - SALIDAS[1] + 68) % 68;
  const g = R.crearPartida(J(2));
  g.fichas.b = [relBetoEnSalidaDeAna, CARCEL, CARCEL, CARCEL];
  assert.strictEqual(R.checkCapture(g, 'a', 0).length, 0, 'Ana cae en su salida con Beto ahí');
  const r = R.aplicarTirada(g, [5, 5]);                           // Ana sale de la cárcel con par
  assert.deepStrictEqual(r.game.fichas.a, [0, 0, 0, 0]);
  assert.strictEqual(r.game.fichas.b[0], relBetoEnSalidaDeAna, 'a Beto no se lo comieron');
  assert(!r.eventos.some(e => e.tipo === 'come'));
  // y Ana tampoco se come a Beto en la salida de Beto
  const g2 = R.crearPartida(J(2));
  g2.fichas.b = [0, CARCEL, CARCEL, CARCEL];
  assert.strictEqual(R.checkCapture(g2, 'a', (SALIDAS[1] - SALIDAS[0] + 68) % 68).length, 0);
});

prueba('shots por nivel: normal → la víctima toma y quien comió elige; suave → nada', () => {
  const ev = [{ tipo: 'come', por: 'a', victima: 'b' }];
  assert.deepStrictEqual(R.checkShotEvents(ev, R.crearPartida(J(3), { nivel: 'normal' })).map(x => [x.tipo, x.jugadorId || x.por]), [['shot', 'b'], ['elegir', 'a']]);
  assert.strictEqual(R.checkShotEvents(ev, R.crearPartida(J(3), { nivel: 'suave' })).length, 0);
  assert.strictEqual(R.checkShotEvents(ev, R.crearPartida(J(3), { nivel: 'guaro' }))[0].cantidad, 2);
});
prueba('al meter la 4.ª ficha gana; el último de la tabla toma doble', () => {
  const g = R.aplicarTirada(con(R.crearPartida(J(3)), { fichas: { a: [CIELO - 4, CIELO, CIELO, CIELO], b: [10, CARCEL, CARCEL, CARCEL], c: [CARCEL, CARCEL, CARCEL, CARCEL] } }), [1, 3]).game;
  const r = R.aplicarMovimiento(g, R.getValidMoves(g).find(m => m.alCielo));
  assert.strictEqual(r.game.ganador, 'a'); assert.strictEqual(r.game.perdedor, 'c');
  assert.deepStrictEqual(R.checkShotEvents(r.eventos, r.game).map(x => [x.jugadorId, x.razon, x.cantidad]), [['c', 'finPartida', 2]]);
});
prueba('1000 partidas al azar terminan siempre, sin posiciones imposibles', () => {
  let semilla = 7; const rnd = () => ((semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let p = 0; p < 1000; p++) {
    let g = R.crearPartida(J(2 + (p % 3)), { nivel: ['suave', 'normal', 'guaro'][p % 3] }), pasos = 0;
    while (g.fase !== 'fin') {
      if (++pasos > 20000) throw new Error(`la partida ${p} no termina`);
      if (g.fase === 'tirar') g = R.aplicarTirada(g, [1 + Math.floor(rnd() * 6), 1 + Math.floor(rnd() * 6)]).game;
      else { const m = R.getValidMoves(g); g = R.aplicarMovimiento(g, m[Math.floor(rnd() * m.length)]).game; }
      for (const j of g.jugadores) for (const r of g.fichas[j.id]) assert(r >= CARCEL && r <= CIELO);
    }
    assert(g.ganador && g.perdedor && g.ganador !== g.perdedor);
  }
});

seccion('Pasos 3 y 4 · Partida en la sala (GameManager) y entre coordinadores');

/** Sala privada con 3 jugadores en 2 coordinadores, todos listos, lista para empezar */
async function salaLista(env = {}) {
  const red = crearRed(['coord-a', 'coord-b'], env);
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b'), caro = red.jugador('3', 'Caro', 'coord-b');
  ana.enviar({ type: 'sala_crear', nivel: 'guaro' });
  await hasta(() => ana.sala);
  await red.replicada(ana.sala.codigo);
  beto.enviar({ type: 'sala_unirse', codigo: ana.sala.codigo }); caro.enviar({ type: 'sala_unirse', codigo: ana.sala.codigo });
  await hasta(() => ana.sala.jugadores.length === 3);
  return { red, ana, beto, caro, js: [ana, beto, caro] };
}
const turnoDe = (js) => { const s = js[0].sala; return js.find(j => j.userId === s.game.jugadores[s.game.turno].id); };

prueba('solo el anfitrión empieza, y solo con todos listos', async () => {
  const { ana, beto, js } = await salaLista();
  beto.enviar({ type: 'sala_empezar' });
  assert(await hasta(() => beto.errores.includes('solo_anfitrion')));
  ana.enviar({ type: 'sala_empezar' });
  assert(await hasta(() => ana.errores.includes('no_todos_listos')));
  for (const j of js) j.enviar({ type: 'sala_listo', listo: true });
  await hasta(() => ana.sala.jugadores.every(j => j.listo));
  ana.enviar({ type: 'sala_empezar' });
  assert(await hasta(() => js.every(j => j.sala.estado === 'jugando')));
  assert.deepStrictEqual(ana.sala.game.jugadores.map(j => j.color), [0, 1, 2]);
});

prueba('fuera de turno no se tira; una versión vieja se rechaza; el cliente no puede mandar dados', async () => {
  const { ana, js } = await salaLista();
  for (const j of js) j.enviar({ type: 'sala_listo', listo: true });
  await hasta(() => ana.sala.jugadores.every(j => j.listo));
  ana.enviar({ type: 'sala_empezar' });
  await hasta(() => js.every(j => j.sala.estado === 'jugando'));
  const actual = turnoDe(js), otro = js.find(j => j !== actual);
  otro.enviar({ type: 'sala_tirar', v: otro.sala.v });
  assert(await hasta(() => otro.errores.includes('no_es_tu_turno')));
  actual.enviar({ type: 'sala_tirar', v: actual.sala.v - 1 });
  assert(await hasta(() => actual.errores.includes('sala_desactualizada')));
  const v = actual.sala.v;
  actual.enviar({ type: 'sala_tirar', v, dados: [6, 6] });          // "dados" del navegador: se ignora
  assert(await hasta(() => actual.sala.v > v));
  const d = actual.sala.ultimo.dados;
  assert(R.dadosValidos(d));
});

prueba('mover solo una jugada de la lista del servidor; mal formada → error', async () => {
  const { red, ana, js } = await salaLista();
  for (const j of js) j.enviar({ type: 'sala_listo', listo: true });
  await hasta(() => ana.sala.jugadores.every(j => j.listo));
  ana.enviar({ type: 'sala_empezar' });
  await hasta(() => js.every(j => j.sala.estado === 'jugando'));
  // se pone a mano la partida en fase "mover" en el dueño para probar
  const rooms = red.nodos.get('coord-a').parques.rooms;
  const s = rooms.salas.get(ana.sala.codigo);
  const yo = s.game.jugadores[s.game.turno].id;
  s.game = R.aplicarTirada(con(s.game, { fichas: { [yo]: [0, CARCEL, CARCEL, CARCEL] } }), [2, 5]).game;
  const actual = js.find(j => j.userId === yo);
  actual.enviar({ type: 'sala_mover', v: s.v, ficha: 3, dados: [0] });
  assert(await hasta(() => actual.errores.includes('movimiento_invalido')));
  actual.enviar({ type: 'sala_mover', v: s.v, ficha: 'x', dados: [9] });
  assert(await hasta(() => actual.errores.filter(e => e === 'movimiento_invalido').length === 2));
  actual.enviar({ type: 'sala_mover', v: s.v, ficha: 0, dados: [1] });
  assert(await hasta(() => actual.sala.game.fichas[yo][0] === 5));
});

prueba('las "jugadas" llegan solo al jugador de turno en fase mover', async () => {
  const sala = nuevaSala({ codigo: 'ABCDEF', uid: 'x', tipo: 'privada', nivel: 'normal', maxJugadores: 2, anfitrion: { id: 'a', nombre: 'Ana' } });
  sala.estado = 'jugando'; sala.game = R.aplicarTirada(con(R.crearPartida(J(2)), { fichas: { a: [0, CARCEL, CARCEL, CARCEL] } }), [2, 5]).game;
  assert(GM.jugadasPara(sala, 'a').length > 0);
  assert.strictEqual(GM.jugadasPara(sala, 'b').length, 0);
  sala.shots = [{ id: 1, tipo: 'shot', jugadorId: 'b' }];
  assert.strictEqual(GM.jugadasPara(sala, 'a').length, 0);           // con shot pendiente no se juega
});

prueba('shots: pausa la partida, solo quien toma confirma, elegir víctima, Modo Agua y contador', () => {
  const ctx = { tirarDados: () => [1, 1], azar: () => 0, enLinea: () => true, minJugadores: 2 };
  let s = nuevaSala({ codigo: 'ABCDEF', uid: 'x', tipo: 'privada', nivel: 'normal', maxJugadores: 3, anfitrion: { id: 'a', nombre: 'Ana' } });
  s.jugadores.push({ id: 'b', nombre: 'Beto', color: 1, agua: true }, { id: 'c', nombre: 'Caro', color: 2 });
  s.estado = 'jugando'; s.game = R.crearPartida(s.jugadores.map(({ id, nombre, color, agua }) => ({ id, nombre, color, agua })), { nivel: 'normal' });
  s.shots = []; s.sigShot = 1;
  // Ana come a Caro: Caro toma (guaro) y Ana elige
  s.game = con(s.game, { fichas: { a: [7, CARCEL, CARCEL, CARCEL] } });
  const abs = R.casillaAbsoluta(0, 10);
  s.game.fichas.c = [(abs - SALIDAS[2] + 68) % 68, CARCEL, CARCEL, CARCEL];
  s.game = R.aplicarTirada(s.game, [3, 5]).game;
  let r = aplicarSala(s, { tipo: 'mover', userId: 'a', ficha: 0, dados: [0] }, ctx);
  s = r.sala;
  assert.deepStrictEqual(s.shots.map(x => [x.tipo, x.jugadorId || x.por]), [['shot', 'c'], ['elegir', 'a']]);
  assert.strictEqual(s.shots[0].modo, 'guaro');
  assert(aplicarSala(s, { tipo: 'mover', userId: 'a', ficha: 0, dados: [1] }, ctx).error.code === 'shot_pendiente');
  assert(aplicarSala(s, { tipo: 'shot_ok', userId: 'b', shotId: s.shots[0].id }, ctx).error.code === 'no_es_tu_shot');
  s = aplicarSala(s, { tipo: 'shot_ok', userId: 'c', shotId: s.shots[0].id }, ctx).sala;
  assert.strictEqual(s.game.jugadores.find(j => j.id === 'c').shots, 1);
  assert(aplicarSala(s, { tipo: 'elegir', userId: 'b', shotId: s.shots[0].id, jugadorId: 'c' }, ctx).error);
  s = aplicarSala(s, { tipo: 'elegir', userId: 'a', shotId: s.shots[0].id, jugadorId: 'b' }, ctx).sala;
  assert.strictEqual(s.shots[0].jugadorId, 'b');
  assert.strictEqual(s.shots[0].modo, 'reto');                       // Beto tiene Modo Agua (azar 0 → reto)
  assert(R.RETOS.includes(s.shots[0].reto));
});

prueba('el anfitrión confirma el shot o salta el turno de alguien desconectado', () => {
  const enLinea = (id) => id !== 'b';
  const ctx = { tirarDados: () => [1, 2], azar: () => 1, enLinea, minJugadores: 2 };
  let s = nuevaSala({ codigo: 'ABCDEF', uid: 'x', tipo: 'privada', nivel: 'normal', maxJugadores: 2, anfitrion: { id: 'a', nombre: 'Ana' } });
  s.jugadores.push({ id: 'b', nombre: 'Beto', color: 1 });
  s.estado = 'jugando'; s.game = { ...R.crearPartida(J(2)), turno: 1 };
  s.shots = [{ id: 5, tipo: 'shot', jugadorId: 'b', cantidad: 1, razon: 'noSale', datos: {} }];
  s = aplicarSala(s, { tipo: 'shot_ok', userId: 'a', shotId: 5 }, ctx).sala;
  assert.strictEqual(s.shots.length, 0);
  s = aplicarSala(s, { tipo: 'saltar', userId: 'a' }, ctx).sala;
  assert.strictEqual(s.game.turno, 0);
  assert(aplicarSala(s, { tipo: 'saltar', userId: 'a' }, ctx).error.code === 'jugador_en_linea');
});

prueba('quien se sale: sus fichas vuelven a la casa y su turno se sigue saltando en cada ronda', () => {
  const ctx = { tirarDados: () => [1, 2], azar: () => 0, enLinea: () => true, minJugadores: 2, minPublica: 2 };
  let s = nuevaSala({ codigo: 'ABCDEF', uid: 'x', tipo: 'privada', nivel: 'normal', maxJugadores: 3, anfitrion: { id: 'a', nombre: 'Ana' } });
  s.jugadores.push({ id: 'b', nombre: 'Beto', color: 1 }, { id: 'c', nombre: 'Caro', color: 2 });
  s.estado = 'jugando'; s.game = { ...R.crearPartida(J(3)), turno: 0 };
  s.game.fichas.b = [0, 10, 30, R.CIELO];
  s = aplicarSala(s, { tipo: 'salir', userId: 'b' }, ctx).sala;
  assert.deepStrictEqual(s.game.fichas.b, [CARCEL, CARCEL, CARCEL, CARCEL]);
  assert(s.game.jugadores.find(j => j.id === 'b').fuera);
  const turnos = [];
  for (let i = 0; i < 8; i++) { turnos.push(s.game.jugadores[s.game.turno].id); s.game = R.saltarTurno(s.game); }
  assert(!turnos.includes('b'), `le tocó a Beto: ${turnos}`);
  assert.deepStrictEqual(turnos.slice(0, 4), ['a', 'c', 'a', 'c']);
});

prueba('salir en plena partida: se saltan sus turnos; si queda uno solo, gana', async () => {
  const ctx = { tirarDados: () => [1, 2], azar: () => 0, enLinea: () => true, minJugadores: 2, minPublica: 2 };
  let s = nuevaSala({ codigo: 'ABCDEF', uid: 'x', tipo: 'privada', nivel: 'normal', maxJugadores: 3, anfitrion: { id: 'a', nombre: 'Ana' } });
  s.jugadores.push({ id: 'b', nombre: 'Beto', color: 1 }, { id: 'c', nombre: 'Caro', color: 2 });
  s.estado = 'jugando'; s.game = { ...R.crearPartida(J(3)), turno: 1 };
  s = aplicarSala(s, { tipo: 'salir', userId: 'b' }, ctx).sala;
  assert.strictEqual(s.game.turno, 2);
  s = aplicarSala(s, { tipo: 'salir', userId: 'c' }, ctx).sala;
  assert.strictEqual(s.estado, 'fin'); assert.strictEqual(s.game.ganador, 'a');
});

/** Juega n acciones con quien corresponda (tira, mueve la primera jugada, confirma shots, elige) */
async function jugar(js, n) {
  for (let i = 0; i < n; i++) {
    const s = js[0].sala;
    if (!s || s.estado !== 'jugando') return i;
    const v = s.v, quien = (id) => js.find(j => j.userId === id);
    if (s.shots.length) {
      const sh = s.shots[0];
      if (sh.tipo === 'elegir') quien(sh.por).enviar({ type: 'sala_elegir', shotId: sh.id, jugadorId: s.game.jugadores.find(x => x.id !== sh.por && !x.fuera).id });
      else quien(sh.jugadorId).enviar({ type: 'sala_shot_ok', shotId: sh.id });
    } else {
      const yo = quien(s.game.jugadores[s.game.turno].id);
      if (s.game.fase === 'tirar') yo.enviar({ type: 'sala_tirar', v: yo.sala.v });
      else { await hasta(() => yo.jugadas.length); const m = yo.jugadas[0]; yo.enviar({ type: 'sala_mover', v: yo.sala.v, ficha: m.ficha, dados: m.dados }); }
    }
    if (!await hasta(() => js.every(j => j.sala && j.sala.v > v))) throw new Error(`sin cambio tras la acción ${i}: ${js.map(j => j.errores.slice(-1))}`);
  }
  return n;
}
const firma = (s) => JSON.stringify({ v: s.v, game: s.game, shots: s.shots, estado: s.estado });

prueba('300 acciones con 3 jugadores en 2 coordinadores: todos ven exactamente la misma sala', async () => {
  const { ana, js } = await salaLista();
  for (const j of js) j.enviar({ type: 'sala_listo', listo: true });
  await hasta(() => ana.sala.jugadores.every(j => j.listo));
  ana.enviar({ type: 'sala_empezar' });
  await hasta(() => js.every(j => j.sala.estado === 'jugando'));
  await jugar(js, 300);
  assert(js.every(j => firma(j.sala) === firma(ana.sala)));
  assert(ana.sala.game.jugadores.some(j => j.shots > 0), 'nadie tomó');
});

prueba('se cae el coordinador dueño en plena partida: otro la adopta y la partida sigue', async () => {
  const red = crearRed(['coord-a', 'coord-b', 'coord-c']);
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b'), caro = red.jugador('3', 'Caro', 'coord-c');
  const js = [ana, beto, caro];
  ana.enviar({ type: 'sala_crear' });
  await hasta(() => ana.sala); await red.replicada(ana.sala.codigo);
  beto.enviar({ type: 'sala_unirse', codigo: ana.sala.codigo }); caro.enviar({ type: 'sala_unirse', codigo: ana.sala.codigo });
  await hasta(() => ana.sala.jugadores.length === 3);
  for (const j of js) j.enviar({ type: 'sala_listo', listo: true });
  await hasta(() => ana.sala.jugadores.every(j => j.listo));
  ana.enviar({ type: 'sala_empezar' });
  await hasta(() => js.every(j => j.sala.estado === 'jugando'));
  await jugar(js, 40);
  red.apagar('coord-a');
  ana.mudarA('coord-b');                                              // Ana se reconecta a otro coordinador
  assert(await hasta(() => js.every(j => j.sala.duenio === 'coord-b'), 5000), 'nadie adoptó');
  const seq = beto.sala.seq;
  await jugar(js, 40);
  assert(beto.sala.seq > seq, 'la partida no siguió');
  assert(js.every(j => firma(j.sala) === firma(beto.sala)));
});

prueba('partida pública completa: se forma, empieza sola y se juega entre coordinadores', async () => {
  const red = crearRed(['coord-a', 'coord-b'], { SALA_PUBLICA_MAX: '2' });
  const ana = red.jugador('1', 'Ana', 'coord-a'), beto = red.jugador('2', 'Beto', 'coord-b');
  ana.enviar({ type: 'partida_buscar' }); beto.enviar({ type: 'partida_buscar' });
  assert(await hasta(() => ana.sala && beto.sala && beto.sala.estado === 'jugando', 3000));
  assert.strictEqual(ana.sala.nivel, 'normal');
  beto.enviar({ type: 'sala_agua', agua: true });
  assert(await hasta(() => ana.sala.game.jugadores.find(j => j.id === '2').agua));
  await jugar([ana, beto], 60);
  assert(firma(ana.sala) === firma(beto.sala));
});

// ─────────────────────────────────────────────────────────────
seccion('Paso 5 · El tablero que dibuja el navegador coincide con las reglas del servidor');
const path = require('path');
const { pathToFileURL } = require('url');
const cargarTablero = () => import(pathToFileURL(path.join(__dirname, '..', 'client', 'js', 'salas', 'tablero.js')).href);

prueba('mismas salidas, seguros, cárcel y cielo en client/js/salas/tablero.js y en GameRules', async () => {
  const T = await cargarTablero();
  assert.deepStrictEqual(T.SALIDAS, R.SALIDAS);
  assert.deepStrictEqual(T.SEGUROS, R.SEGUROS);
  assert.strictEqual(T.CIELO, R.CIELO); assert.strictEqual(T.CARCEL, R.CARCEL);
  for (let c = 0; c < 4; c++) for (let rel = 0; rel <= R.ULTIMA_COMPARTIDA; rel++) assert.strictEqual(T.casillaAbsoluta(c, rel), R.casillaAbsoluta(c, rel));
});
prueba('68 casillas distintas, cada paso a una celda vecina, pasillos sin choques', async () => {
  const T = await cargarTablero();
  assert.strictEqual(new Set(T.RECORRIDO.map(c => c.celda.join(','))).size, 68);
  for (let i = 0; i < 68; i++) {
    const [a, b] = [T.RECORRIDO[i].celda, T.RECORRIDO[(i + 1) % 68].celda];
    assert.strictEqual(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])), 1, `${i}`);
  }
  const ocupadas = new Set(T.RECORRIDO.map(c => c.celda.join(',')));
  for (const p of T.PASILLOS) for (const c of p) { assert(!ocupadas.has(c.join(','))); ocupadas.add(c.join(',')); }
});
prueba('el navegador no tiene reglas: tablero.js no exporta funciones de jugadas ni dados', async () => {
  const T = await cargarTablero();
  for (const n of ['getValidMoves', 'aplicarTirada', 'aplicarMovimiento', 'rollDice', 'checkShotEvents']) assert(!(n in T), n);
});

// ─────────────────────────────────────────────────────────────
(async () => {
  for (const [nombre, fn] of pendientes) {
    if (nombre === null) { console.log(`\n${fn}`); continue; }
    try { await fn(); ok++; console.log(`  ✔ ${nombre}`); }
    catch (e) { mal++; console.log(`  ✘ ${nombre}\n      ${e.message}`); }
  }
  console.log(`\n${ok} correctas, ${mal} fallidas`);
  process.exit(mal ? 1 : 0);
})();
