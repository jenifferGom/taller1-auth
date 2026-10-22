// COORDINATOR_WS viene de js/config.js

const token    = localStorage.getItem('token');
const username = localStorage.getItem('username');

// Sin token no hay nada que hacer aquí
if (!token) {
  window.location.href = 'login.html';
  throw new Error('sin token');
}

document.getElementById('yo').textContent = username || '?';

// ───── Volver al login con un mensaje ─────
function volverAlLogin(mensaje, borrarToken = true) {
  if (mensaje) sessionStorage.setItem('aviso', mensaje);
  if (borrarToken) {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
  }
  window.location.href = 'login.html';
}

// ───── Cuenta regresiva del token (solo informativa) ─────
// El cliente NO valida el token: quien decide si es válido es el coordinador.
// Aquí solo leemos "exp" del payload para mostrarlo en pantalla.
function leerExp(jwt) {
  try {
    const base64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64)).exp;
  } catch {
    return null;
  }
}
let exp = leerExp(token);   // se actualiza si el coordinador acepta un token nuevo
function pintarExpiracion() {
  const el = document.getElementById('expira');
  if (!exp) { el.textContent = 'desconocido'; return; }
  const seg = Math.max(0, Math.round(exp - Date.now() / 1000));
  const m = Math.floor(seg / 60), s = seg % 60;
  el.textContent = m ? `${m} min ${s} s` : `${s} s`;
}
pintarExpiracion();
setInterval(pintarExpiracion, 1000);

// ───── Lista de jugadores ─────
const COLORES = ['#f2b705', '#1f5fbf', '#d6312b', '#1f9d55'];   // amarillo, azul, rojo, verde
function colorDe(userId) {
  let h = 0;
  for (const c of String(userId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORES[h % COLORES.length];
}

let miUserId = null;
function renderPlayers(players) {
  const ul = document.getElementById('jugadores');
  document.getElementById('contador').textContent = `(${players.length})`;
  ul.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const ficha = document.createElement('span');
    ficha.className = 'ficha';
    ficha.style.background = colorDe(p.userId);
    const nombre = document.createElement('span');
    nombre.textContent = p.username;              // textContent: evita inyectar HTML
    li.append(ficha, nombre);
    if (p.username === username) {
      const yo = document.createElement('span');
      yo.className = 'yo';
      yo.textContent = 'tú';
      li.append(yo);
    }
    ul.append(li);
  }
}

function estado(texto, clase) {
  document.getElementById('estado').textContent = texto;
  document.getElementById('punto').className = `punto ${clase}`;
}

// ───── WebSocket al coordinador ─────
let cerrandoAProposito = false;
let ultimoError = null;          // el coordinador explica el error antes de cerrar
const ws = new WebSocket(`${COORDINATOR_WS}/connect?token=${encodeURIComponent(token)}`);

function actividad(texto) {
  document.getElementById('actividad').textContent = texto;
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'welcome':                                  // confirmación de conexión
      estado(msg.message, 'on');
      break;
    case 'players_update':                           // alguien entró o salió
      renderPlayers(msg.players);
      if (msg.message) actividad(msg.message);
      break;
    case 'error':                                    // { code, message, hint }
      ultimoError = msg;
      actividad(`${msg.message}. ${msg.hint || ''}`);
      break;
    case 'logout_ok':
      actividad(msg.message);
      break;
    case 'reauth_ok':                                // el coordinador aceptó el token nuevo
      exp = leerExp(tokenEnUso);
      actividad(msg.message);
      break;
  }
};

ws.onclose = (event) => {
  estado('Desconectado', 'off');
  if (cerrandoAProposito) return volverAlLogin(null);     // fue el botón "Cerrar sesión"

  // Si el coordinador mandó una explicación, se muestra esa; si no, una según el código
  const explicacion = ultimoError
    ? `${ultimoError.message}. ${ultimoError.hint || ''}`
    : event.code === 1006
      ? `No se pudo conectar con el coordinador (${COORDINATOR_WS}): puede estar apagado o la URL ser incorrecta.`
      : 'La conexión con el coordinador se cerró.';
  const texto = `${explicacion} [código ${event.code}${event.reason ? `: ${event.reason}` : ''}]`;

  // 4002 = otra pestaña tomó la sesión. No borramos el token porque localStorage
  // es compartido y la otra pestaña lo sigue usando.
  volverAlLogin(texto, event.code !== 4002);
};

// ───── Vigilancia del token guardado ─────
// Si el token de localStorage cambia mientras estamos en el lobby (por ejemplo, alguien lo
// edita desde DevTools), NO lo validamos aquí: se lo reenviamos al coordinador con
// {type:'reauth'}. Si es inválido, el coordinador cierra con 4001 y onclose nos saca al
// login, sin necesidad de recargar la página.
let tokenEnUso = token;

function revisarToken() {
  const actual = localStorage.getItem('token');
  if (actual === tokenEnUso || cerrandoAProposito || ws.readyState !== WebSocket.OPEN) return;
  tokenEnUso = actual;
  actividad('El token cambió: verificándolo con el coordinador…');
  ws.send(JSON.stringify({ type: 'reauth', token: actual || '' }));
}

setInterval(revisarToken, 1000);                 // cambios hechos en esta misma pestaña
window.addEventListener('storage', revisarToken); // cambios hechos desde otra pestaña

// ───── Cerrar sesión ─────
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