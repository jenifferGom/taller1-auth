// Panel de jugadores: color, nombre, fichas en el cielo, contador de shots (🥃 x3) y el turno actual
import { h } from './dom.js';
import { COLORES } from '../textos.js';
import { CIELO, CARCEL, tabla } from '../tablero.js';

export function PlayerPanel(game) {
  const actual = game.jugadores[game.turno];
  const orden = [...tabla(game), ...game.jugadores.filter(j => j.fuera)];   // los que se fueron, al final y en gris
  return h('aside', { class: 'panel-jugadores', 'aria-label': 'Jugadores' },
    h('h3', {}, 'Tabla'),
    h('ol', {}, ...orden.map((j, pos) => {
      const c = COLORES[j.color];
      const f = game.fichas[j.id];
      const cielo = f.filter(r => r >= CIELO).length, carcel = f.filter(r => r === CARCEL).length;
      return h('li', { class: `fila-jugador ${j.fuera ? 'fuera' : ''} ${j.id === actual.id && game.fase !== 'fin' && !j.fuera ? 'de-turno' : ''}`, style: { '--c': c.hex, '--cn': c.neon } },
        h('span', { class: 'pos' }, j.fuera ? '–' : `${pos + 1}`),
        h('span', { class: 'ficha-mini', 'aria-hidden': 'true' }),
        h('span', { class: 'jugador-nombre' }, j.nombre, j.agua ? h('small', { title: 'Modo Agua' }, ' 💧') : null,
          j.fuera ? h('small', { class: 'salio', title: 'Se fue de la sala: se salta su turno' }, ' · salió') : null),
        h('span', { class: 'estadistica', title: `${cielo} en el cielo, ${carcel} en la cárcel` },
          h('span', { class: 'estrellas' }, '★'.repeat(cielo) + '☆'.repeat(f.length - cielo))),
        h('span', { class: `contador-shots ${j.shots ? 'con-shots' : ''}`, title: `${j.shots} shots` }, `🥃 x${j.shots}`));
    })));
}
