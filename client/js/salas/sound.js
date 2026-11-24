// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · SONIDOS (sintetizados con Web Audio: no hay archivos)
// ─────────────────────────────────────────────────────────────
let ctx = null;
let silencio = false;

export function setSilencio(v) {
  silencio = !!v;
  try { localStorage.setItem('parques.silencio', silencio ? '1' : '0'); } catch { /* ok */ }
}
function audio() {
  if (silencio) return null;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch { return null; }
}

function tono(freq, dur, { tipo = 'sine', vol = 0.15, desde = 0, hasta = null } = {}) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + desde;
  const o = a.createOscillator(), g = a.createGain();
  o.type = tipo; o.frequency.setValueAtTime(freq, t);
  if (hasta) o.frequency.exponentialRampToValueAtTime(hasta, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
function ruido(dur, { vol = 0.2, desde = 0, filtro = 1800 } = {}) {
  const a = audio(); if (!a) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf; f.type = 'bandpass'; f.frequency.value = filtro; g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination); src.start(a.currentTime + desde);
}

export const sonidos = {
  dados()   { for (let i = 0; i < 7; i++) ruido(0.05, { vol: 0.25, desde: i * 0.11 + Math.random() * 0.04, filtro: 1500 + Math.random() * 1500 }); },
  par()     { [523, 659, 784, 1047].forEach((f, i) => tono(f, 0.18, { tipo: 'triangle', desde: i * 0.07, vol: 0.12 })); },
  paso()    { tono(620 + Math.random() * 80, 0.06, { tipo: 'square', vol: 0.05 }); },
  comer()   { tono(900, 0.35, { tipo: 'sawtooth', hasta: 120, vol: 0.12 }); ruido(0.25, { vol: 0.15, filtro: 600 }); },
  cielo()   { [523, 659, 784, 1047, 1319].forEach((f, i) => tono(f, 0.3, { tipo: 'triangle', desde: i * 0.09, vol: 0.13 })); },
  salir()   { tono(330, 0.12, { tipo: 'triangle', vol: 0.12 }); tono(494, 0.16, { tipo: 'triangle', desde: 0.1, vol: 0.12 }); },
  fallo()   { tono(220, 0.25, { tipo: 'sawtooth', hasta: 140, vol: 0.08 }); },
  cuenta()  { tono(880, 0.12, { tipo: 'square', vol: 0.06 }); },
  salud()   { [784, 988, 1175].forEach((f, i) => tono(f, 0.4, { tipo: 'sine', desde: i * 0.05, vol: 0.12 })); },
  gluglu()  { for (let i = 0; i < 6; i++) tono(160 + Math.random() * 90, 0.12, { tipo: 'sine', desde: i * 0.13, hasta: 90, vol: 0.2 }); },
  victoria(){ [523, 659, 784, 659, 784, 1047].forEach((f, i) => tono(f, 0.25, { tipo: 'triangle', desde: i * 0.14, vol: 0.13 })); },
};

/** Vibración del celular (si existe) */
export function vibrar(patron) {
  try { if (!silencio && navigator.vibrate) navigator.vibrate(patron); } catch { /* ok */ }
}
