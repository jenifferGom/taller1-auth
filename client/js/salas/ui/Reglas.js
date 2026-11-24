// Recuadro "REGLAS DEL JUEGO" que va al lado del tablero.
// No inventa nada: se arma con la configuración REAL de la sala que manda el coordinador
//   sala.reglas      → las mismas REGLAS con las que GameRules juega esta partida
//   sala.tablaShots  → cuántos shots da cada evento en el nivel de ESTA sala (NIVELES[nivel])
//   sala.nivel       → suave | normal | guaro
import { h } from './dom.js';
import { NIVELES } from '../textos.js';

// Valores por defecto de GameRules (por si llega una sala creada por un coordinador sin actualizar)
const REGLAS_POR_DEFECTO = { fichasPorJugador: 4, intentosParaSalir: 3, salidaConPar: 'todas', comerAlSalir: true, parDaOtroTurno: true, tresPares: 'cielo' };

const EVENTOS = [
  ['teComen',    'Te comen una ficha',                  'toma quien perdió la ficha'],
  ['comes',      'Te comes una ficha',                  'eliges a quién mandar a tomar'],
  ['noSale',     'No sacas par en los intentos de la cárcel', 'toma quien no salió'],
  ['tresPares',  'Tres pares seguidos',                 'toman todos los demás'],
  ['llegaCielo', 'Una ficha llega al cielo',            'toma el último de la tabla'],
  ['finPartida', 'Termina la partida',                  'toma el último de la tabla'],
];
const veces = (n) => (n === 1 ? '1 shot' : `${n} shots`);

export function Reglas(sala) {
  const r = { ...REGLAS_POR_DEFECTO, ...(sala.reglas || (sala.game && sala.game.reglas) || {}) };
  const nivel = NIVELES[sala.nivel] || NIVELES.normal;
  const t = sala.tablaShots || null;
  const conShot = t ? EVENTOS.filter(([k]) => t[k] > 0) : [];
  const sinShot = t ? EVENTOS.filter(([k]) => !(t[k] > 0)) : [];

  // Cada sección es un desplegable (<details>): se abre la que se quiera leer sin tapar el tablero
  const seccion = (titulo, ...items) => h('details', { class: 'regla' },
    h('summary', {}, titulo), h('ul', {}, ...items.filter(Boolean).map(x => h('li', {}, x))));

  // El recuadro completo también es un desplegable: "REGLAS DEL JUEGO ▾". Recuerda si estaba abierto.
  let abierto = true;
  try { abierto = localStorage.getItem('guaro.reglasAbiertas') !== '0'; } catch { /* ok */ }
  const caja = h('details', { class: 's-tarjeta reglas-juego', 'aria-label': 'Reglas del juego' },
    h('summary', { class: 'reglas-titulo' }, h('span', {}, '📜 REGLAS DEL JUEGO'), h('span', { class: 'reglas-flecha', 'aria-hidden': 'true' }, '▾')),
    h('p', { class: 'reglas-nivel' }, `${nivel.emoji} Nivel de esta partida: `, h('b', {}, nivel.nombre)),
    seccion('🎯 Objetivo',
      `Lleva tus ${r.fichasPorJugador} fichas de la cárcel al cielo (el centro del tablero).`,
      `Gana quien meta primero sus ${r.fichasPorJugador} fichas.`),
    seccion('🎲 Tu turno',
      'Tiras los dos dados.',
      'Cada dado mueve una ficha distinta, o los dos dados mueven la misma ficha.',
      r.parDaOtroTurno ? 'Si sacas par, vuelves a tirar.' : null,
      'Si no tienes ninguna jugada posible, pasa el turno.'),
    seccion('🔒 Cárcel',
      `Si todas tus fichas están presas, tienes ${r.intentosParaSalir} intentos para sacar par.`,
      r.salidaConPar === 'dos' ? 'Con un par salen hasta dos fichas a tu salida, y vuelves a tirar.'
        : 'Con un par salen todas tus fichas presas a tu salida, y vuelves a tirar.'),
    seccion('🍽️ Comer',
      'Si caes donde hay una ficha rival, esa ficha vuelve a su cárcel.',
      'No se come en los seguros 🛡 ni en las salidas (SALE), que también son seguro, ni en los pasillos finales.',
      r.comerAlSalir ? 'Al salir de la cárcel te comes a los rivales que estén en tu salida.' : null),
    seccion('⭐ Cielo',
      'Al cielo solo se entra con el número exacto.',
      r.tresPares === 'pierde' ? 'Tres pares seguidos: pierdes el turno.'
        : 'Tres pares seguidos: tu ficha más adelantada sube directo al cielo y pasa el turno.'),
    h('details', { class: 'regla', open: true },
      h('summary', {}, `🥃 Shots · ${nivel.nombre}`),
      t ? h('ul', { class: 'reglas-shots' }, ...conShot.map(([k, ev, quien]) =>
            h('li', {}, h('span', {}, ev, h('small', {}, ` · ${quien}`)), h('b', {}, veces(t[k])))))
        : h('p', { class: 'reglas-nota' }, 'La cantidad de shots depende del nivel de la sala.'),
      sinShot.length ? h('p', { class: 'reglas-nota' }, `En este nivel no dan shot: ${sinShot.map(([, ev]) => ev.toLowerCase()).join(', ')}.`) : null,
      h('ul', {},
        h('li', {}, 'Con un shot pendiente la partida se pausa; solo quien toma lo confirma.'),
        h('li', {}, 'Modo Agua 💧: tu shot es de agua o un reto.'))),
    seccion('📶 Desconexiones',
      'Si quien toma o el de turno no está conectado, el anfitrión puede confirmar por él o saltar su turno.',
      'Si alguien sale en plena partida, sus fichas vuelven a su casa (en gris) y se salta su turno; si queda uno solo, gana.'));
  if (abierto) caja.open = true;
  caja.addEventListener('toggle', () => { try { localStorage.setItem('guaro.reglasAbiertas', caja.open ? '1' : '0'); } catch { /* ok */ } });
  return caja;
}
