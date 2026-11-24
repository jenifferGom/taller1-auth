// Modal a pantalla completa del SHOT 🥃 (lo ven TODOS los jugadores de la sala):
// el vaso se llena, cuenta 3-2-1, "¡SALUD!", el vaso se inclina y se vacía. Solo quien toma
// puede tocar "¡Ya me lo tomé!"; los demás ven "Esperando a que X se lo tome…". El modal se
// cierra cuando el servidor confirma (cerrar()). Con Modo Agua el vaso es de agua o sale un reto.
import { h, s, esperar } from './dom.js';
import { COLORES, RAZONES } from '../textos.js';
import { sonidos, vibrar } from '../sound.js';

function vasoSVG(tipo) {
  const id = `liquido-${Math.random().toString(36).slice(2, 7)}`;
  return s('svg', { class: `vaso vaso-${tipo}`, viewBox: '0 0 120 150', 'aria-hidden': 'true' },
    s('defs', {},
      s('clipPath', { id }, s('path', { d: 'M22 22 L98 22 L88 132 Q60 138 32 132 Z' })),
      s('linearGradient', { id: `${id}-g`, x1: '0', y1: '0', x2: '0', y2: '1' },
        s('stop', { offset: '0', class: 'liq-arriba' }), s('stop', { offset: '1', class: 'liq-abajo' }))),
    s('g', { class: 'vaso-cuerpo' },
      s('g', { 'clip-path': `url(#${id})` },
        s('rect', { class: 'liquido', x: '10', y: '20', width: '100', height: '120', fill: `url(#${id}-g)` }),
        s('path', { class: 'ola', d: 'M0 30 Q15 24 30 30 T60 30 T90 30 T120 30 V40 H0Z' }),
        ...[0, 1, 2, 3, 4].map(i => s('circle', { class: `burbuja b${i}`, cx: 36 + i * 12, cy: 128, r: 1.6 + (i % 3) * 0.8 }))),
      s('path', { class: 'vaso-vidrio', d: 'M18 18 L102 18 L91 135 Q60 143 29 135 Z' }),
      s('path', { class: 'vaso-reflejo', d: 'M30 30 L36 30 L32 120 L28 120 Z' })));
}

function base(color, titulo, ...hijos) {
  const c = COLORES[color];
  const modal = h('div', { class: 'modal-shot salas-raiz', role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo,
    style: { '--c': c.hex, '--cn': c.neon } }, h('div', { class: 'modal-contenido' }, ...hijos));
  document.body.append(modal);
  requestAnimationFrame(() => modal.classList.add('abierto'));
  let cerrado = false;
  return { modal, cerrar() {
    if (cerrado) return; cerrado = true;
    modal.classList.remove('abierto'); setTimeout(() => modal.remove(), 250);
  }, get cerrado() { return cerrado; } };
}

/**
 * orden = { id, jugadorId, cantidad, razon, datos, modo: 'guaro' | 'agua' | 'reto', reto } · jugador = { nombre, color }
 * opciones = { puedeConfirmar, textoBoton, alConfirmar() }
 * El modo y el reto los decide el servidor: todos los navegadores muestran lo mismo.
 */
export function abrirShot(orden, jugador, opciones = {}) {
  const esReto = orden.modo === 'reto';
  const tipo = orden.modo === 'agua' || esReto ? 'agua' : 'guaro';
  const cuantos = orden.cantidad > 1 ? (orden.cantidad === 2 ? ' DOBLE' : ` ×${orden.cantidad}`) : '';
  const nombre = jugador.nombre.toUpperCase();
  const titulo = esReto ? `¡${nombre} TIENE UN RETO!` : tipo === 'agua' ? `¡${nombre} SE TOMA UN AGUA${cuantos}!` : `¡${nombre} SE TOMA UN SHOT${cuantos}!`;
  const razon = (RAZONES[orden.razon] || (() => ''))(orden.datos || {});
  const cuenta = h('div', { class: 'cuenta', 'aria-live': 'assertive' }, '');
  const boton = h('button', { class: 'btn btn-grande btn-amarillo', disabled: true },
    opciones.puedeConfirmar ? (esReto ? '¡Reto cumplido!' : (opciones.textoBoton || '¡Ya me lo tomé!')) : `Esperando a que ${jugador.nombre} se lo tome…`);
  const vaso = esReto
    ? h('div', { class: 'reto' }, h('span', { class: 'reto-emoji' }, '🎯'), h('p', {}, orden.reto || 'Reto libre: que lo elija la mesa'))
    : vasoSVG(tipo);
  const m = base(jugador.color, titulo, h('h2', { class: 'shot-titulo' }, titulo), h('p', { class: 'shot-razon' }, razon), vaso, cuenta, boton);

  (async () => {
    vibrar([120, 60, 120]);
    if (!esReto) { sonidos.gluglu(); m.modal.classList.add('llenando'); }
    await esperar(esReto ? 500 : 1300);
    for (const n of ['3', '2', '1']) {
      if (m.cerrado) return;
      cuenta.textContent = n; cuenta.classList.remove('pop'); void cuenta.offsetWidth; cuenta.classList.add('pop');
      sonidos.cuenta();
      await esperar(700);
    }
    if (m.cerrado) return;
    cuenta.textContent = '¡SALUD!'; cuenta.classList.remove('pop'); void cuenta.offsetWidth; cuenta.classList.add('pop', 'salud');
    sonidos.salud(); vibrar(200);
    if (!esReto) m.modal.classList.add('tomando');
    if (opciones.puedeConfirmar) {
      boton.disabled = false; boton.focus({ preventScroll: true });
      boton.addEventListener('click', () => { boton.disabled = true; boton.textContent = '¡Salud! 🥃'; opciones.alConfirmar && opciones.alConfirmar(); }, { once: true });
    }
  })();
  return m;
}

/** "¿A quién mandas a tomar?": solo elige quien se comió la ficha; los demás esperan */
export function abrirEleccion(por, candidatos, opciones = {}) {
  const nombre = por.nombre.toUpperCase();
  const lista = h('div', { class: 'elegir-lista' }, ...candidatos.map(j =>
    h('button', { class: 'btn btn-grande btn-jugador', disabled: !opciones.puedeElegir,
      style: { '--c': COLORES[j.color].hex, '--cn': COLORES[j.color].neon },
      onclick: (e) => { lista.querySelectorAll('button').forEach(b => { b.disabled = true; }); e.currentTarget.classList.add('elegido'); opciones.alElegir && opciones.alElegir(j.id); } },
      `🥃 ${j.nombre}`)));
  const m = base(por.color, `${nombre} SE COMIÓ UNA FICHA`,
    h('h2', { class: 'shot-titulo' }, `¡${nombre} SE COMIÓ UNA FICHA!`),
    h('p', { class: 'shot-razon' }, opciones.puedeElegir ? '¿A quién mandas a tomar?' : `${por.nombre} está eligiendo a quién mandar a tomar…`),
    lista);
  return m;
}
