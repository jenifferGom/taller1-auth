// COORDINATOR_WS viene de js/config.js
//
// Este archivo NO calcula posiciones. Solo:
//   1. envía al servidor hacia dónde quiere moverse el jugador (mensaje "intent"),
//   2. guarda el último estado que manda el servidor (lastState) y lo dibuja.
// La posición oficial de cada jugador la decide el coordinador.

// ───── 1. Sesión de esta pestaña ─────
// La sesión se guarda por pestaña (sessionStorage): dos pestañas pueden tener usuarios distintos
const token    = sessionStorage.getItem('token');
const username = sessionStorage.getItem('username');

if (!token) {               // sin token no hay nada que hacer aquí
  window.location.href = 'login.html';
  throw new Error('sin token');
}

document.getElementById('yo').textContent = username || '?';

// Variables globales a propósito: se pueden ver y modificar desde la consola (F12).
// La demo de autoridad del PDF modifica lastState para "hacer trampa" localmente.
var lastState = null;        // último mensaje "state" recibido del servidor
var miUsuario = username;
var world     = null;        // { width, height, playerRadius, tickRate } que manda el welcome

// ───── 2. Mensajes para el jugador ─────
// El coordinador manda { code, message, hint } con detalles técnicos. Al jugador le mostramos
// un texto sencillo; el detalle completo va a la consola (F12).
const MENSAJES = {
  token_expired:            'Tu sesión terminó. Vuelve a iniciar sesión para seguir jugando.',
  invalid_signature:        'Tu sesión no es válida. Inicia sesión de nuevo.',
  malformed_token:          'Tu sesión no es válida. Inicia sesión de nuevo.',
  missing_token:            'Tu sesión no es válida. Inicia sesión de nuevo.',
  invalid_token:            'Tu sesión no es válida. Inicia sesión de nuevo.',
  token_user_mismatch:      'Tu sesión cambió de usuario. Inicia sesión de nuevo.',
  session_opened_elsewhere: 'Abriste tu cuenta en otra pestaña o dispositivo, así que cerramos esta.',
  invalid_color:            'Ese color no está disponible.',
  invalid_extras:           'No se pudo cambiar el color.',
  extras_too_large:         'No se pudo cambiar el color.',
};

function amigable(code, porDefecto) {
  return MENSAJES[code] || porDefecto;
}

function volverAlLogin(mensaje, borrarToken = true) {
  if (mensaje) sessionStorage.setItem('aviso', mensaje);
  if (borrarToken) {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('username');
  }
  window.location.href = 'login.html';
}

function estado(texto, clase) {
  document.getElementById('estado').textContent = texto;
  document.getElementById('punto').className = `punto ${clase}`;
}

function actividad(texto) {
  document.getElementById('actividad').textContent = texto;
}

// ───── 3. Cuenta regresiva de la sesión (solo informativa) ─────
// El cliente NO valida el token: quien decide si es válido es el coordinador.
// El coordinador nos dice cuántos milisegundos QUEDAN (expiresInMs). Con eso calculamos el
// momento de vencimiento con el reloj de ESTE equipo, así la cuenta es correcta aunque los
// relojes de los computadores no coincidan.
let venceEn = null;          // momento de vencimiento según el reloj de este equipo (ms)

function actualizarVencimiento(msg) {
  if (Number.isFinite(msg.expiresInMs)) venceEn = Date.now() + msg.expiresInMs;
}

function pintarExpiracion() {
  const el = document.getElementById('expira');
  if (!venceEn) { el.textContent = '—'; return; }
  const seg = Math.max(0, Math.round((venceEn - Date.now()) / 1000));
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
  el.textContent = h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
}
pintarExpiracion();
setInterval(pintarExpiracion, 1000);

// ───── 4. Dibujo del mundo ─────
const canvas = document.getElementById('mundo');
const ctx    = canvas.getContext('2d');
const COLOR_POR_DEFECTO = ['#f2b705', '#1f5fbf', '#d6312b', '#1f9d55'];   // amarillo, azul, rojo, verde

