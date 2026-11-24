// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · GameRules (reglas PURAS del juego y de los shots)
// ─────────────────────────────────────────────────────────────
// Nada de este archivo conoce WebSocket, salas, coordinadores ni el azar: recibe un estado y devuelve
// un estado NUEVO más una lista de eventos (qué pasó). Los dados le llegan como números ya tirados.
// Solo el servidor usa estas reglas: el navegador nunca decide si una jugada es válida.
//
// Posición de una ficha = cuánto ha avanzado DESDE SU SALIDA (posición relativa):
//   -1        → en la cárcel
//    0 .. 63  → recorrido compartido (0 = su casilla de SALIDA, 63 = la entrada a su pasillo)
//   64 .. 71  → su pasillo final (8 casillas, solo de ese color)
//   72        → CIELO (llegada). Solo se entra con el número exacto.

const REGLAS = {
  casillasRecorrido: 68,      // casillas compartidas (4 brazos × 17)
  casillasPasillo: 8,         // pasillo final de cada color hasta el cielo
  fichasPorJugador: 4,
  intentosParaSalir: 3,       // si TODAS las fichas en juego están en la cárcel, intentos para sacar par
  salidaConPar: 'todas',      // 'todas' = con un par salen todas · 'dos' = salen hasta dos
  comerAlSalir: false,        // las SALIDAS son seguro: al salir de la cárcel NO se come a quien esté ahí
  parDaOtroTurno: true,
  tresPares: 'cielo',         // tres pares seguidos: 'cielo' = sube la ficha más adelantada · 'pierde' = pierde el turno
};

// ── Niveles de shots: cuántos shots provoca cada evento (0 = ninguno) ──
//   teComen: te comen una ficha → tomas tú           comes: comes una ficha → eliges a quién mandar a tomar
//   noSale: no sacas par en los intentos de la cárcel  tresPares: tres pares seguidos → toman todos los demás
//   llegaCielo: una ficha llega al cielo → toma el último de la tabla   finPartida: el perdedor toma doble
const NIVELES = {
  suave:  { teComen: 0, comes: 0, noSale: 0, tresPares: 1, llegaCielo: 1, finPartida: 2 },
  normal: { teComen: 1, comes: 1, noSale: 0, tresPares: 1, llegaCielo: 1, finPartida: 2 },
  guaro:  { teComen: 2, comes: 1, noSale: 1, tresPares: 1, llegaCielo: 1, finPartida: 2 },
};

// Modo Agua: para quien no quiere tomar, el shot es de agua o un reto (el reto lo elige el servidor)
const RETOS = [
  'Imita a un animal durante 10 segundos',
  'Habla en tercera persona hasta tu próximo turno',
  'Haz 10 sentadillas',
  'Cuenta un chiste (malo vale)',
  'Canta el coro de una canción que todos conozcan',
  'Haz tu mejor paso de baile',
  'Di un trabalenguas sin equivocarte',
  'Manda un emoji raro al último chat que tengas abierto',
];

const CARCEL = -1;
const N = REGLAS.casillasRecorrido;                                     // 68
const POR_BRAZO = N / 4;                                                // 17
const ULTIMA_COMPARTIDA = N - 5;                                        // 63
const CIELO = ULTIMA_COMPARTIDA + 1 + REGLAS.casillasPasillo;           // 72

// Casillas especiales del recorrido (índices absolutos 0..67). Brazo k = casillas 17k..17k+16.
const salidaDe = (color) => color * POR_BRAZO + 13;
const SALIDAS = [0, 1, 2, 3].map(salidaDe);
// Como en el parqués normal: un seguro 7 casillas después de cada salida y otro 5 casillas más adelante
const SEGUROS = [0, 1, 2, 3].flatMap(k => [k * POR_BRAZO + 3, k * POR_BRAZO + 8]);

