// Tablero de Parqués en SVG (cuadrícula de 19 × 19 → viewBox 0 0 190 190)
//   · Las filas/columnas de las ESQUINAS (las casas) miden L y las 3 del centro miden C, con L < C:
//     las casas quedan más pequeñas y el recorrido (los brazos) más ancho, sin cambiar las reglas.
//   · 68 casillas compartidas con SALIDAS de color y SEGUROS (⛨)
//   · pasillo final de 8 casillas por color y el CIELO en el centro
//   · 4 cárceles en las esquinas; la del jugador de turno brilla
import { s } from './dom.js';
import { COLORES } from '../textos.js';
import { RECORRIDO, PASILLOS, SALIDAS, SEGUROS, CARCELES, CARCEL, CIELO, celdaDe } from '../tablero.js';
import { crearFicha, colocar, animarPasos, animarVuelo } from './Token.js';

const L = 9;                                               // fila/columna de las esquinas (casas): antes 10
const C = (190 - 16 * L) / 3;                              // fila/columna del centro (≈ 15.3): brazos más anchos
const K = L / 10;                                          // escala de los dibujos de la casa (antes medía 80)
const eje = (i) => (i < 8 ? i * L : i < 11 ? 8 * L + (i - 8) * C : 8 * L + 3 * C + (i - 11) * L);
const tam = (i) => (i >= 8 && i <= 10 ? C : L);
const centro = ([f, c]) => ({ x: eje(c) + tam(c) / 2, y: eje(f) + tam(f) / 2 });
const casilla = ([f, c], hueco = 0.8) => ({ x: eje(c) + hueco / 2, y: eje(f) + hueco / 2, width: tam(c) - hueco, height: tam(f) - hueco });
const clave = ([f, c]) => `${f},${c}`;

// Desplazamientos para apilar varias fichas en la misma casilla
function apilar(n, i) {
  if (n <= 1) return { dx: 0, dy: 0, k: 1 };
  if (n === 2) return { dx: i ? 2.3 : -2.3, dy: 0, k: 0.78 };
  if (n <= 4) return { dx: (i % 2 ? 2.4 : -2.4), dy: (i < 2 ? -2.4 : 2.4), k: 0.64 };
  if (n <= 9) { const col = i % 3, fil = Math.floor(i / 3); return { dx: (col - 1) * 3, dy: (fil - 1) * 3, k: 0.48 }; }
  const col = i % 4, fil = Math.floor(i / 4);               // en el cielo pueden llegar hasta 16
  return { dx: (col - 1.5) * 3.2, dy: (fil - 1.5) * 3.2, k: 0.42 };
}
// Puesto fijo de cada ficha dentro de su cárcel (2 × 2)
function puestoCarcel(color, i) {
  const [f, c] = CARCELES[color];
  return { x: eje(c) + 40 * K + (i % 2 ? 13 : -13) * K, y: eje(f) + 44 * K + (i < 2 ? -11 : 13) * K, k: 1.25 * K };
}

