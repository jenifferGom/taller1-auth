// ─────────────────────────────────────────────────────────────
// Cliente HTTP hacia los auth-services replicados (Taller 7)
// ─────────────────────────────────────────────────────────────
// Hay VARIOS auth-services: un líder (acepta escrituras) y réplicas. authFetch hace lo que pide el PDF:
//   · error de red, timeout, 5xx, o respuesta que no es JSON (túnel de ngrok caído) → prueba con el siguiente
//   · 503 not_leader → repite la petición directamente contra leaderUrl (el líder)
//   · 503 no_leader  → hay una elección en curso (unos segundos): espera y reintenta
// Recuerda el último auth que respondió bien para no empezar siempre por uno caído.
// AUTH_URLS viene de js/config.js.

const AUTH_BASES = (typeof AUTH_URLS !== 'undefined' ? AUTH_URLS : [AUTH_URL]).map(u => u.replace(/\/+$/, ''));
const AUTH_TIMEOUT_MS = 4000;

// Qué nodo contestó la última petición: { authId, role, base }. Lo muestra la UI.
let authInfo = null;
function recordarAuth(base, res) {
  const authId = res.headers.get('X-Auth-Id');
  if (!authId) return;
  const nuevo = !authInfo || authInfo.authId !== authId || authInfo.role !== res.headers.get('X-Auth-Role');
  authInfo = { authId, role: res.headers.get('X-Auth-Role'), base };
  if (nuevo && typeof window.onAuthInfo === 'function') window.onAuthInfo(authInfo);
}

let authPreferido = null;
try { authPreferido = sessionStorage.getItem('authPreferido'); } catch { /* sin sessionStorage */ }

async function authFetchUna(base, ruta, opciones) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AUTH_TIMEOUT_MS);
  try {
    return await fetch(base + ruta, { ...opciones, signal: ctl.signal,
      headers: { 'ngrok-skip-browser-warning': 'true', ...(opciones.headers || {}) } });   // evita la página de aviso de ngrok
  } finally { clearTimeout(timer); }
}

// Una pasada por todos los auth. Devuelve { res } o { error, sinLider }
async function authPasada(ruta, opciones) {
  const cola = [...new Set([authPreferido, ...AUTH_BASES].filter(Boolean))];
  const probados = new Set();
  let ultimo = 'ningún auth-service respondió', sinLider = false;
  while (cola.length) {
    const base = cola.shift();
    if (probados.has(base)) continue;
    probados.add(base);
    let res;
    try { res = await authFetchUna(base, ruta, opciones); }
    catch (err) { ultimo = `${base}: ${err.name === 'AbortError' ? 'no respondió a tiempo' : err.message}`; continue; }

    const esJson = (res.headers.get('content-type') || '').includes('application/json');
    if (!esJson && res.status >= 400) { ultimo = `${base}: HTTP ${res.status} sin JSON (¿túnel caído?)`; continue; }
    if (res.status === 503) {
      const cuerpo = await res.clone().json().catch(() => ({}));
      if (cuerpo.error === 'not_leader' && cuerpo.leaderUrl) {            // una réplica: directo al líder
        const lider = String(cuerpo.leaderUrl).replace(/\/+$/, '');
        console.log(`[auth] ${base} es réplica: se repite contra el líder ${lider}`);
        if (!probados.has(lider)) cola.unshift(lider);
        ultimo = `${base} es réplica`;
        continue;
      }
      if (cuerpo.error === 'no_leader') { ultimo = `${base}: elección en curso`; sinLider = true; continue; }
    } else if (res.status >= 500) { ultimo = `${base}: HTTP ${res.status}`; continue; }

    authPreferido = base;
    try { sessionStorage.setItem('authPreferido', base); } catch { /* ok */ }
    recordarAuth(base, res);
    return { res };
  }
  return { error: ultimo, sinLider };
}

// authFetch('/login', { method: 'POST', headers: {...}, body: '...' })  →  Response
// reintentarMs: cuánto insistir si no hay líder (una elección dura unos segundos). 0 = una sola pasada.
async function authFetch(ruta, opciones = {}, reintentarMs = 0) {
  const limite = Date.now() + reintentarMs;
  for (;;) {
    const r = await authPasada(ruta, opciones);
    if (r.res) return r.res;
    if (Date.now() >= limite) {
      const err = new Error(r.error);
      err.sinLider = r.sinLider;
      throw err;
    }
    await new Promise(ok => setTimeout(ok, 1000));
  }
}