/** Casilla absoluta (0..67) de una ficha del color dado en la posición relativa rel, o null si no está en el recorrido */
function casillaAbsoluta(color, rel) {
  if (rel < 0 || rel > ULTIMA_COMPARTIDA) return null;
  return (salidaDe(color) + rel) % N;
}
/** ¿Una ficha de colorFicha está protegida en la casilla abs? (seguro, o su propia salida) */
// Las 4 salidas también son seguro (para cualquier color): ahí nunca se come
const estaProtegida = (abs) => SEGUROS.includes(abs) || SALIDAS.includes(abs);

const esPar = (dados) => !!dados && dados[0] === dados[1];
const dadosValidos = (d) => Array.isArray(d) && d.length === 2 && d.every(x => Number.isInteger(x) && x >= 1 && x <= 6);

/** Partida nueva. jugadores = [{ id, nombre, color (0..3), agua }] · opciones = { nivel, reglas? } */
function crearPartida(jugadores, opciones = {}) {
  const reglas = { ...REGLAS, ...(opciones.reglas || {}) };
  return {
    reglas,
    nivel: NIVELES[opciones.nivel] ? opciones.nivel : 'normal',
    jugadores: jugadores.map(j => ({ ...j, shots: j.shots || 0 })),
    fichas: Object.fromEntries(jugadores.map(j => [j.id, Array(reglas.fichasPorJugador).fill(CARCEL)])),
    turno: Math.min(Math.max(0, opciones.primero || 0), jugadores.length - 1),
    fase: 'tirar',            // 'tirar' | 'mover' | 'fin'
    dados: null,
    usados: [false, false],
    paresSeguidos: 0,
    intentosCarcel: 0,
    ganador: null,
    perdedor: null,
    ronda: 1,
  };
}

const clonar = (g) => ({ ...g, jugadores: g.jugadores.map(j => ({ ...j })),
  fichas: Object.fromEntries(Object.entries(g.fichas).map(([k, v]) => [k, [...v]])), usados: [...g.usados] });
const jugadorActual = (g) => g.jugadores[g.turno];
const colorDe = (g, id) => g.jugadores.find(j => j.id === id).color;
const nombreDe = (g, id) => g.jugadores.find(j => j.id === id).nombre;
const enCielo = (g, id) => g.fichas[id].filter(r => r >= CIELO).length;
const enJuego = (g, id) => g.fichas[id].filter(r => r !== CARCEL && r < CIELO).length;
const enCarcel = (g, id) => g.fichas[id].filter(r => r === CARCEL).length;

/** Fichas rivales que se comen al caer en la posición rel del jugador. No se come en el pasillo, en los seguros ni en ninguna salida. */
function checkCapture(g, jugadorId, rel) {
  const abs = casillaAbsoluta(colorDe(g, jugadorId), rel);
  if (abs === null) return [];
  const victimas = [];
  for (const j of g.jugadores) {
    if (j.id === jugadorId || j.fuera) continue;
    g.fichas[j.id].forEach((r, i) => {
      if (casillaAbsoluta(j.color, r) === abs && !estaProtegida(abs)) victimas.push({ jugadorId: j.id, ficha: i });
    });
  }
  return victimas;
}

/**
 * Jugadas posibles del jugador de turno con los dados que le quedan:
 *   { ficha, dados: [0] | [1] | [0, 1], pasos, desde, hasta, come, alCielo }
 * [0, 1] = mover la MISMA ficha con los dos dados.
 */
