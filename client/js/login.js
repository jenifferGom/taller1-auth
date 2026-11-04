// AUTH_URL viene de js/config.js

// Mensaje dejado por el lobby al cerrarse la conexión (se muestra una sola vez)
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

// ───── Mensajes para el jugador ─────
// El auth responde { error: código, message, hint } con detalles técnicos. Al jugador le
// mostramos un texto sencillo según el código; el detalle completo va a la consola (F12).
const MENSAJES = {
  username_taken:      'Ese nombre de usuario ya está en uso. Prueba con otro.',
  invalid_username:    'El nombre de usuario debe tener entre 3 y 32 caracteres: letras sin tildes, números o _.',
  invalid_password:    'La contraseña debe tener al menos 6 caracteres.',
  missing_fields:      'Completa el usuario y la contraseña.',
  invalid_credentials: 'Usuario o contraseña incorrectos.',
  use_google_login:    'Esta cuenta se creó con Google. Entra con el botón de Google.',
  invalid_id_token:    'No pudimos verificar tu cuenta de Google. Inténtalo de nuevo.',
  email_not_verified:  'Tu correo de Google no está verificado. Usa otra cuenta.',
  missing_id_token:    'No llegó la respuesta de Google. Inténtalo de nuevo.',
};

function mensajeAmigable(status, data) {
  console.log(`[auth] HTTP ${status}`, data);       // detalle técnico para quien depura
  return MENSAJES[data.error] || 'Algo salió mal. Inténtalo de nuevo en unos segundos.';
}

function sinConexion(err) {
  console.error(`[auth] No se pudo conectar con ${AUTH_URL}:`, err);
  return 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
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

// Guarda la sesión de ESTA pestaña y entra al juego.
// sessionStorage es independiente por pestaña: así se pueden tener dos usuarios distintos
// en dos pestañas del mismo navegador (la demo del PDF: alice y bob_google).
function entrar(data) {
  sessionStorage.setItem('token', data.token);
  sessionStorage.setItem('username', data.username);
  window.location.href = 'lobby.html';
}

function leerForm(form) {
  return { username: form.username.value.trim(), password: form.password.value };
}

// ───── Registro local ─────
document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const boton = form.querySelector('button');
  boton.disabled = true;
  try {
    const { status, data } = await postAuth('/register', leerForm(form));
    if (status === 201) {
      mostrar('msg-register', `¡Listo! Tu cuenta "${data.username}" fue creada. Ahora inicia sesión.`, 'ok');
      document.getElementById('login-user').value = data.username;
      document.getElementById('login-pass').focus();
      form.reset();
    } else {
      mostrar('msg-register', mensajeAmigable(status, data), 'error');
    }
  } catch (err) {
    mostrar('msg-register', sinConexion(err), 'error');
  } finally {
    boton.disabled = false;
  }
});

// ───── Login local ─────
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const boton = form.querySelector('button');
  boton.disabled = true;
  try {
    const { status, data } = await postAuth('/login', leerForm(form));
    if (status === 200 && data.token) entrar(data);
    else mostrar('msg-login', mensajeAmigable(status, data), 'error');
  } catch (err) {
    mostrar('msg-login', sinConexion(err), 'error');
  } finally {
    boton.disabled = false;
  }
});

// ───── Login con Google (opción A: Google Identity Services) ─────
// 1. Google muestra su botón y, al pulsarlo, nos entrega un ID Token (JWT firmado por Google).
// 2. Lo enviamos a POST /auth/google. El auth lo verifica contra Google (no lo verificamos aquí).
// 3. Si es la primera vez (409 username_required) pedimos un username y reenviamos.
let idTokenPendiente = null;   // ID Token guardado mientras el usuario elige su username
const formUsername = document.getElementById('form-google-username');

async function enviarGoogle(idToken, username) {
  mostrar('msg-google', 'Verificando tu cuenta de Google…', '');
  try {
    const { status, data } = await postAuth('/auth/google', username ? { idToken, username } : { idToken });

    if (status === 200 && data.token) return entrar(data);

    if (status === 409 && data.error === 'username_required') {
      console.log('[auth] Primer login con Google: se pide username', data);
      idTokenPendiente = idToken;
      formUsername.classList.remove('oculto');
      mostrar('msg-google', '', '');
      document.getElementById('google-user').focus();
      return;
    }
    if (data.error === 'invalid_id_token') idTokenPendiente = null;   // hay que volver a pulsar el botón
    mostrar('msg-google', mensajeAmigable(status, data), 'error');
  } catch (err) {
    mostrar('msg-google', sinConexion(err), 'error');
  }
}

formUsername.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!idTokenPendiente) {
    return mostrar('msg-google', 'Vuelve a pulsar el botón de Google para continuar.', 'error');
  }
  enviarGoogle(idTokenPendiente, document.getElementById('google-user').value.trim());
});

// El Client ID vive en el .env del auth; se lo pedimos para no repetirlo en config.js
async function iniciarBotonGoogle() {
  let clientId;
  try {
    const res = await fetch(`${AUTH_URL}/auth/google/config`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
    clientId = (await res.json()).clientId;
  } catch (err) {
    console.error('[google] No se pudo obtener el Client ID del auth:', err);
    return mostrar('msg-google', 'El inicio de sesión con Google no está disponible en este momento.', 'error');
  }

  // El script de Google carga en paralelo: esperamos hasta 10 s a que esté listo
  for (let i = 0; i < 50 && !(window.google && google.accounts && google.accounts.id); i++) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (!(window.google && google.accounts && google.accounts.id)) {
    console.error('[google] No cargó https://accounts.google.com/gsi/client');
    return mostrar('msg-google', 'No se pudo cargar el botón de Google. Revisa tu conexión y recarga la página.', 'error');
  }

  google.accounts.id.initialize({
    client_id: clientId,
    callback: (respuesta) => {                                      // credential = ID Token
      // Para probar /auth/google en Thunder Client: escribe  MOSTRAR_ID_TOKEN = true  en la
      // consola (F12) antes de pulsar el botón y el ID Token aparecerá aquí. Dura ~1 hora.
      if (window.MOSTRAR_ID_TOKEN) console.log('[google] ID Token (solo para pruebas):', respuesta.credential);
      enviarGoogle(respuesta.credential);
    },
  });
  google.accounts.id.renderButton(document.getElementById('google-btn'), {
    theme: 'outline', size: 'large', text: 'signin_with', locale: 'es',
  });
}

iniciarBotonGoogle();