export function Board({ onFicha, onDestino }) {
  const defs = s('defs', {},
    s('filter', { id: 'sombra-ficha', x: '-50%', y: '-50%', width: '200%', height: '200%' },
      s('feDropShadow', { dx: '0', dy: '0.7', stdDeviation: '0.55', 'flood-color': '#000', 'flood-opacity': '0.65' })),
    s('filter', { id: 'neon', x: '-50%', y: '-50%', width: '200%', height: '200%' },
      s('feGaussianBlur', { stdDeviation: '1.6', result: 'b' }),
      s('feMerge', {}, s('feMergeNode', { in: 'b' }), s('feMergeNode', { in: 'SourceGraphic' }))),
    ...COLORES.map((c, i) => s('radialGradient', { id: `grad-${i}`, cx: '35%', cy: '30%', r: '75%' },
      s('stop', { offset: '0%', 'stop-color': '#fff' }), s('stop', { offset: '28%', 'stop-color': c.neon }),
      s('stop', { offset: '70%', 'stop-color': c.hex }), s('stop', { offset: '100%', 'stop-color': c.oscuro }))),
    s('symbol', { id: 'icono-seguro', viewBox: '-5 -5 10 10' },
      s('path', { d: 'M0-4 3.2-2.6v2.2C3.2 2 1.6 3.5 0 4.2-1.6 3.5-3.2 2-3.2-.4v-2.2Z', class: 'seguro-escudo' })),
  );

  const capaTablero = s('g', { class: 'capa-tablero' });
  const capaDestinos = s('g', { class: 'capa-destinos' });
  const capaFichas = s('g', { class: 'capa-fichas' });
  const svg = s('svg', { class: 'tablero', viewBox: '0 0 190 190', role: 'img', 'aria-label': 'Tablero de parqués' },
    defs, capaTablero, capaFichas, capaDestinos);          // destinos ENCIMA: así se puede tocar una casilla con un rival (para comer)

  const carceles = [];
  const nombres = [];
  dibujarTablero();

  function dibujarTablero() {
    capaTablero.append(s('rect', { class: 'fondo-tablero', x: '0.5', y: '0.5', width: '189', height: '189', rx: '9' }));
    // Cárceles
    CARCELES.forEach(([f, c], color) => {
      const col = COLORES[color];
      const g = s('g', { class: 'carcel', style: `--c:${col.hex};--cn:${col.neon}` },
        s('rect', { class: 'carcel-borde', x: eje(c) + 3 * K, y: eje(f) + 3 * K, width: 74 * K, height: 74 * K, rx: 9 * K }),
        s('rect', { class: 'carcel-interior', x: eje(c) + 9 * K, y: eje(f) + 13 * K, width: 62 * K, height: 58 * K, rx: 7 * K }),
        ...[0, 1, 2, 3].map(i => { const p = puestoCarcel(color, i); return s('circle', { class: 'carcel-puesto', cx: p.x, cy: p.y, r: 5 * K }); }));
      const nombre = s('text', { class: 'carcel-nombre', x: eje(c) + 40 * K, y: eje(f) + 10.4 * K, 'text-anchor': 'middle' }, '');
      g.append(nombre);
      carceles[color] = g; nombres[color] = nombre;
      capaTablero.append(g);
    });
    // Recorrido compartido
    for (const { abs, celda } of RECORRIDO) {
      const { x, y } = centro(celda);
      const salidaDe = SALIDAS.indexOf(abs);
      const g = s('g', { class: 'casilla' });
      const r = casilla(celda);
      if (salidaDe >= 0) {
        // Salida: casilla del color del jugador con "SALE"; también es seguro → escudo pequeño en la esquina
        g.append(s('rect', { class: 'casilla-salida', ...r, rx: 1.6, style: `--c:${COLORES[salidaDe].hex}` }));
        g.append(s('text', { class: 'casilla-texto', x, y: y + 0.9, 'text-anchor': 'middle' }, 'SALE'));
        g.append(s('use', { href: '#icono-seguro', class: 'seguro-salida', x: r.x + r.width - 4.6, y: r.y + 0.3, width: 4.4, height: 4.4 }));
      } else {
        g.append(s('rect', { class: 'casilla-normal', ...r, rx: 1.6 }));
        // Seguros: escudo en la esquina, para que la ficha no lo tape
        if (SEGUROS.includes(abs)) g.append(s('use', { href: '#icono-seguro', x: r.x + r.width - 4.6, y: r.y + 0.3, width: 4.4, height: 4.4 }));
      }
      capaTablero.append(g);
    }
    // Centro 3 × 3 como en el parqués clásico: 4 triángulos (uno por color, del lado de su pasillo)
    // que se juntan en la estrella. Así no quedan huecos en las esquinas y no se agregan casillas.
    const x0 = eje(8), x1 = eje(11), cx = (x0 + x1) / 2;          // el centro es cuadrado: mismas medidas en y
    PASILLOS.forEach((celdas, color) => {
      const [f, c] = celdas[celdas.length - 1];
      const lado = f === 8 ? [[x0, x0], [x1, x0]] : f === 10 ? [[x0, x1], [x1, x1]] : c === 8 ? [[x0, x0], [x0, x1]] : [[x1, x0], [x1, x1]];
      const pts = [...lado, [cx, cx]].map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      capaTablero.append(s('polygon', { class: 'centro-triangulo', points: pts, style: `--c:${COLORES[color].hex}` }));
    });
    // Pasillos
    PASILLOS.forEach((celdas, color) => celdas.forEach((celda, n) => {
      const { x, y } = centro(celda);
      capaTablero.append(s('rect', {
        class: 'casilla-pasillo', ...casilla(celda), rx: 1.6,
        style: `--c:${COLORES[color].hex}; --o:${0.35 + n * 0.07}`
      }));
    }));
    // Estrella del cielo en el medio
    const c = centro([9, 9]);
    capaTablero.append(s('g', { class: 'estrella-cielo', filter: 'url(#neon)' },
      s('title', {}, 'Cielo'),
      s('path', { d: estrella(c.x, c.y, C * 0.42, C * 0.18) })));
  }
  function estrella(cx, cy, R, r) {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r : R;
      d += `${i ? 'L' : 'M'}${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    }
    return d + 'Z';
  }

  // ── Fichas ──
  let fichas = {};          // jugadorId → [elementos]
  let jugadores = [];

  function montar(game) {
    capaFichas.replaceChildren();
    fichas = {}; jugadores = game.jugadores;
    carceles.forEach((g, color) => {
      const j = game.jugadores.find(x => x.color === color);
      g.classList.toggle('vacia', !j);
      nombres[color].textContent = j ? j.nombre.toUpperCase() : '';
    });
    for (const j of game.jugadores) {
      fichas[j.id] = game.fichas[j.id].map((_, i) => {
        const el = crearFicha(j.color, j.id, i);
        el.addEventListener('click', () => onFicha && onFicha(j.id, i));
        capaFichas.append(el);
        return el;
      });
    }
    sincronizar(game, {}, false);
  }

  /** Celda o puesto donde se dibuja una ficha en la posición rel (sin apilar) */
  function puntoDe(color, rel, i) {
    if (rel === CARCEL) return puestoCarcel(color, i);
    if (rel >= CIELO) return { ...centro([9, 9]), cielo: true };
    return centro(celdaDe(color, rel));
  }

  /** Calcula dónde va cada ficha, apilando las que comparten casilla */
  function posiciones(game) {
    const porCelda = new Map(), out = {};
    for (const j of game.jugadores) {
      game.fichas[j.id].forEach((rel, i) => {
        const p = puntoDe(j.color, rel, i);
        if (rel === CARCEL) { out[`${j.id}:${i}`] = p; return; }
        const k = rel >= CIELO ? 'cielo' : clave(celdaDe(j.color, rel));
        if (!porCelda.has(k)) porCelda.set(k, { p, lista: [] });
        porCelda.get(k).lista.push(`${j.id}:${i}`);
      });
    }
    for (const { p, lista } of porCelda.values()) {
      lista.forEach((id, i) => {
        const a = apilar(p.cielo ? Math.max(lista.length, 3) : lista.length, i);
        out[id] = { x: p.x + a.dx, y: p.y + a.dy, k: a.k };
      });
    }
    return out;
  }

  /**
   * Dibuja el estado: fichas en su sitio, turno resaltado, fichas que se pueden mover y destinos.
   * marcas = { turnoColor, movibles: Set('jid:i'), seleccion: 'jid:i', movs: [...], jugadorId }
   */
  function sincronizar(game, marcas = {}, suave = true) {
    const pos = posiciones(game);
    for (const j of game.jugadores) fichas[j.id].forEach((el, i) => {
      const id = `${j.id}:${i}`;
      colocar(el, pos[id], suave);
      el.classList.toggle('movible', !!marcas.movibles && marcas.movibles.has(id));
      el.classList.toggle('seleccionada', marcas.seleccion === id);
      el.classList.toggle('en-cielo', game.fichas[j.id][i] >= CIELO);
      el.classList.toggle('fuera', !!j.fuera);                 // se fue de la sala: ficha gris en su casa
    });
    carceles.forEach((g, color) => {
      g.classList.toggle('turno', color === marcas.turnoColor);
      const j = game.jugadores.find(x => x.color === color);
      g.classList.toggle('fuera', !!(j && j.fuera));
      if (j) nombres[color].textContent = j.fuera ? `${j.nombre.toUpperCase()} · SALIÓ` : j.nombre.toUpperCase();
    });
    dibujarDestinos(game, marcas);
  }

  function dibujarDestinos(game, { movs = [], seleccion = null, jugadorId = null }) {
    capaDestinos.replaceChildren();
    if (!jugadorId) return;
    const color = game.jugadores.find(j => j.id === jugadorId).color;
    const visibles = seleccion ? movs.filter(m => `${jugadorId}:${m.ficha}` === seleccion) : movs;
    const usadas = new Map();
    for (const m of visibles) {
      const p = puntoDe(color, m.hasta, m.ficha);
      const n = usadas.get(clave([p.x, p.y])) || 0; usadas.set(clave([p.x, p.y]), n + 1);
      const tipo = m.dados.length === 2 ? 'ambos' : m.dados[0] === 0 ? 'a' : 'b';
      const etiqueta = m.dados.length === 2 ? `${m.pasos}` : `${m.pasos}`;
      const g = s('g', {
        class: `destino destino-${tipo} ${seleccion ? 'activo' : 'tenue'}`,
        transform: `translate(${p.x + n * 1.6} ${p.y - n * 1.6})`, role: 'button',
        'aria-label': `Mover ${m.pasos} casillas${m.come ? ' y comer' : ''}${m.alCielo ? ' al cielo' : ''}`
      },
        s('circle', { r: '4.4' }),
        seleccion ? s('text', { y: '1.5', 'text-anchor': 'middle' }, m.come ? '💥' : m.alCielo ? '★' : etiqueta) : null);
      if (seleccion) g.addEventListener('click', (e) => { e.stopPropagation(); onDestino && onDestino(m); });
      capaDestinos.append(g);
    }
  }

  // ── Animaciones (las llama el controlador; devuelven promesas) ──
  async function animarTramo(jugadorId, ficha, desde, hasta, msPorCasilla, alPaso) {
    const color = jugadores.find(j => j.id === jugadorId).color;
    const puntos = [];
    for (let r = desde + 1; r <= hasta; r++) puntos.push(puntoDe(color, r, ficha));
    capaDestinos.replaceChildren();
    await animarPasos(fichas[jugadorId][ficha], puntos, msPorCasilla, alPaso);
  }
  async function animarALaCarcel(jugadorId, ficha) {
    const color = jugadores.find(j => j.id === jugadorId).color;
    await animarVuelo(fichas[jugadorId][ficha], puestoCarcel(color, ficha), 700);
  }
  async function animarSalida(jugadorId, ficha) {
    const color = jugadores.find(j => j.id === jugadorId).color;
    await animarVuelo(fichas[jugadorId][ficha], { ...puntoDe(color, 0, ficha), k: 1 }, 520);
  }
  /** Punto en pantalla (px) de una ficha, para lanzar confeti ahí */
  function puntoEnPantalla(jugadorId, ficha) {
    const el = fichas[jugadorId] && fichas[jugadorId][ficha];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  return { el: svg, montar, sincronizar, animarTramo, animarALaCarcel, animarSalida, puntoEnPantalla };
}