function getValidMoves(g) {
  if (g.fase !== 'mover' || !g.dados) return [];
  const yo = jugadorActual(g).id;
  const libres = [0, 1].filter(d => !g.usados[d]);
  const lista = [];
  g.fichas[yo].forEach((rel, ficha) => {
    if (rel === CARCEL || rel >= CIELO) return;
    const vistos = new Set();
    for (const d of libres) {
      const hasta = rel + g.dados[d];
      if (hasta > CIELO || vistos.has(hasta)) continue;          // con dados iguales no se repite la misma jugada
      vistos.add(hasta);
      lista.push({ ficha, dados: [d], pasos: g.dados[d], desde: rel, hasta, come: checkCapture(g, yo, hasta).length, alCielo: hasta === CIELO });
    }
    if (libres.length === 2) {
      const pasos = g.dados[0] + g.dados[1], hasta = rel + pasos;
      if (hasta <= CIELO) lista.push({ ficha, dados: [0, 1], pasos, desde: rel, hasta, come: checkCapture(g, yo, hasta).length, alCielo: hasta === CIELO });
    }
  });
  return lista;
}

/** Progreso total (para la tabla): una ficha en el cielo pesa más que cualquier avance */
const puntaje = (g, id) => g.fichas[id].reduce((s, r) => s + (r >= CIELO ? 1000 : Math.max(0, r + 1)), 0);
const tabla = (g) => [...g.jugadores].filter(j => !j.fuera).sort((a, b) => puntaje(g, b.id) - puntaje(g, a.id));
/** El último de la tabla (si hay empate se evita a "excepto") */
function ultimoDeLaTabla(g, excepto = null) {
  const t = tabla(g).reverse();
  if (!t.length) return null;
  const peor = puntaje(g, t[0].id);
  return (t.find(j => puntaje(g, j.id) === peor && j.id !== excepto) || t[0]).id;
}

function declararGanador(g, id, eventos) {
  g.ganador = id; g.perdedor = ultimoDeLaTabla(g, id); g.fase = 'fin';
  eventos.push({ tipo: 'gana', jugadorId: id, perdedor: g.perdedor });
}

/** Mueve una ficha `pasos` casillas (un tramo). Devuelve { game, eventos }. */
function moveToken(g0, jugadorId, ficha, pasos) {
  const g = clonar(g0);
  const desde = g.fichas[jugadorId][ficha];
  const hasta = desde + pasos;
  if (desde === CARCEL || desde >= CIELO || hasta > CIELO) throw new Error(`movimiento inválido (${desde} + ${pasos})`);
  g.fichas[jugadorId][ficha] = hasta;
  const eventos = [];
  for (const v of checkCapture(g, jugadorId, hasta)) {
    g.fichas[v.jugadorId][v.ficha] = CARCEL;
    eventos.push({ tipo: 'come', por: jugadorId, victima: v.jugadorId, ficha: v.ficha, casilla: hasta });
  }
  if (hasta === CIELO) {
    eventos.push({ tipo: 'cielo', jugadorId });
    if (enCielo(g, jugadorId) === g.reglas.fichasPorJugador && !g.ganador) declararGanador(g, jugadorId, eventos);
  }
  return { game: g, eventos };
}

/** Saca fichas de la cárcel a la salida (todas, o hasta dos según la regla). Puede comer al salir. */
function liberar(g, jugadorId) {
  const eventos = [];
  const tope = g.reglas.salidaConPar === 'dos' ? 2 : Infinity;
  let salen = 0;
  g.fichas[jugadorId].forEach((r, i) => { if (r === CARCEL && salen < tope) { g.fichas[jugadorId][i] = 0; salen++; } });
  if (salen) eventos.push({ tipo: 'salen', jugadorId, cuantas: salen });
  if (salen && g.reglas.comerAlSalir) {
    for (const v of checkCapture(g, jugadorId, 0)) {
      g.fichas[v.jugadorId][v.ficha] = CARCEL;
      eventos.push({ tipo: 'come', por: jugadorId, victima: v.jugadorId, ficha: v.ficha, casilla: 0 });
    }
  }
  return eventos;
}

function pasarTurno(g) {
  const n = g.jugadores.length;
  for (let k = 1; k <= n; k++) {                          // salta a los que se fueron de la partida
    const t = (g.turno + k) % n;
    if (!g.jugadores[t].fuera) { if (t <= g.turno) g.ronda++; g.turno = t; break; }
  }
  g.paresSeguidos = 0; g.intentosCarcel = 0;
  g.fase = 'tirar'; g.usados = [false, false];
}

