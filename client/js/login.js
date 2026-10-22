// AUTH_URL viene de js/config.js

// Mensaje dejado por el lobby al cerrarse el WebSocket (se muestra una sola vez)
const aviso = sessionStorage.getItem('aviso');
if (aviso) {
  const el = document.getElementById('aviso');
  el.textContent = aviso;
  el.classList.add('visible');
  sessionStorage.removeItem('aviso');
}

function mostrar(id, texto, tipo) {
  const el = document.getElementById(id);
  el.textContent = texto;
  el.className = `mensaje ${tipo}`;
}

// POST JSON al servicio de autenticación
async function postAuth(ruta, body) {
  const res = await fetch(`${AUTH_URL}${ruta}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',   // evita la página de aviso de ngrok en las peticiones
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Los errores del auth vienen como { error: CÓDIGO, message, hint }
function textoError(data, status) {
  if (!data.message) return `Error inesperado (HTTP ${status})`;
  return data.hint ? `${data.message}. ${data.hint}` : data.message;
}

function leerForm(form) {
  return {
    username: form.username.value.trim(),
    password: form.password.value,
  };
}

// ───── Registro ─────
document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const boton = form.querySelector('button');
  boton.disabled = true;
  try {
    const { status, data } = await postAuth('/register', leerForm(form));
    if (status === 201) {
      mostrar('msg-register', data.message, 'ok');
      document.getElementById('login-user').value = data.username;
      document.getElementById('login-pass').focus();
      form.reset();
    } else {
      mostrar('msg-register', textoError(data, status), 'error');
    }
  } catch {
    mostrar('msg-register', `No se pudo contactar al servicio de autenticación (${AUTH_URL}). Verifica que esté encendido.`, 'error');
  } finally {
    boton.disabled = false;
  }
});

// ───── Login ─────
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const boton = form.querySelector('button');
  boton.disabled = true;
  try {
    const { status, data } = await postAuth('/login', leerForm(form));
    if (status === 200 && data.token) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('username', data.username);
      window.location.href = 'lobby.html';
    } else {
      mostrar('msg-login', textoError(data, status), 'error');
    }
  } catch {
    mostrar('msg-login', `No se pudo contactar al servicio de autenticación (${AUTH_URL}). Verifica que esté encendido.`, 'error');
  } finally {
    boton.disabled = false;
  }
});
