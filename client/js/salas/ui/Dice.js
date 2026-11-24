// Dos dados 3D hechos con CSS (6 caras con puntos). tirar([a, b]) los hace girar y rebotar
// ~1 segundo y termina mostrando esos valores.
import { h } from './dom.js';

// Puntos de cada cara en una cuadrícula 3 × 3 (0..8)
const PUNTOS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
// Cara → rotación que la deja de frente (frente=1, derecha=2, arriba=3, abajo=4, izquierda=5, atrás=6)
const ORIENTACION = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
const CARAS = [['frente', 1], ['derecha', 2], ['arriba', 3], ['abajo', 4], ['izquierda', 5], ['atras', 6]];

function crearDado(n) {
  const cubo = h('div', { class: 'cubo' }, ...CARAS.map(([pos, v]) =>
    h('div', { class: `cara cara-${pos}` }, ...Array.from({ length: 9 }, (_, i) =>
      h('span', { class: PUNTOS[v].includes(i) ? 'pip' : 'pip-vacio' })))));
  const escena = h('div', { class: `dado dado-${n}`, 'aria-hidden': 'true' }, h('div', { class: 'sombra-dado' }), cubo);
  return { escena, cubo, giro: [0, 0] };
}

export function Dice() {
  const dados = [crearDado(1), crearDado(2)];
  const el = h('div', { class: 'dados' }, dados[0].escena, dados[1].escena);
  const lector = h('span', { class: 'solo-lector', 'aria-live': 'polite' });
  el.append(lector);
  let ultimo = [1, 1];

  function mostrar(valores, animar = false) {
    ultimo = valores;
    dados.forEach((d, i) => {
      const [rx, ry] = ORIENTACION[valores[i]];
      d.giro = [rx, ry];
      d.cubo.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
      if (!animar) d.cubo.getAnimations().forEach(a => a.cancel());
    });
  }

  /** Gira y rebota durante ms y termina en valores. Devuelve una promesa. */
  function tirar(valores, ms = 1000) {
    el.classList.add('rodando');
    const anims = dados.map((d, i) => {
      const [rx, ry] = ORIENTACION[valores[i]];
      const vueltasX = 720 + 360 * Math.floor(Math.random() * 2), vueltasY = 720 + 360 * Math.floor(Math.random() * 2);
      const final = `rotateX(${rx + vueltasX}deg) rotateY(${ry + vueltasY}deg)`;
      const a = d.cubo.animate([
        { transform: `rotateX(${d.giro[0]}deg) rotateY(${d.giro[1]}deg)` },
        { transform: `rotateX(${rx + vueltasX * 0.55}deg) rotateY(${ry + vueltasY * 0.7}deg) rotateZ(${i ? -40 : 40}deg)`, offset: 0.55 },
        { transform: final },
      ], { duration: ms, easing: 'cubic-bezier(.15,.6,.3,1)' });
      const b = d.escena.animate([
        { transform: 'translateY(0)' }, { transform: 'translateY(-46px)', offset: 0.22 }, { transform: 'translateY(0)', offset: 0.45 },
        { transform: 'translateY(-18px)', offset: 0.62 }, { transform: 'translateY(0)', offset: 0.78 },
        { transform: 'translateY(-5px)', offset: 0.88 }, { transform: 'translateY(0)' },
      ], { duration: ms, easing: 'ease-out', delay: i * 60 });
      d.cubo.style.transform = final;
      d.giro = [(rx + vueltasX) % 360, (ry + vueltasY) % 360];
      return Promise.all([a.finished, b.finished]).catch(() => {});
    });
    return Promise.all(anims).then(() => {
      el.classList.remove('rodando');
      mostrar(valores);
      lector.textContent = `Dados: ${valores[0]} y ${valores[1]}`;
    });
  }

  mostrar(ultimo);
  return { el, tirar, mostrar };
}