// Color estable por usuario mientras no elija uno propio
function colorDe(p) {
  if (p.extras && p.extras.color) return p.extras.color;
  let h = 0;
  for (const c of String(p.userId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLOR_POR_DEFECTO[h % COLOR_POR_DEFECTO.length];
}

function dibujarFondo() {
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#fbf7ee';
  ctx.fillRect(0, 0, w, h);
  // Cuadrícula suave
  ctx.strokeStyle = '#eee6d6';
  ctx.lineWidth = 1;
  for (let x = 40; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 40; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  // Esquinas con los cuatro colores del parqués
  const c = 70;
  [['#f2b705', 0, 0], ['#1f5fbf', w - c, 0], ['#d6312b', 0, h - c], ['#1f9d55', w - c, h - c]].forEach(([col, x, y]) => {
    ctx.globalAlpha = 0.18; ctx.fillStyle = col; ctx.fillRect(x, y, c, c); ctx.globalAlpha = 1;
  });
}

function dibujarJugador(p, r) {
  const esYo = p.username === miUsuario;

  // Círculo con el color del jugador
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = colorDe(p);
  ctx.fill();
  ctx.lineWidth = esYo ? 4 : 2;
  ctx.strokeStyle = esYo ? '#1d1d1f' : 'rgba(0,0,0,0.25)';
  ctx.stroke();

  // Insignia dentro del círculo: G = Google, L = usuario y contraseña
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(r * 0.9)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.badge === 'google' ? 'G' : 'L', p.x, p.y + 1);

  // Nombre encima
  ctx.font = `${esYo ? 'bold ' : ''}14px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  const texto = esYo ? `${p.username} (tú)` : p.username;
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#fbf7ee';
  ctx.strokeText(texto, p.x, p.y - r - 4);
  ctx.fillStyle = '#1d1d1f';
  ctx.fillText(texto, p.x, p.y - r - 4);
}

// Se dibuja en cada cuadro del navegador, siempre a partir de lastState (lo que dijo el servidor)
function dibujar() {
  dibujarFondo();
  if (lastState && world) {
    for (const p of lastState.players) dibujarJugador(p, world.playerRadius);
  } else {
    ctx.fillStyle = '#6b6b70';
    ctx.font = '18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Conectando con el servidor del juego…', canvas.width / 2, canvas.height / 2);
  }
  requestAnimationFrame(dibujar);
}
requestAnimationFrame(dibujar);

// ───── 5. Panel: jugadores en línea y selector de color ─────
let firmaLista = '';
function pintarJugadores(players) {
  // Solo se redibuja la lista si cambió algo (no 20 veces por segundo)
  const firma = players.map(p => `${p.userId}:${p.username}:${colorDe(p)}:${p.badge}`).join('|');
  if (firma === firmaLista) return;
  firmaLista = firma;

  document.getElementById('contador').textContent = `(${players.length})`;
  const ul = document.getElementById('jugadores');
  ul.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const ficha = document.createElement('span');
    ficha.className = 'ficha';
    ficha.style.background = colorDe(p);
    const nombre = document.createElement('span');
    nombre.textContent = p.username;                 // textContent: un nombre no puede inyectar HTML
    const insignia = document.createElement('span');
    insignia.className = `insignia ${p.badge}`;
    insignia.textContent = p.badge === 'google' ? 'Google' : 'Local';
    li.append(ficha, nombre, insignia);
    if (p.username === miUsuario) {
      const yo = document.createElement('span');
      yo.className = 'yo';
      yo.textContent = 'tú';
      li.append(yo);
    }
    ul.append(li);
  }
}

function pintarColores(colores) {
  const cont = document.getElementById('colores');
  cont.innerHTML = '';
  for (const color of colores) {
    const b = document.createElement('button');
    b.className = 'color';
    b.style.background = color;
    b.dataset.color = color;
    b.title = color;
    b.setAttribute('aria-label', `Elegir color ${color}`);
    b.addEventListener('click', () => {
      // El cliente solo PIDE el cambio; el servidor lo valida y lo replica en el próximo state
      ws.send(JSON.stringify({ type: 'extras_update', extras: { color } }));
      b.blur();               // devuelve el teclado al juego
    });
    cont.append(b);
  }
}

function marcarColorElegido() {
  const yo = lastState && lastState.players.find(p => p.username === miUsuario);
  const actual = yo && yo.extras && yo.extras.color;
  for (const b of document.querySelectorAll('.color')) b.classList.toggle('elegido', b.dataset.color === actual);
}

// ───── 6. Conexión con el coordinador ─────
let cerrandoAProposito = false;
let ultimoError = null;          // el coordinador explica el motivo antes de cerrar
const ws = new WebSocket(`${COORDINATOR_WS}/connect?token=${encodeURIComponent(token)}`);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'welcome': {
      // Identidad + dimensiones del mundo: el canvas se arma con lo que dice el servidor
      world = msg.world;
      canvas.width  = world.width;
      canvas.height = world.height;
      miUsuario = msg.you.username;
      const insignia = document.getElementById('insignia');
      insignia.className = `insignia ${msg.you.provider}`;
      insignia.textContent = msg.you.provider === 'google' ? 'Google' : 'Local';
      actualizarVencimiento(msg);
      pintarExpiracion();
      pintarColores(msg.colors || []);
      estado('Conectado. ¡A jugar!', 'on');
      canvas.focus();
      break;
    }
    case 'state':                                     // 20 veces por segundo
      lastState = msg;
      pintarJugadores(msg.players);
      marcarColorElegido();
      break;
    case 'players_update':                            // alguien entró o salió
      if (msg.event) actividad(msg.message);
      break;
    case 'extras_ok':
      actividad('¡Color actualizado! Todos los jugadores ya lo ven.');
      break;
    case 'session_update':                            // cambió la duración de la sesión (o se corrigió el reloj)
      console.log('[juego] session_update', msg);
      actualizarVencimiento(msg);
      pintarExpiracion();
      if (msg.refresh) renovarToken();                // la duración aumentó: pedimos un token más largo
      else if (msg.message) actividad('La duración de la sesión cambió.');
      break;
    case 'reauth_ok':
      console.log('[juego] reauth_ok', msg);
      actualizarVencimiento(msg);
      pintarExpiracion();
      break;
    case 'error':                                     // { code, message, hint }
      ultimoError = msg;
      console.warn('[juego] error del servidor', msg);
      if (MENSAJES[msg.code]) actividad(MENSAJES[msg.code]);
      break;
  }
};

ws.onclose = (event) => {
  estado('Desconectado', 'off');
  console.log(`[juego] conexión cerrada: código ${event.code} "${event.reason}"`, ultimoError || '');
  if (cerrandoAProposito) return volverAlLogin(null);     // fue el botón "Cerrar sesión"

  let texto;
  if (ultimoError) texto = amigable(ultimoError.code, 'Tu sesión se cerró. Inicia sesión de nuevo.');
  else if (event.code === 1006) texto = 'Se perdió la conexión con el servidor del juego. Inténtalo de nuevo en un momento.';
  else texto = 'Tu sesión se cerró. Inicia sesión de nuevo.';

  // 4002 = la misma cuenta se abrió en otra pestaña o navegador: se conserva el token de esta pestaña
  volverAlLogin(texto, event.code !== 4002);
};

// ───── 7. Teclado → intención de movimiento ─────
// Solo se envía la dirección deseada (-1, 0 o 1 por eje) y solo cuando cambia.
const TECLAS = {
  ArrowUp: 'arriba', KeyW: 'arriba',
  ArrowDown: 'abajo', KeyS: 'abajo',
  ArrowLeft: 'izquierda', KeyA: 'izquierda',
  ArrowRight: 'derecha', KeyD: 'derecha',
};
const presionadas = new Set();
let ultimaDir = { x: 0, y: 0 };

function enviarIntencion() {
  const dir = {
    x: (presionadas.has('derecha') ? 1 : 0) - (presionadas.has('izquierda') ? 1 : 0),
    y: (presionadas.has('abajo') ? 1 : 0) - (presionadas.has('arriba') ? 1 : 0),
  };
  if (dir.x === ultimaDir.x && dir.y === ultimaDir.y) return;
  ultimaDir = dir;
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'intent', intent: { dir } }));
}

window.addEventListener('keydown', (e) => {
  const accion = TECLAS[e.code];
  if (!accion) return;
  e.preventDefault();                 // que las flechas no muevan la página
  presionadas.add(accion);
  enviarIntencion();
});
window.addEventListener('keyup', (e) => {
  const accion = TECLAS[e.code];
  if (!accion) return;
  presionadas.delete(accion);
  enviarIntencion();
});
// Si la pestaña pierde el foco, se sueltan todas las teclas (para que no siga caminando solo)
window.addEventListener('blur', () => { presionadas.clear(); enviarIntencion(); });

// ───── 8. Vigilancia del token guardado ─────
// Si el token de sessionStorage cambia (por ejemplo, alguien lo edita en DevTools), NO lo
// validamos aquí: se lo reenviamos al coordinador con {type:'reauth'}. Si es inválido, el
// coordinador cierra con 4001 y onclose nos lleva al login, sin recargar la página.
let tokenEnUso = token;

// Cuando la duración de la sesión aumenta, el token actual sigue siendo el corto (su exp va
// firmado). Le pedimos al auth uno nuevo con la duración vigente y se lo pasamos al coordinador.
async function renovarToken() {
  try {
    const res = await fetch(`${AUTH_URL}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({ token: tokenEnUso }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      console.warn('[juego] no se pudo renovar el token', res.status, data);
      return;
    }
    sessionStorage.setItem('token', data.token);
    tokenEnUso = data.token;
    ws.send(JSON.stringify({ type: 'reauth', token: data.token }));   // el coordinador lo verifica
    actividad('Tu sesión se extendió.');
  } catch (err) {
    console.warn('[juego] no se pudo contactar al auth para renovar el token', err);
  }
}

setInterval(() => {
  const actual = sessionStorage.getItem('token');
  if (actual === tokenEnUso || cerrandoAProposito || ws.readyState !== WebSocket.OPEN) return;
  tokenEnUso = actual;
  console.log('[juego] el token cambió: se envía al coordinador para verificarlo');
  ws.send(JSON.stringify({ type: 'reauth', token: actual || '' }));
}, 1000);

// ───── 9. Cerrar sesión ─────
// Se avisa al coordinador ({type:'logout'}); él confirma y cierra la conexión.
document.getElementById('logout').addEventListener('click', () => {
  cerrandoAProposito = true;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'logout' }));
    setTimeout(() => volverAlLogin(null), 1500);   // por si el coordinador no responde
  } else {
    volverAlLogin(null);
  }
});