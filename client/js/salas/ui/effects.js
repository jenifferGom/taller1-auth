// Efectos de pantalla: confeti, letrero grande ("¡TE COMIERON!") y aviso de turno
import { h } from './dom.js';
import { COLORES } from '../textos.js';

/** Confeti que sale desde (x, y) en px (por defecto, el centro de la pantalla) */
export function confeti(x = innerWidth / 2, y = innerHeight / 2, cantidad = 90) {
  const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const capa = h('div', { class: 'confeti', 'aria-hidden': 'true' });
  const paleta = [...COLORES.map(c => c.neon), '#ffffff', '#ff9ff3'];
  for (let i = 0; i < (reducido ? 20 : cantidad); i++) {
    const p = h('i', {});
    const ang = Math.random() * Math.PI * 2, vel = 120 + Math.random() * 260;
    p.style.cssText = `left:${x}px;top:${y}px;background:${paleta[i % paleta.length]};` +
      `--dx:${Math.cos(ang) * vel}px;--dy:${Math.sin(ang) * vel - 160}px;--r:${Math.random() * 900 - 450}deg;` +
      `--t:${900 + Math.random() * 900}ms;width:${5 + Math.random() * 6}px;height:${8 + Math.random() * 8}px`;
    capa.append(p);
  }
  document.body.append(capa);
  setTimeout(() => capa.remove(), 2200);
}

/** Letrero grande y animado en el centro (no bloquea) */
export function letrero(texto, color = '#fff', ms = 1300) {
  const el = h('div', { class: 'letrero', role: 'status', style: { '--c': color } }, texto);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

/** "Turno de ANA": útil para pasar el celular */
export function avisoTurno(jugador) {
  const c = COLORES[jugador.color];
  const el = h('div', { class: 'aviso-turno', 'aria-hidden': 'true', style: { '--c': c.hex, '--cn': c.neon } },
    h('small', {}, 'Turno de'), h('b', {}, jugador.nombre));
  document.body.append(el);
  setTimeout(() => el.remove(), 1100);
}
