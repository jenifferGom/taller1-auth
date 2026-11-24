// ─────────────────────────────────────────────────────────────
// Guaro Royal · MODO ESPECTADOR (cliente)
// ─────────────────────────────────────────────────────────────
// Sin iniciar sesión: pide un coordinador al directorio (GET /coordinator, que no pide token) y abre un
// WebSocket a <coordinador>/spectate. Recibe el mundo (state), el chat y, si elige una, la partida de
// parqués (sala_estado). No hay teclado, ni botones de juego, ni envío de acciones: solo mirar.
// Para la demo del examen: desde DevTools, guaroEspectador.enviar({type:'intent',dx:1,dy:0}) → el servidor
// responde "spectator_read_only" y no pasa nada.
import { montarChat } from './chat.js';
import { Partida } from './salas/partida.js';
import { Reglas } from './salas/ui/Reglas.js';
import { COLORES, NIVELES } from './salas/textos.js';
import { h, toast } from './salas/ui/dom.js';

// ── Estado ──
let ws = null, coord = null, world = null, lastState = null, viendo = null;
const caidos = new Map();                                    // coordinatorId → hasta cuándo evitarlo
const $ = (id) => document.getElementById(id);
const estado = (texto, clase = '') => { $('estado').textContent = texto; $('punto').className = `punto ${clase}`; };

// ── Mundo (mismo dibujo que el lobby, sin "tú") ──
const canvas = $('mundo'), ctx = canvas.getContext('2d');
const COLOR_POR_DEFECTO = ['#f2b705', '#1f5fbf', '#d6312b', '#1f9d55'];
function colorDe(p) {
  if (p.extras && p.extras.color) return p.extras.color;
  let x = 0; for (const c of String(p.userId)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return COLOR_POR_DEFECTO[x % COLOR_POR_DEFECTO.length];
}
function dibujar() {
  const w = canvas.width, hh = canvas.height;
  ctx.fillStyle = '#fbf7ee'; ctx.fillRect(0, 0, w, hh);
  ctx.strokeStyle = '#eee6d6'; ctx.lineWidth = 1;
  for (let x = 40; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh); ctx.stroke(); }
  for (let y = 40; y < hh; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  const c = 70;
  [['#f2b705', 0, 0], ['#1f5fbf', w - c, 0], ['#d6312b', 0, hh - c], ['#1f9d55', w - c, hh - c]].forEach(([col, x, y]) => {
    ctx.globalAlpha = 0.18; ctx.fillStyle = col; ctx.fillRect(x, y, c, c); ctx.globalAlpha = 1;
  });
  if (lastState && world) {
    const r = world.playerRadius;
    for (const p of lastState.players) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colorDe(p); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 0.9)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.badge === 'google' ? 'G' : 'L', p.x, p.y + 1);
      ctx.font = '14px system-ui, sans-serif'; ctx.textBaseline = 'bottom'; ctx.lineWidth = 4; ctx.strokeStyle = '#fbf7ee';
      ctx.strokeText(p.username, p.x, p.y - r - 4); ctx.fillStyle = '#1d1d1f'; ctx.fillText(p.username, p.x, p.y - r - 4);
    }
  } else {
    ctx.fillStyle = '#6b6b70'; ctx.font = '18px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Conectando con el servidor del juego…', w / 2, hh / 2);
  }
  // Marca de agua: que nunca se confunda con la vista de un jugador
  ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = '#1d1d1f'; ctx.font = 'bold 54px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('MODO ESPECTADOR', w / 2, hh / 2); ctx.restore();
  requestAnimationFrame(dibujar);
}
requestAnimationFrame(dibujar);

let firmaLista = '';
function pintarJugadores(players) {
  const firma = players.map(p => `${p.userId}:${p.coordinator}`).join('|');
  if (firma === firmaLista) return;
  firmaLista = firma;
  $('contador').textContent = players.length;
  const ul = $('jugadores');
  if (!players.length) return ul.replaceChildren(h('li', { class: 'vacio' }, 'Nadie jugando todavía'));
  ul.replaceChildren(...players.map(p => h('li', {}, h('span', {}, p.username), h('small', {}, ` · ${p.coordinator}`))));
}

// ── Partidas para mirar ──
function pintarPartidas(msg) {
  const cont = $('partidas');
  const salas = msg.salas || [];
  const filas = salas.map(s => {
    const n = NIVELES[s.nivel] || NIVELES.normal;
    return h('div', { class: 'salas-info esp-partida' },
      h('div', {}, h('b', {}, s.jugadores.join(', ') || '—'),
        h('small', {}, ` ${n.emoji} ${n.nombre} · ${s.estado === 'jugando' ? 'en juego' : s.estado === 'fin' ? 'terminada' : 'esperando'}`)),
      h('button', { class: 'boton salas-unirse esp-mirar', onclick: () => mirar(s.codigo) }, 'Mirar'));
  });
  const nodos = filas.length ? filas : [h('p', { class: 'vacio' }, 'No hay partidas públicas en este momento')];
  if (msg.privadas) nodos.push(h('p', { class: 'salas-subtitulo' }, `${msg.privadas} sala(s) privada(s): necesitas el código`));
  cont.replaceChildren(...nodos);
}
function mirar(codigo) { enviar({ type: 'espectar_sala', codigo }); }
$('formCodigo').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = $('codigo').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length === 6) mirar(c); else toast('El código tiene 6 letras o números', 'error');
});
$('codigo').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

