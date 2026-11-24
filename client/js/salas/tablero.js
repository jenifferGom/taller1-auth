// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · GEOMETRÍA DEL TABLERO (solo para dibujar)
// ─────────────────────────────────────────────────────────────
// Dónde va cada casilla en la cuadrícula de 19 × 19. Aquí NO hay reglas: qué jugadas son válidas,
// los dados, las capturas y los shots los decide el coordinador (coordinator/parques/GameRules.js).
// Las constantes del recorrido deben coincidir con GameRules: parques-test.js lo comprueba.
//
// Posición de una ficha = cuánto avanzó desde su salida: -1 cárcel · 0..63 recorrido · 64..71 pasillo · 72 cielo

export const CASILLAS = 68;
export const PASILLO = 8;
export const CARCEL = -1;
export const ULTIMA_COMPARTIDA = CASILLAS - 5;                     // 63
export const CIELO = ULTIMA_COMPARTIDA + 1 + PASILLO;               // 72
const POR_BRAZO = CASILLAS / 4;                                     // 17

export const salidaDe = (color) => color * POR_BRAZO + 13;
export const SALIDAS = [0, 1, 2, 3].map(salidaDe);
// Como en el parqués normal: un seguro 7 casillas después de cada salida y otro 5 casillas más adelante
export const SEGUROS = [0, 1, 2, 3].flatMap(k => [k * POR_BRAZO + 3, k * POR_BRAZO + 8]);

export function casillaAbsoluta(color, rel) {
  if (rel < 0 || rel > ULTIMA_COMPARTIDA) return null;
  return (salidaDe(color) + rel) % CASILLAS;
}

// Brazos de 3 columnas × 8 filas alrededor de un centro de 3 × 3; las esquinas de 8 × 8 son las cárceles.
// El tablero se dibuja REFLEJADO de izquierda a derecha (espejo) para que las fichas avancen en el
// sentido correcto: el brazo 0 (amarillo) queda arriba, el 1 (azul) a la IZQUIERDA, el 2 (rojo) abajo
// y el 3 (verde) a la derecha. Solo cambia el dibujo: las reglas del servidor no dependen de esto.
export const GRID = 19;
const espejo = ([f, c]) => [f, GRID - 1 - c];
function celdaRecorrido(abs) { return espejo(celdaSinEspejo(abs)); }
function celdaSinEspejo(abs) {
  const k = Math.floor(abs / POR_BRAZO), i = abs % POR_BRAZO;
  const j = i - 9;
  switch (k) {
    case 0: return i < 8 ? [7 - i, 8]  : i === 8 ? [0, 9]  : [j, 10];
    case 1: return i < 8 ? [8, 11 + i] : i === 8 ? [9, 18] : [10, 18 - j];
    case 2: return i < 8 ? [11 + i, 10]: i === 8 ? [18, 9] : [18 - j, 8];
    default:return i < 8 ? [10, 7 - i] : i === 8 ? [9, 0]  : [8, j];
  }
}
function celdaPasillo(color, n) {
  const d = n + 1;
  return espejo([[d, 9], [9, 18 - d], [18 - d, 9], [9, d]][color]);
}
export const CELDA_CIELO = [9, 9];
// Esquina superior izquierda (fila, columna) de la cárcel de cada color (8 × 8), ya reflejada
export const CARCELES = [[0, 0], [11, 0], [11, 11], [0, 11]];
// Casilla del centro donde llegan al cielo las fichas de cada color (al lado de su cárcel)
export const CIELOS = [[8, 8], [10, 8], [10, 10], [8, 10]];

/** Celda [fila, columna] de una ficha (null si está en la cárcel) */
export function celdaDe(color, rel) {
  if (rel === CARCEL) return null;
  if (rel >= CIELO) return CELDA_CIELO;
  if (rel > ULTIMA_COMPARTIDA) return celdaPasillo(color, rel - ULTIMA_COMPARTIDA - 1);
  return celdaRecorrido(casillaAbsoluta(color, rel));
}
export const RECORRIDO = Array.from({ length: CASILLAS }, (_, abs) => ({ abs, celda: celdaRecorrido(abs) }));
export const PASILLOS = [0, 1, 2, 3].map(c => Array.from({ length: PASILLO }, (_, n) => celdaPasillo(c, n)));

// ── Ayudas para mostrar (no deciden nada) ──
export const esPar = (dados) => !!dados && dados[0] === dados[1];
export const jugadorActual = (g) => g.jugadores[g.turno];
const puntaje = (g, id) => g.fichas[id].reduce((s, r) => s + (r >= CIELO ? 1000 : Math.max(0, r + 1)), 0);
/** Orden de la tabla que se muestra en pantalla: del que va mejor al que va peor */
export const tabla = (g) => [...g.jugadores].filter(j => !j.fuera).sort((a, b) => puntaje(g, b.id) - puntaje(g, a.id));