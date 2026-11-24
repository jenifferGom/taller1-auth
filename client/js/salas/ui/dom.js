// Helpers mínimos para crear elementos sin framework.
//   h('button', { class: 'btn', onclick: fn }, 'Texto', otroNodo)
const SVG_NS = 'http://www.w3.org/2000/svg';

function aplicar(el, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      // Las variables CSS (--c) solo se asignan con setProperty
      for (const [prop, val] of Object.entries(v)) prop.startsWith('--') ? el.style.setProperty(prop, val) : (el.style[prop] = val);
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  return el;
}
function agregar(el, hijos) {
  for (const c of hijos.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const h = (tag, attrs, ...hijos) => agregar(aplicar(document.createElement(tag), attrs), hijos);
export const s = (tag, attrs, ...hijos) => agregar(aplicar(document.createElementNS(SVG_NS, tag), attrs), hijos);
export const limpiar = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const esperar = (ms) => new Promise(r => setTimeout(r, ms));

/** Mensaje corto abajo de la pantalla */
export function toast(texto, tipo = '') {
  const t = h('div', { class: `toast ${tipo}`, role: 'status' }, texto);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('visible'));
  setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 300); }, 2200);
}