// ── Vista de la partida (solo lectura, la MISMA que ve el jugador) ──
const capa = h('div', { class: 'salas-capa salas-raiz', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Partida (modo espectador)' });
document.body.append(capa);
let juego = null;
function cabecera(sala) {
  const nivel = NIVELES[sala.nivel] || NIVELES.normal;
  return h('header', { class: 'sala-cabecera' },
    h('button', { class: 'btn btn-chico btn-fantasma', onclick: () => enviar({ type: 'dejar_sala' }) }, '← Volver al mundo'),
    h('div', { class: 'sala-titulo' },
      h('span', { class: 'sala-marca' }, 'GUARO ROYAL · PARQUÉS'),
      h('b', {}, sala.tipo === 'publica' ? 'Partida pública' : `Sala privada ${sala.codigo}`),
      h('small', {}, `${nivel.emoji} ${nivel.nombre}`)),
    h('div', { class: 'sala-acciones' }, h('span', { class: 'badge-espectador-sala' }, '👁 MODO ESPECTADOR')));
}
const entornoEspectador = {
  yoId: () => null,                                          // no es ningún jugador: nunca "le toca"
  enviar: () => {},                                          // la partida no puede mandar acciones
  enLinea: (id) => !!(lastState && lastState.players.some(p => String(p.userId) === String(id))),
  cabecera,
  botonesFin: (_s, cerrar) => [h('button', { class: 'btn btn-amarillo', onclick: () => cerrar() }, 'Cerrar')],
  soloLectura: true,
};
function esperando(sala) {
  return h('section', { class: 'sala-espera' }, cabecera(sala),
    h('div', { class: 's-tarjeta' }, h('h3', {}, `Esperando que empiece (${sala.jugadores.filter(j => !j.fuera).length}/${sala.maxJugadores})`),
      h('ul', { class: 'lista-jugadores' }, ...sala.jugadores.filter(j => !j.fuera).map(j => h('li', { class: 's-jugador', style: { '--c': COLORES[j.color].hex, '--cn': COLORES[j.color].neon } },
        h('span', { class: 'ficha-mini' }), h('span', { class: 'jugador-nombre' }, j.nombre))))),
    Reglas(sala));
}
function mostrarSala(sala) {
  if (!sala) {
    viendo = null; capa.hidden = true; document.body.classList.remove('en-sala');
    if (juego) { juego.destruir(); juego = null; }
    return capa.replaceChildren();
  }
  viendo = sala.codigo; capa.hidden = false; document.body.classList.add('en-sala');
  if (sala.estado === 'espera') {
    if (juego) { juego.destruir(); juego = null; }
    return capa.replaceChildren(esperando(sala));
  }
  if (!juego) { juego = Partida(sala, [], entornoEspectador); capa.replaceChildren(juego.el); }
  else juego.recibir(sala, []);
}

// ── Conexión ──
const chat = montarChat({ modo: 'espectador' });
function enviar(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) { toast('Sin conexión', 'error'); return false; }
  ws.send(JSON.stringify(obj));
  return true;
}
async function pedirCoordinador() {
  const ahora = Date.now();
  for (const [id, hasta] of caidos) if (hasta <= ahora) caidos.delete(id);
  const excluir = caidos.size ? `?exclude=${encodeURIComponent([...caidos.keys()].join(','))}` : '';
  const res = await authFetch(`/coordinator${excluir}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.publicUrl) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}
async function conectar() {
  estado('Buscando un coordinador…', 'off');
  try { coord = await pedirCoordinador(); }
  catch (e) { estado('Sin coordinadores disponibles: reintentando…', 'off'); return setTimeout(conectar, 2000); }
  $('coordBadge').textContent = `Coordinador: ${coord.coordinatorId}`; $('coordBadge').classList.remove('sin');
  const url = `${coord.publicUrl.replace(/\/$/, '')}/spectate`;
  const s = new WebSocket(url);
  ws = s;
  s.onopen = () => estado('Mirando en vivo', 'on');
  s.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'bienvenida_espectador': world = msg.world; canvas.width = world.width; canvas.height = world.height; break;
      case 'state': lastState = msg; pintarJugadores(msg.players); break;
      case 'salas_publicas': pintarPartidas(msg); break;
      case 'sala_estado':
        if (!msg.sala && viendo && msg.codigo === viendo) toast('La partida terminó o se cerró');
        chat.cambiarSala(msg.sala ? msg.sala.codigo : null);     // pestaña "Partida" con el chat de esa sala (leer)
        mostrarSala(msg.sala);
        break;
      case 'chat_historial': case 'chat_msg': chat.recibir(msg); break;
      case 'error':
        console.warn('[espectador]', msg.code, msg.message);
        toast(msg.message, 'error');
        break;
    }
  };
  s.onclose = (ev) => {
    if (ws !== s) return;
    lastState = null;
    if (ev.code === 4003) { caidos.set(coord.coordinatorId, Date.now() + 30000); estado('Coordinador lleno de espectadores: busco otro…', 'off'); }
    else { caidos.set(coord.coordinatorId, Date.now() + 5000); estado('Se perdió la conexión: reconectando…', 'off'); }
    setTimeout(conectar, 800);
  };
}
conectar();

// Para la demo: desde DevTools se puede intentar mandar acciones de jugador (el servidor las ignora)
window.guaroEspectador = { enviar, ws: () => ws, coordinador: () => coord };