/**
 * Aplica una tirada (dados ya tirados por el servidor) del jugador de turno. Devuelve { game, eventos }.
 * Resuelve sola lo que no requiere elección: salir de la cárcel con par, los intentos, los tres pares
 * seguidos y "no hay movimientos".
 */
function aplicarTirada(g0, dados) {
  if (g0.fase !== 'tirar') throw new Error('no es momento de tirar');
  if (!dadosValidos(dados)) throw new Error('dados inválidos');
  const g = clonar(g0);
  const yo = jugadorActual(g).id;
  const par = esPar(dados);
  const eventos = [{ tipo: 'tirada', jugadorId: yo, dados, par }];
  g.dados = dados; g.usados = [false, false];
  g.paresSeguidos = par ? g.paresSeguidos + 1 : 0;

  if (par && g.paresSeguidos >= 3) {                     // tres pares seguidos
    eventos.push({ tipo: 'tresPares', jugadorId: yo });
    if (g.reglas.tresPares === 'cielo') {
      const vivas = g.fichas[yo].map((r, i) => ({ r, i })).filter(x => x.r < CIELO).sort((a, b) => b.r - a.r);
      if (vivas.length) {
        const { r, i } = vivas[0];
        g.fichas[yo][i] = CIELO;
        eventos.push({ tipo: 'subeAlCielo', jugadorId: yo, ficha: i, desde: r });
        eventos.push({ tipo: 'cielo', jugadorId: yo });
        if (enCielo(g, yo) === g.reglas.fichasPorJugador) { declararGanador(g, yo, eventos); return { game: g, eventos }; }
      }
    } else {
      eventos.push({ tipo: 'pierdeTurno', jugadorId: yo });
    }
    g.usados = [true, true];
    pasarTurno(g);
    return { game: g, eventos };
  }

  if (enJuego(g, yo) === 0 && enCarcel(g, yo) > 0) {     // todas en la cárcel: solo sale con par
    if (par) {
      eventos.push(...liberar(g, yo));
      g.usados = [true, true]; g.intentosCarcel = 0; g.fase = 'tirar';   // por ser par, vuelve a tirar
      return { game: g, eventos };
    }
    g.intentosCarcel++;
    g.usados = [true, true];
    if (g.intentosCarcel >= g.reglas.intentosParaSalir) { eventos.push({ tipo: 'noSale', jugadorId: yo }); pasarTurno(g); }
    else { eventos.push({ tipo: 'otroIntento', jugadorId: yo, intento: g.intentosCarcel + 1 }); g.fase = 'tirar'; }
    return { game: g, eventos };
  }

  if (par && enCarcel(g, yo) > 0) {                      // con par y fichas presas: salen y vuelve a tirar
    eventos.push(...liberar(g, yo));
    g.usados = [true, true]; g.fase = 'tirar';
    return { game: g, eventos };
  }

  g.fase = 'mover';
  if (getValidMoves(g).length === 0) {
    eventos.push({ tipo: 'sinMovimientos', jugadorId: yo });
    return terminarTirada(g, eventos);
  }
  return { game: g, eventos };
}

/** Ejecuta una jugada de getValidMoves (con uno o con los dos dados). Devuelve { game, eventos, tramos }. */
function aplicarMovimiento(g0, mov) {
  if (g0.fase !== 'mover') throw new Error('no es momento de mover');
  const yo = jugadorActual(g0).id;
  let g = g0;
  const eventos = [], tramos = [];
  for (const d of mov.dados) {
    if (g.usados[d]) throw new Error('ese dado ya se usó');
    const desde = g.fichas[yo][mov.ficha];
    const r = moveToken(g, yo, mov.ficha, g.dados[d]);
    g = r.game; g.usados = [...g.usados]; g.usados[d] = true;
    tramos.push({ ficha: mov.ficha, desde, hasta: desde + g0.dados[d] });
    eventos.push(...r.eventos);
    if (g.fase === 'fin') return { game: g, eventos, tramos };
  }
  if (g.usados.every(Boolean) || getValidMoves(g).length === 0) return { ...terminarTirada(g, eventos), tramos };
  return { game: g, eventos, tramos };
}

