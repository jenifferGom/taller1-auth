// AUTH_URL viene de js/config.js. La URL del coordinador YA NO está fija: se le pregunta al auth (GET /coordinator).
//
// Este archivo NO calcula posiciones. Solo:
//   1. envía al servidor hacia dónde quiere moverse el jugador (mensaje "intent"),
//   2. guarda el último estado que manda el servidor (lastState) y lo dibuja.
// La posición oficial de cada jugador la decide el coordinador.

// Flujo (Taller 6): login → GET /coordinator → WebSocket al publicUrl que diga el auth.
// Si el WebSocket se cae NO se reintenta el mismo coordinador: se vuelve a pedir GET /coordinator.

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
  const firma = players.map(p => `${p.userId}:${p.username}:${colorDe(p)}:${p.badge}:${p.coordinator}`).join('|');
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
    if (p.coordinator) {                              // en qué coordinador está conectado ese jugador
      const coord = document.createElement('span');
      coord.className = 'coordtag';
      coord.textContent = p.coordinator;
      li.append(coord);
    }
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
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'extras_update', extras: { color } }));
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

// ───── 6. Conexión con el coordinador (directory + reconexión) ─────
let ws = null;                      // WebSocket actual (cambia en cada reconexión)
let cerrandoAProposito = false;
let ultimoError = null;             // el coordinador explica el motivo antes de cerrar
let coordinadorActual = null;       // { coordinatorId, publicUrl } que asignó el auth
let intentos = 0;
let reconectando = false;
const ESPERA_MS = 1000;             // pausa entre reintentos
const CONEXION_MAX_MS = 4000;       // si el WS no abre en este tiempo, se descarta y se vuelve a preguntar

function mostrarCoordinador(id, extra) {
  document.getElementById('coordinador').textContent = id || '—';
  const badge = document.getElementById('coordBadge');
  badge.textContent = `Coordinador: ${id || '—'}${extra ? ' · ' + extra : ''}`;
  badge.classList.toggle('sin', !id);
}

// Paso 2 del flujo: ¿a cuál coordinador me conecto? (el auth elige el de menor carga y que esté vivo)
// Coordinadores que se acaban de caer: se le pide al auth que no los devuelva por unos segundos
// (puede seguir listándolos hasta 6 s, mientras no se venza su heartbeat).
const caidos = new Map();           // coordinatorId → hasta cuándo evitarlo (ms)
async function pedirCoordinador() {
  const ahora = Date.now();
  for (const [id, hasta] of caidos) if (hasta <= ahora) caidos.delete(id);
  const excluir = caidos.size ? `?exclude=${encodeURIComponent([...caidos.keys()].join(','))}` : '';
  const res = await fetch(`${AUTH_URL}/coordinator${excluir}`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.publicUrl) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.sinCoordinadores = res.status === 503;
    throw err;
  }
  return data;                      // { coordinatorId, publicUrl }
}

// Paso 3: abre el WebSocket al coordinador asignado, con el token
async function conectar() {
  reconectando = false;
  estado(intentos ? 'Buscando coordinador…' : 'Pidiendo coordinador…', 'off');
  mostrarCoordinador(null);
  try {
    coordinadorActual = await pedirCoordinador();
  } catch (err) {
    console.warn('[juego] GET /coordinator falló:', err.message);
    estado(err.sinCoordinadores ? 'No hay coordinadores disponibles. Reintentando…' : 'Sin conexión con el servidor. Reintentando…', 'off');
    return reintentar();
  }
  console.log(`[juego] el auth asignó ${coordinadorActual.coordinatorId} (${coordinadorActual.publicUrl})`);
  mostrarCoordinador(coordinadorActual.coordinatorId, 'conectando…');
  estado(`Conectando a ${coordinadorActual.coordinatorId}…`, 'off');
  abrirSocket();
}

// Rebalanceo automático: se pide coordinador al auth y se abre el WebSocket nuevo SIN recargar.
// El viejo lo cierra su coordinador (4002) cuando ve que entraste en otro; como "ws" ya apunta
// al socket nuevo, ese cierre se ignora. El coordinador viejo, antes de avisar, detiene al jugador y
// manda por el mesh su posición y color exactos: al llegar al nuevo aparece en el mismo punto y color.
let migrando = false;
async function migrar() {
  if (migrando || reconectando || cerrandoAProposito) return;
  migrando = true;
  let cambio = false;
  try {
    const nuevo = await pedirCoordinador();
    if (nuevo.coordinatorId === coordinadorActual.coordinatorId) return;   // el auth dice quedarse
    cambio = true;
    console.log(`[juego] rebalanceo: ${coordinadorActual.coordinatorId} → ${nuevo.coordinatorId}`);
    actividad(`Te pasamos a ${nuevo.coordinatorId} para repartir mejor la carga`);
    coordinadorActual = nuevo;
    mostrarCoordinador(nuevo.coordinatorId, 'cambiando…');
    abrirSocket();
  } catch (err) {
    console.warn('[juego] rebalanceo cancelado:', err.message);           // se queda donde está
  } finally {
    migrando = false;
    if (!cambio && ws && ws.readyState === WebSocket.OPEN) {               // se queda: puede seguir moviéndose
      ws.send(JSON.stringify({ type: 'rebalance_cancel' }));
      ultimaDir = { x: 0, y: 0 };
      enviarIntencion();
    }
  }
}

