// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · TEXTOS Y COLORES DE LA INTERFAZ
// ─────────────────────────────────────────────────────────────
// Solo lo que se muestra: nombres, colores, niveles y la razón de cada shot. Cuántos shots da cada
// evento lo decide el servidor (coordinator/parques/GameRules.js).

export const COLORES = [
  // El color i usa el brazo i del tablero (0 = arriba, 1 = derecha, 2 = abajo, 3 = izquierda)
  { id: 'amarillo', nombre: 'Amarillo', hex: '#ffd23f', neon: '#fff06a', oscuro: '#8a6a00' },
  { id: 'azul',     nombre: 'Azul',     hex: '#3fa9ff', neon: '#7fd4ff', oscuro: '#0b4c8a' },
  { id: 'rojo',     nombre: 'Rojo',     hex: '#ff4d6d', neon: '#ff8fa3', oscuro: '#8a1029' },
  { id: 'verde',    nombre: 'Verde',    hex: '#3ddc84', neon: '#8cffb8', oscuro: '#0d6b3a' },
];

export const NIVELES = {
  suave:  { nombre: 'Suave',      emoji: '🍹', descripcion: 'Shots solo en los eventos grandes' },
  normal: { nombre: 'Normal',     emoji: '🍺', descripcion: 'Comer y que te coman también cuenta' },
  guaro:  { nombre: 'Modo Guaro', emoji: '🔥', descripcion: 'Todo castiga, y algunos castigos son dobles' },
};

// Razón de cada shot (la ven todos los jugadores de la sala, por eso en tercera persona)
export const RAZONES = {
  teComen:    (d) => `${d.por} le comió una ficha`,
  comes:      (d) => `${d.por} lo mandó a tomar por comerse una ficha`,
  noSale:     () => 'No sacó par para salir de la cárcel',
  tresPares:  (d) => `${d.por} sacó tres pares seguidos`,
  llegaCielo: (d) => `${d.por} metió una ficha al cielo y va de último`,
  finPartida: (d) => `Perdió la partida contra ${d.por}`,
};

// Velocidades de animación (ms)
export const ANIMACION = { msPorCasilla: 150, msDados: 1000 };