/** Pasa el turno al siguiente sin jugar (jugador que se fue o que no está conectado) */
function saltarTurno(g0) {
  const g = clonar(g0);
  if (g.fase !== 'fin') pasarTurno(g);
  return g;
}

/** Cierra la tirada: con par se vuelve a tirar; si no, pasa el turno */
function terminarTirada(g0, eventos = []) {
  const g = clonar(g0);
  if (g.fase === 'fin') return { game: g, eventos };
  if (esPar(g.dados) && g.reglas.parDaOtroTurno) {
    g.fase = 'tirar'; g.usados = [false, false];
    eventos.push({ tipo: 'otroTurnoPorPar', jugadorId: jugadorActual(g).id });
  } else {
    pasarTurno(g);
  }
  return { game: g, eventos };
}

/**
 * Convierte los eventos de una jugada en órdenes de shot según el nivel:
 *   { tipo: 'shot', jugadorId, cantidad, razon, datos }   → alguien toma
 *   { tipo: 'elegir', por, cantidad, razon }               → quien comió elige a quién mandar a tomar
 */
function checkShotEvents(eventos, g) {
  const t = NIVELES[g.nivel] || NIVELES.normal;
  const out = [];
  for (const e of eventos) {
    if (e.tipo === 'come') {
      if (t.teComen) out.push({ tipo: 'shot', jugadorId: e.victima, cantidad: t.teComen, razon: 'teComen', datos: { por: nombreDe(g, e.por) } });
      if (t.comes) out.push({ tipo: 'elegir', por: e.por, cantidad: t.comes, razon: 'comes' });
    } else if (e.tipo === 'noSale' && t.noSale) {
      out.push({ tipo: 'shot', jugadorId: e.jugadorId, cantidad: t.noSale, razon: 'noSale', datos: {} });
    } else if (e.tipo === 'tresPares' && t.tresPares) {
      for (const j of g.jugadores) if (j.id !== e.jugadorId && !j.fuera) {
        out.push({ tipo: 'shot', jugadorId: j.id, cantidad: t.tresPares, razon: 'tresPares', datos: { por: nombreDe(g, e.jugadorId) } });
      }
    } else if (e.tipo === 'cielo' && t.llegaCielo && !eventos.some(x => x.tipo === 'gana')) {
      const ultimo = ultimoDeLaTabla(g, e.jugadorId);
      if (ultimo && ultimo !== e.jugadorId) out.push({ tipo: 'shot', jugadorId: ultimo, cantidad: t.llegaCielo, razon: 'llegaCielo', datos: { por: nombreDe(g, e.jugadorId) } });
    } else if (e.tipo === 'gana' && t.finPartida && e.perdedor && e.perdedor !== e.jugadorId) {
      out.push({ tipo: 'shot', jugadorId: e.perdedor, cantidad: t.finPartida, razon: 'finPartida', datos: { por: nombreDe(g, e.jugadorId) } });
    }
  }
  return out;
}

module.exports = {
  REGLAS, NIVELES, RETOS, CARCEL, CIELO, ULTIMA_COMPARTIDA, SALIDAS, SEGUROS,
  salidaDe, casillaAbsoluta, estaProtegida, esPar, dadosValidos,
  crearPartida, jugadorActual, enCielo, checkCapture, getValidMoves, moveToken,
  aplicarTirada, aplicarMovimiento, saltarTurno, terminarTirada, checkShotEvents,
  puntaje, tabla, ultimoDeLaTabla,
};