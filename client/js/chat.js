// ─────────────────────────────────────────────────────────────
// Guaro Royal · CHAT (interfaz). Lo usan el lobby (jugadores) y la página del espectador (solo leer).
// ─────────────────────────────────────────────────────────────
// Panel flotante y plegable abajo a la izquierda, con DOS pestañas:
//   · "Partida": el chat INDEPENDIENTE de tu sala (solo los jugadores de esa partida, estén en el
//     coordinador que estén, y los espectadores que la miran). Solo aparece si estás en una sala.
//   · "General": todos los jugadores conectados, de todos los coordinadores.
// Los mensajes llegan por el MISMO WebSocket del lobby (lobby.js los reenvía con "guaro:chat") o del espectador.
//
// Seguridad (XSS): el texto y los nombres se pintan SIEMPRE con textContent, nunca con innerHTML.
// Orden: cada mensaje trae su marca (t, c, origin, seq) del reloj híbrido del servidor y se inserta en
// su lugar, así todos ven la misma lista aunque los mensajes lleguen en distinto orden.

const COLORES = ['#ffd23f', '#3fa9ff', '#ff4d6d', '#3ddc84'];
const MAX_VISIBLES = 100;

const el = (tag, props = {}, ...hijos) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;                   // texto SIEMPRE como texto
    else n.setAttribute(k, v);
  }
  for (const h of hijos) if (h != null) n.append(h);           // los strings se agregan como nodos de texto
  return n;
};
const colorDe = (userId) => { let h = 0; for (const c of String(userId)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORES[h % COLORES.length]; };
const clave = (m) => [m.t, m.c, m.origin, m.seq];
function antes(a, b) { const x = clave(a), y = clave(b); for (let i = 0; i < 4; i++) { if (x[i] < y[i]) return true; if (x[i] > y[i]) return false; } return false; }
const hora = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * montarChat({ modo: 'jugador' | 'espectador', enviar(obj) → boolean, miUsuario(): username | null })
 * Devuelve { recibir(msg), cambiarSala(codigo | null) }.
 */
export function montarChat({ modo = 'jugador', enviar = () => false, miUsuario = () => null } = {}) {
  const soloLeer = modo === 'espectador';
  let maxLargo = 200, abierto = false, bloqueadoHasta = 0, reloj = null;
  let sala = null;                                              // código de la sala en la que estoy (o que miro)
  let activo = 'general';                                       // pestaña visible
  try { abierto = localStorage.getItem('guaro.chatAbierto') === '1'; } catch { /* ok */ }

  // Un "canal" de la interfaz: su lista, sus mensajes ordenados y sus no leídos
  function nuevoCanal(textoVacio) {
    return { mensajes: [], ids: new Set(), sinLeer: 0,
      lista: el('ol', { class: 'chat-lista', 'aria-live': 'polite' }), vacio: el('p', { class: 'chat-vacio', text: textoVacio }) };
  }
  const canales = { general: nuevoCanal('Todavía no hay mensajes. ¡Saluda!'), sala: nuevoCanal('Chat de esta partida: solo lo ven sus jugadores.') };
  const canalDe = (nombre) => (nombre === 'general' ? canales.general : sala && nombre === `sala:${sala}` ? canales.sala : null);
  const nombreActivo = () => (activo === 'sala' && sala ? `sala:${sala}` : 'general');

  const cuerpo = el('div', { class: 'chat-cuerpo' });
  const aviso = el('p', { class: 'chat-aviso', role: 'status' });
  const contador = el('span', { class: 'chat-contador', text: '0/200' });
  const entrada = el('input', { class: 'chat-entrada', type: 'text', maxlength: '200', autocomplete: 'off',
    placeholder: 'Escribe un mensaje…', 'aria-label': 'Mensaje para el chat' });
  const btnEnviar = el('button', { class: 'chat-enviar', type: 'submit', 'aria-label': 'Enviar mensaje', text: 'Enviar' });
  const form = soloLeer
    ? el('p', { class: 'chat-solo-leer', text: '👁 Modo espectador: puedes leer el chat. Inicia sesión para escribir.' })
    : el('form', { class: 'chat-form', onsubmit: (e) => { e.preventDefault(); mandar(); } }, entrada, btnEnviar);
  const badge = el('span', { class: 'chat-badge', hidden: '' });
  const boton = el('button', { class: 'chat-boton', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'chat-panel',
    onclick: () => alternar() }, el('span', { 'aria-hidden': 'true', text: '💬' }), el('span', { class: 'chat-boton-texto', text: 'Chat' }), badge);

  // Pestañas
  const badgeTab = { sala: el('span', { class: 'chat-tab-badge', hidden: '' }), general: el('span', { class: 'chat-tab-badge', hidden: '' }) };
  const tabSala = el('button', { class: 'chat-tab', type: 'button', role: 'tab', hidden: '', onclick: () => elegir('sala') },
    el('span', { text: '🎲 Partida' }), badgeTab.sala);
  const tabGeneral = el('button', { class: 'chat-tab', type: 'button', role: 'tab', onclick: () => elegir('general') },
    el('span', { text: '🌎 General' }), badgeTab.general);
  const tabs = el('div', { class: 'chat-tabs', role: 'tablist', 'aria-label': 'Canales del chat' }, tabSala, tabGeneral);
  const subtitulo = el('small', {});

  const panel = el('section', { class: 'chat-panel', id: 'chat-panel', 'aria-label': 'Chat de Guaro Royal', hidden: '' },
    el('header', { class: 'chat-cabecera' },
      el('div', {}, el('b', { text: 'CHAT' }), subtitulo),
      el('button', { class: 'chat-cerrar', type: 'button', 'aria-label': 'Cerrar el chat', text: '✕', onclick: () => alternar(false) })),
    tabs, cuerpo, aviso,
    soloLeer ? null : el('div', { class: 'chat-pie' }, contador),
    form);
  const raiz = el('div', { class: `chat-raiz ${soloLeer ? 'chat-espectador' : ''}` }, panel, boton);
  document.body.append(raiz);

  entrada.addEventListener('input', () => {
    const n = [...entrada.value].length;
    contador.textContent = `${n}/${maxLargo}`;
    contador.classList.toggle('lleno', n > maxLargo);
  });
  entrada.addEventListener('keydown', (e) => e.stopPropagation());   // las flechas no mueven al personaje

  function pintarBadges() {
    for (const k of ['sala', 'general']) {
      const n = canales[k].sinLeer;
      badgeTab[k].hidden = !n; badgeTab[k].textContent = n > 99 ? '99+' : String(n);
    }
    const total = canales.general.sinLeer + (sala ? canales.sala.sinLeer : 0);
    badge.hidden = !total; badge.textContent = total > 99 ? '99+' : String(total);
  }
  function elegir(k) {
    activo = k === 'sala' && sala ? 'sala' : 'general';
    const c = canales[activo];
    cuerpo.replaceChildren(c.vacio, c.lista);
    c.vacio.hidden = c.mensajes.length > 0;
    tabSala.classList.toggle('activa', activo === 'sala'); tabSala.setAttribute('aria-selected', String(activo === 'sala'));
    tabGeneral.classList.toggle('activa', activo === 'general'); tabGeneral.setAttribute('aria-selected', String(activo === 'general'));
    subtitulo.textContent = activo === 'sala' ? ` · solo esta partida${soloLeer ? ' (leer)' : ''}` : soloLeer ? ' · solo lectura' : ' · todos los coordinadores';
    entrada.placeholder = activo === 'sala' ? 'Mensaje para tu partida…' : 'Mensaje para todos…';
    if (abierto) { c.sinLeer = 0; pintarBadges(); }
    bajar();
  }
  function alternar(forzar) {
    abierto = forzar === undefined ? !abierto : forzar;
    panel.hidden = !abierto;
    boton.setAttribute('aria-expanded', String(abierto));
    raiz.classList.toggle('abierto', abierto);
    try { localStorage.setItem('guaro.chatAbierto', abierto ? '1' : '0'); } catch { /* ok */ }
    if (abierto) { canales[activo].sinLeer = 0; pintarBadges(); bajar(); if (!soloLeer) entrada.focus({ preventScroll: true }); }
  }
  const bajar = () => { cuerpo.scrollTop = cuerpo.scrollHeight; };

  function fila(m) {
    const mio = m.username === miUsuario();
    return el('li', { class: `chat-msg ${mio ? 'mio' : ''}`, 'data-id': m.id },
      el('span', { class: 'chat-meta' },
        el('b', { class: 'chat-autor', style: `color:${colorDe(m.userId)}`, text: m.username }),
        el('time', { datetime: new Date(m.ts).toISOString(), text: hora(m.ts) }),
        el('small', { class: 'chat-coord', text: m.origin })),
      el('span', { class: 'chat-texto', text: m.text }));            // textContent: nada de HTML
  }
  function poner(m, contar) {
    const c = m && canalDe(m.canal || 'general');
    if (!c || c.ids.has(m.id)) return;
    c.ids.add(m.id);
    let i = c.mensajes.length;
    while (i > 0 && antes(m, c.mensajes[i - 1])) i--;
    c.mensajes.splice(i, 0, m);
    const visible = c === canales[activo];
    const abajo = cuerpo.scrollHeight - cuerpo.scrollTop - cuerpo.clientHeight < 40;
    const nodo = fila(m);
    if (i >= c.lista.children.length) c.lista.append(nodo); else c.lista.children[i].before(nodo);
    while (c.mensajes.length > MAX_VISIBLES) { c.ids.delete(c.mensajes.shift().id); c.lista.firstElementChild.remove(); }
    c.vacio.hidden = true;
    if (contar && (!abierto || !visible) && m.username !== miUsuario()) { c.sinLeer++; pintarBadges(); }
    if (visible && (abajo || m.username === miUsuario())) bajar();
  }
  function avisar(texto, ms = 0) {
    aviso.textContent = texto;
    aviso.classList.toggle('visible', !!texto);
    clearInterval(reloj);
    if (ms > 0) {
      bloqueadoHasta = Date.now() + ms;
      const tic = () => {
        const s = Math.ceil((bloqueadoHasta - Date.now()) / 1000);
        if (s <= 0) { clearInterval(reloj); avisar(''); btnEnviar.disabled = false; return; }
        aviso.textContent = `${texto.replace(/\d+ s/, `${s} s`)}`;
      };
      btnEnviar.disabled = true;
      reloj = setInterval(tic, 500);
    }
  }
  function mandar() {
    const texto = entrada.value.trim();
    if (!texto) return;
    if ([...texto].length > maxLargo) return avisar(`Máximo ${maxLargo} caracteres`);
    if (Date.now() < bloqueadoHasta) return;
    if (!enviar({ type: 'chat_send', text: texto, canal: nombreActivo() })) return avisar('Sin conexión: espera a que se reconecte');
    entrada.value = ''; contador.textContent = `0/${maxLargo}`; avisar('');
  }

  /** Entré a una sala (o la estoy mirando), cambié de sala o salí de ella */
  function cambiarSala(codigo) {
    if (codigo === sala) return;
    const antes = sala;
    sala = codigo || null;
    const c = canales.sala;                                     // la pestaña de la partida empieza vacía
    c.mensajes = []; c.ids = new Set(); c.sinLeer = 0; c.lista.replaceChildren(); c.vacio.hidden = false;
    tabSala.hidden = !sala;
    if (sala && !soloLeer) enviar({ type: 'chat_historial_pedir', canal: `sala:${sala}` });
    elegir(sala ? 'sala' : 'general');                          // al entrar a una partida se muestra su chat
    if (!antes && sala && !soloLeer) pintarBadges();
  }

  function recibir(msg) {
    if (msg.type === 'chat_historial') {
      if (Number.isInteger(msg.maxLargo)) { maxLargo = msg.maxLargo; entrada.maxLength = maxLargo; contador.textContent = `0/${maxLargo}`; }
      const nombre = msg.canal || 'general';
      (msg.mensajes || []).forEach(m => poner({ ...m, canal: m.canal || nombre }, false));
      bajar();
    } else if (msg.type === 'chat_msg') {
      poner(msg.msg, true);
    } else if (msg.type === 'chat_error') {
      if (!abierto) alternar(true);
      avisar(msg.message || 'No se pudo enviar', msg.code === 'chat_rate_limited' || msg.code === 'chat_silenciado' ? msg.retryInMs || 0 : 0);
    }
  }

  elegir('general');
  alternar(abierto);
  return { recibir, cambiarSala, abrir: () => alternar(true) };
}
