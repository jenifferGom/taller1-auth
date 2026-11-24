// Ficha: un grupo SVG centrado en (0,0) que se mueve con transform. Las animaciones usan la
// Web Animations API para que la ficha avance casilla por casilla con un saltito.
import { s } from './dom.js';

export function crearFicha(color, jugadorId, i) {
  const g = s('g', { class: 'pq-ficha', dataset: { jugador: jugadorId, ficha: String(i) }, role: 'button' },
    s('circle', { class: 'ficha-halo', r: '3.9' }),
    s('circle', { class: 'ficha-base', r: '2.6', fill: `url(#grad-${color})`, filter: 'url(#sombra-ficha)' }),
    s('circle', { class: 'ficha-anillo', r: '1.6' }),
    s('circle', { class: 'ficha-brillo', r: '0.7', cx: '-0.8', cy: '-0.9' }));
  g.dataset.x = '0'; g.dataset.y = '0'; g.dataset.k = '1';
  return g;
}

const tf = (x, y, k = 1, extra = '') => `translate(${x}px, ${y}px) scale(${k}) ${extra}`;

/** Coloca la ficha sin animar (o con una transición corta si suave = true) */
export function colocar(el, { x, y, k = 1 }, suave = false) {
  const desde = tf(+el.dataset.x, +el.dataset.y, +el.dataset.k);
  el.dataset.x = x; el.dataset.y = y; el.dataset.k = k;
  el.style.transform = tf(x, y, k);
  if (suave && desde !== el.style.transform) el.animate([{ transform: desde }, { transform: el.style.transform }], { duration: 220, easing: 'ease-out' });
}

/** Avanza por una lista de puntos, uno por casilla, con un salto en cada paso. alPaso() se llama en cada casilla. */
export async function animarPasos(el, puntos, msPorCasilla, alPaso) {
  el.classList.add('moviendo');
  el.parentNode.appendChild(el);                       // al frente de las demás
  for (const p of puntos) {
    const x0 = +el.dataset.x, y0 = +el.dataset.y;
    const k = 1.05;
    const anim = el.animate([
      { transform: tf(x0, y0, 1) },
      { transform: tf((x0 + p.x) / 2, (y0 + p.y) / 2 - 3.2, 1.28), offset: 0.5 },
      { transform: tf(p.x, p.y, k) },
    ], { duration: msPorCasilla, easing: 'ease-in-out' });
    el.dataset.x = p.x; el.dataset.y = p.y; el.dataset.k = k;
    el.style.transform = tf(p.x, p.y, k);
    alPaso && alPaso();
    await anim.finished.catch(() => {});
  }
  el.classList.remove('moviendo');
}

/** Vuelo con rebote (la ficha comida vuelve a su cárcel, o una ficha sale de la cárcel) */
export async function animarVuelo(el, destino, ms = 650) {
  el.parentNode.appendChild(el);
  const x0 = +el.dataset.x, y0 = +el.dataset.y;
  const mx = (x0 + destino.x) / 2, my = Math.min(y0, destino.y) - 22;
  const anim = el.animate([
    { transform: tf(x0, y0, 1, 'rotate(0deg)') },
    { transform: tf(mx, my, 1.7, 'rotate(320deg)'), offset: 0.45 },
    { transform: tf(destino.x, destino.y, 0.8, 'rotate(680deg)'), offset: 0.82 },
    { transform: tf(destino.x, destino.y - 3, 1.1, 'rotate(720deg)'), offset: 0.91 },
    { transform: tf(destino.x, destino.y, destino.k || 1, 'rotate(720deg)') },
  ], { duration: ms, easing: 'cubic-bezier(.3,.7,.4,1)' });
  el.dataset.x = destino.x; el.dataset.y = destino.y; el.dataset.k = destino.k || 1;
  el.style.transform = tf(destino.x, destino.y, destino.k || 1);
  await anim.finished.catch(() => {});
}
