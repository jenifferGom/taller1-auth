// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · CONFIGURACIÓN (variables del .env del coordinador)
// ─────────────────────────────────────────────────────────────
// Todas son opcionales: si no están en el .env se usan los valores por defecto.
//   SALA_PUBLICA_MIN / SALA_PUBLICA_MAX   tamaño de una partida pública            (2 / 4)
//   SALA_PRIVADA_MIN / SALA_PRIVADA_MAX   rango que puede elegir el anfitrión       (2 / 4)
//   PUBLICA_ESPERA_MS                     espera antes de arrancar con menos del máximo (20000)
//   PUBLICA_CUENTA_MS                     cuenta regresiva en la sala de espera pública (10000)
//   PUBLICA_NIVEL                         nivel de shots de las públicas: suave | normal | guaro (normal)
//   SALA_ABANDONADA_MS                    cierre de una sala sin nadie conectado    (120000)

const LIMITE_TABLERO = { min: 2, max: 4 };          // el tablero tiene 4 colores: nunca más de 4 ni menos de 2

function entero(valor, porDefecto) {
  const n = parseInt(valor, 10);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
}
const acotar = (n) => Math.min(LIMITE_TABLERO.max, Math.max(LIMITE_TABLERO.min, n));

function rango(min, max) {
  const a = acotar(min), b = acotar(max);
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

function leerConfig(env = process.env) {
  const publica = rango(entero(env.SALA_PUBLICA_MIN, 2), entero(env.SALA_PUBLICA_MAX, 4));
  const privada = rango(entero(env.SALA_PRIVADA_MIN, 2), entero(env.SALA_PRIVADA_MAX, 4));
  const nivel = String(env.PUBLICA_NIVEL || 'normal').trim().toLowerCase();
  return {
    publica,
    privada,
    esperaPublicaMs: entero(env.PUBLICA_ESPERA_MS, 20000),
    cuentaPublicaMs: entero(env.PUBLICA_CUENTA_MS, 10000),
    nivelPublica: ['suave', 'normal', 'guaro'].includes(nivel) ? nivel : 'normal',
    salaAbandonadaMs: Math.max(1000, entero(env.SALA_ABANDONADA_MS, 120000)),
  };
}

module.exports = { leerConfig };
