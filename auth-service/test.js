// Pruebas del auth-service. Uso (con el auth encendido):
//   npm test                                   → prueba http://localhost:4000
//   node test.js https://xxxx.ngrok-free.dev   → prueba otra URL (por ejemplo, el túnel de ngrok)
// Crea usuarios de prueba con nombres aleatorios (prueba_XXXX), así se puede repetir.

const BASE = (process.argv[2] || 'http://localhost:4000').replace(/\/$/, '');
const suffix = Math.random().toString(36).slice(2, 7);
const user = `Prueba_${suffix}`;
const pass = 'secret123';

let passed = 0, failed = 0;

async function call(method, route, body, raw) {
  const res = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function check(name, cond, info) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}\n      recibido: ${JSON.stringify(info)}`); }
}

function jwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

(async () => {
  console.log(`Probando ${BASE} con el usuario ${user}\n`);

  let r = await call('GET', '/health');
  check('GET /health responde 200', r.status === 200, r);

  r = await call('GET', '/session-policy');
  check('GET /session-policy informa la duración', r.status === 200 && r.data.seconds > 0, r);

  r = await call('POST', '/register', { username: user, password: pass });
  check('Registro exitoso → 201 { userId, username }', r.status === 201 && r.data.userId && r.data.username === user, r);

  r = await call('POST', '/register', { username: user, password: pass });
  check('Registro repetido → 409 username_taken', r.status === 409 && r.data.error === 'username_taken', r);

  r = await call('POST', '/register', { username: user.toLowerCase(), password: pass });
  check('Mismo username en minúsculas → 409 username_taken', r.status === 409 && r.data.error === 'username_taken', r);

  r = await call('POST', '/register', { username: user.toUpperCase(), password: pass });
  check('Mismo username en MAYÚSCULAS → 409 username_taken', r.status === 409 && r.data.error === 'username_taken', r);

  r = await call('POST', '/register', { username: 'a b', password: pass });
  check('Username con espacio → 400 invalid_username', r.status === 400 && r.data.error === 'invalid_username', r);

  r = await call('POST', '/register', { username: `corta_${suffix}`, password: '123' });
  check('Contraseña corta → 400 invalid_password', r.status === 400 && r.data.error === 'invalid_password', r);

  r = await call('POST', '/register', { username: user });
  check('Falta password → 400 missing_fields', r.status === 400 && r.data.error === 'missing_fields', r);

  r = await call('POST', '/register', undefined, '{"username": mal');
  check('JSON mal escrito → 400 invalid_json', r.status === 400 && r.data.error === 'invalid_json', r);

  r = await call('POST', '/login', { username: user, password: pass });
  const ok = r.status === 200 && typeof r.data.token === 'string';
  check('Login correcto → 200 { token, username }', ok && r.data.username === user, r);
  if (ok) {
    const p = jwtPayload(r.data.token);
    check('El JWT trae userId, username, provider, iat y exp',
      p.userId && p.username === user && p.provider === 'local' && p.iat && p.exp, p);
  }

  r = await call('POST', '/login', { username: user.toLowerCase(), password: pass });
  check('Login sin importar mayúsculas → 200', r.status === 200 && r.data.username === user, r);

  r = await call('POST', '/login', { username: user, password: 'incorrecta' });
  check('Contraseña incorrecta → 401 invalid_credentials', r.status === 401 && r.data.error === 'invalid_credentials', r);

  r = await call('POST', '/login', { username: `noexiste_${suffix}`, password: pass });
  check('Usuario inexistente → 401 invalid_credentials (mismo mensaje)', r.status === 401 && r.data.error === 'invalid_credentials', r);

  // ── Google: casos que se pueden probar sin una cuenta real ──
  r = await call('GET', '/auth/google/config');
  check('GET /auth/google/config entrega el Client ID', r.status === 200 && /\.apps\.googleusercontent\.com$/.test(r.data.clientId || ''), r);

  r = await call('POST', '/auth/google', {});
  check('Google sin idToken → 400 missing_id_token', r.status === 400 && r.data.error === 'missing_id_token', r);

  r = await call('POST', '/auth/google', { idToken: 'esto.no.es-un-token-de-google-valido' });
  check('Google con ID Token falso → 401 invalid_id_token', r.status === 401 && r.data.error === 'invalid_id_token', r);

  r = await call('GET', '/register');
  check('Ruta o método inexistente → 404 not_found', r.status === 404 && r.data.error === 'not_found', r);

  console.log(`\n${passed} correctas, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(`\nNo se pudo conectar con ${BASE}: ${err.message}`);
  console.error('¿Está encendido el auth-service (npm start)?');
  process.exit(1);
});