function reintentar(inmediato = false) {
  if (cerrandoAProposito || reconectando) return;
  reconectando = true;
  intentos++;
  setTimeout(conectar, inmediato ? 0 : ESPERA_MS);   // si se cayó el coordinador, se busca otro YA
}

function abrirSocket() {
  // seq: si por una carrera quedo conectado en dos coordinadores, ellos se quedan con la conexión más nueva
  const socket = new WebSocket(`${coordinadorActual.publicUrl}/connect?token=${encodeURIComponent(token)}&seq=${Date.now()}`);
  ws = socket;
  ultimoError = null;
  let abrio = false;
  // Un coordinador que murió hace segundos puede seguir en el directorio: si no abre, se pregunta de nuevo
  const timer = setTimeout(() => { if (!abrio) socket.close(); }, CONEXION_MAX_MS);

  socket.onopen = () => {
    abrio = true;
    clearTimeout(timer);
    // Se reenvía la tecla que siga apretada: el coordinador nuevo no sabe hacia dónde caminabas
    ultimaDir = { x: 0, y: 0 };
    enviarIntencion();
  };

  socket.onmessage = (event) => {
    if (socket !== ws) return;
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'welcome': {
        // Identidad + dimensiones del mundo: el canvas se arma con lo que dice el servidor
        world = msg.world;
        canvas.width  = world.width;
        canvas.height = world.height;
        miUsuario = msg.you.username;
        intentos = 0;
        mostrarCoordinador(msg.coordinatorId || coordinadorActual.coordinatorId);
        document.getElementById('tick').textContent = `${world.tickRate} Hz`;
        const insignia = document.getElementById('insignia');
        insignia.className = `insignia ${msg.you.provider}`;
        insignia.textContent = msg.you.provider === 'google' ? 'Google' : 'Local';
        actualizarVencimiento(msg);
        pintarExpiracion();
        pintarColores(msg.colors || []);
        estado(`Conectado a ${msg.coordinatorId}. ¡A jugar!`, 'on');
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
      case 'rebalance':                                 // el coordinador tiene de más: cambiarse sin recargar
        migrar();
        break;
      case 'error':                                     // { code, message, hint }
        ultimoError = msg;
        console.warn('[juego] error del servidor', msg);
        if (MENSAJES[msg.code]) actividad(MENSAJES[msg.code]);
        break;
    }
  };

  socket.onclose = (event) => {
    clearTimeout(timer);
    if (socket !== ws) return;
    console.log(`[juego] conexión con ${coordinadorActual.coordinatorId} cerrada: código ${event.code} "${event.reason}"`, ultimoError || '');
    if (cerrandoAProposito) return volverAlLogin(null);     // fue el botón "Cerrar sesión"

    // Problemas de SESIÓN (token vencido o inválido, cuenta abierta en otro lado): al login, como antes.
    if (ultimoError || event.code === 4001 || event.code === 4002) {
      estado('Desconectado', 'off');
      const texto = amigable(ultimoError && ultimoError.code, 'Tu sesión se cerró. Inicia sesión de nuevo.');
      return volverAlLogin(texto, event.code !== 4002);     // 4002: se conserva el token de esta pestaña
    }

    // Problemas del COORDINADOR (se cayó, no responde, se apagó): NO se reconecta al mismo,
    // se vuelve a pedir GET /coordinator y se conecta al que diga el auth.
    const caido = coordinadorActual.coordinatorId;
    caidos.set(caido, Date.now() + 8000);
    estado(`Se perdió ${caido}. Buscando otro coordinador…`, 'off');
    actividad(abrio ? `Se perdió la conexión con ${caido}. Buscando otro coordinador…` : `${caido} no responde. Buscando otro…`);
    mostrarCoordinador(null, `${caido} caído`);
    reintentar(abrio);                                  // estaba conectado: reconexión inmediata
  };
}

// ───── Arranque: login → pedir coordinador → conectar ─────
conectar();

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
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'intent', intent: { dir } }));
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
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reauth', token: data.token }));   // el coordinador lo verifica
    actividad('Tu sesión se extendió.');
  } catch (err) {
    console.warn('[juego] no se pudo contactar al auth para renovar el token', err);
  }
}

setInterval(() => {
  const actual = sessionStorage.getItem('token');
  if (actual === tokenEnUso || cerrandoAProposito || !ws || ws.readyState !== WebSocket.OPEN) return;
  tokenEnUso = actual;
  console.log('[juego] el token cambió: se envía al coordinador para verificarlo');
  ws.send(JSON.stringify({ type: 'reauth', token: actual || '' }));
}, 1000);

// ───── 9. Cerrar sesión ─────
// Se avisa al coordinador ({type:'logout'}); él confirma y cierra la conexión.
document.getElementById('logout').addEventListener('click', () => {
  cerrandoAProposito = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'logout' }));
    setTimeout(() => volverAlLogin(null), 1500);   // por si el coordinador no responde
  } else {
    volverAlLogin(null);
  }
});