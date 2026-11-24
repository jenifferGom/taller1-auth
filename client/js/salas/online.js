// ─────────────────────────────────────────────────────────────
// Guaro Royal · PARQUÉS EN EL LOBBY (interfaz)
// ─────────────────────────────────────────────────────────────
// Partidas públicas (búsqueda automática) y salas privadas (con código) entre los jugadores del lobby,
// desde cualquier computador. Todo viaja por la MISMA conexión WebSocket del lobby (lobby.js):
//   · lobby.js reenvía aquí salas_config / sala_estado / busqueda_estado / sala_error (evento "guaro:mensaje")
//   · y expone window.enviarAlServidor(obj) para mandar partida_buscar, sala_crear, sala_tirar…
// Este archivo NO tiene reglas: el coordinador dueño de la sala tira los dados, valida cada jugada,
// decide los shots y manda la lista de jugadas válidas al jugador de turno. Aquí solo se dibuja y anima.
import { COLORES, NIVELES } from './textos.js';
import { setSilencio } from './sound.js';
import { h, toast } from './ui/dom.js';
import { Partida } from './partida.js';
import { Reglas } from './ui/Reglas.js';

const yo = { id: null, nombre: null };
let config = { publica: { min: 2, max: 4 }, privada: { min: 2, max: 4 }, nivelPublica: 'normal' };
let salaActual = null;          // la sala en la que estoy (lo último que mandó el servidor)
let jugadasActuales = [];       // jugadas válidas que mandó el servidor (solo si es mi turno de mover)
let busqueda = { buscando: false };
let quiereBuscar = false;       // para volver a buscar si me cambian de coordinador mientras busco
let nivelPublica = null;        // nivel de shots elegido para la partida pública (se recuerda en este navegador)
try { nivelPublica = localStorage.getItem('guaro.nivelPublica'); } catch { /* ok */ }
let silencio = false;
try { silencio = localStorage.getItem('guaro.silencio') === '1'; } catch { /* ok */ }
setSilencio(silencio);

// ─────────────────────────────────────────────────────────────
// Comunicación
// ─────────────────────────────────────────────────────────────
function enviar(obj) {
  if (!window.enviarAlServidor || !window.enviarAlServidor(obj)) toast('Sin conexión con el servidor del juego', 'error');
}

function recibir(msg) {
  switch (msg.type) {
    case 'welcome':                                 // también al reconectarse a otro coordinador
      yo.id = String(msg.you.userId); yo.nombre = msg.you.username;
      busqueda = { buscando: false };
      if (quiereBuscar) setTimeout(() => { if (!salaActual) buscarPublica(); }, 300);
      pintarPanel();
      break;
    case 'salas_config':
      config = { publica: msg.publica, privada: msg.privada, nivelPublica: msg.nivelPublica };
      if (!NIVELES[nivelPublica]) nivelPublica = NIVELES[config.nivelPublica] ? config.nivelPublica : 'normal';
      pintarPanel();
      break;
    case 'sala_estado':
      if (!msg.sala && salaActual && salaActual.codigo === msg.codigo) toast('Saliste de la sala');
      salaActual = msg.sala;
      jugadasActuales = msg.jugadas || [];
      if (salaActual) quiereBuscar = false;
      pintarPanel();
      vista.mostrar(salaActual, jugadasActuales);
      break;
    case 'busqueda_estado':
      busqueda = msg;
      if (!msg.buscando && !msg.encontrada) quiereBuscar = false;
      pintarPanel();
      break;
    case 'sala_error':
      console.warn('[salas]', msg.code, msg.message);
      toast(msg.message || 'No se pudo', 'error');
      vista.desbloquear();
      break;
  }
}
function buscarPublica() {
  quiereBuscar = true;
  enviar({ type: 'partida_buscar', nivel: nivelPublica });
}

/** ¿Este jugador está conectado ahora? (lo dice el último "state" del lobby) */
function enLinea(id) {
  const st = window.lastState;
  return !!(st && st.players && st.players.some(p => String(p.userId) === String(id)));
}

// ─────────────────────────────────────────────────────────────
// Tarjeta "Salas" del lobby
// ─────────────────────────────────────────────────────────────
const contenedor = document.getElementById('salas');
let formAbierto = false;
let relojPanel = null;

function pintarPanel() {
  if (!contenedor) return;
  clearInterval(relojPanel); relojPanel = null;
  if (!yo.id) return contenedor.replaceChildren(h('p', { class: 'vacio' }, 'Conectando…'));
  if (salaActual) {
    const c = COLORES[(salaActual.jugadores.find(j => j.id === yo.id) || { color: 0 }).color];
    const que = salaActual.tipo === 'publica' ? 'una partida pública' : `la sala ${salaActual.codigo}`;
    return contenedor.replaceChildren(h('div', { class: 'salas-mia', style: { '--c': c.hex } },
      h('span', {}, 'Estás en ', h('b', {}, que)),
      h('button', { class: 'boton boton-dorado salas-boton', onclick: () => vista.mostrar(salaActual, jugadasActuales, true) },
        salaActual.estado === 'espera' ? 'Abrir sala de espera' : 'Volver a la partida')));
  }
  if (busqueda.buscando) {
    const texto = h('small', {});
    const actualizar = () => {
      const faltan = busqueda.empiezaEn ? Math.max(0, Math.ceil((busqueda.empiezaEn - Date.now()) / 1000)) : null;
      texto.textContent = `${busqueda.enCola || 1} de ${busqueda.maximo || config.publica.max} en la cola`
        + (faltan !== null ? ` · arranca en ${faltan} s` : ` · se necesitan al menos ${busqueda.minimo || config.publica.min}`);
    };
    actualizar(); relojPanel = setInterval(actualizar, 500);
    return contenedor.replaceChildren(h('div', { class: 'salas-buscando' },
      h('span', { class: 'salas-girando', 'aria-hidden': 'true' }, '🎲'),
      h('div', {}, h('b', {}, 'Buscando partida…'), h('small', { class: 'salas-nivel-busqueda' },
        `${(NIVELES[busqueda.nivel] || NIVELES.normal).emoji} ${(NIVELES[busqueda.nivel] || NIVELES.normal).nombre} · `), texto),
      h('button', { class: 'boton salas-secundario', onclick: () => { quiereBuscar = false; enviar({ type: 'partida_cancelar' }); } }, 'Cancelar')));
  }
  contenedor.replaceChildren(
    // Partida pública: el mismo selector de nivel que la sala privada
    h('div', { class: 'salas-form salas-publica' },
      h('label', {}, 'Nivel de shots'),
      selectorNivel(nivelPublica || 'normal', (n) => { nivelPublica = n; try { localStorage.setItem('guaro.nivelPublica', n); } catch { /* ok */ } }),
      h('button', { class: 'boton boton-dorado salas-boton', onclick: buscarPublica }, '🎲 Jugar partida pública'),
      h('p', { class: 'salas-subtitulo' }, `${config.publica.min} a ${config.publica.max} jugadores · se juntan los que eligieron el mismo nivel`)),
    formAbierto ? formCrear() : h('button', { class: 'boton salas-secundario salas-ancho', onclick: () => { formAbierto = true; pintarPanel(); } }, 'Crear sala privada'),
    formUnirse());
}
function formUnirse() {
  const codigo = h('input', { class: 'salas-codigo', maxlength: 6, placeholder: 'CÓDIGO', 'aria-label': 'Código de la sala privada', autocomplete: 'off',
    oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); } });
  return h('form', { class: 'salas-unirse-form', onsubmit: (e) => {
    e.preventDefault();
    if (codigo.value.length === 6) enviar({ type: 'sala_unirse', codigo: codigo.value });
    else toast('El código tiene 6 letras o números', 'error');
  } }, codigo, h('button', { class: 'boton salas-unirse', type: 'submit' }, 'Unirse'));
}
/** Selector de nivel de shots (Suave · Normal · Modo Guaro): el MISMO para sala privada y partida pública */
function selectorNivel(inicial, alCambiar) {
  let nivel = NIVELES[inicial] ? inicial : 'normal';
  const niv = h('div', { class: 'salas-niveles', role: 'radiogroup', 'aria-label': 'Nivel de shots' });
  const pintar = () => niv.replaceChildren(...Object.entries(NIVELES).map(([id, n]) => h('button', { type: 'button', role: 'radio',
    'aria-checked': String(id === nivel), class: id === nivel ? 'activo' : '', title: n.descripcion, onclick: () => { nivel = id; alCambiar(id); pintar(); } },
    h('span', {}, n.emoji), n.nombre)));
  pintar();
  return niv;
}
function formCrear() {
  const { min, max } = config.privada;
  let jugadores = max, nivel = 'normal';
  const seg = h('div', { class: 'salas-seg', role: 'radiogroup', 'aria-label': 'Máximo de jugadores' });
  const pintarSeg = () => seg.replaceChildren(...Array.from({ length: max - min + 1 }, (_, i) => min + i).map(n => h('button', { type: 'button', role: 'radio',
    'aria-checked': String(n === jugadores), class: n === jugadores ? 'activo' : '', onclick: () => { jugadores = n; pintarSeg(); } }, `${n}`)));
  const niv = selectorNivel(nivel, (n) => { nivel = n; });
  pintarSeg();
  return h('form', { class: 'salas-form', onsubmit: (e) => { e.preventDefault(); formAbierto = false; enviar({ type: 'sala_crear', maxJugadores: jugadores, nivel }); } },
    h('label', {}, 'Máximo de jugadores'), seg,
    h('label', {}, 'Nivel de shots'), niv,
    h('div', { class: 'salas-fila' },
      h('button', { type: 'button', class: 'boton salas-secundario', onclick: () => { formAbierto = false; pintarPanel(); } }, 'Cancelar'),
      h('button', { type: 'submit', class: 'boton boton-dorado salas-boton' }, 'Crear')));
}

// ─────────────────────────────────────────────────────────────
// Capa de la sala (espera y partida), encima del lobby
// ─────────────────────────────────────────────────────────────
const vista = (() => {
  const capa = h('div', { class: 'salas-capa salas-raiz', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sala de parqués' });
  document.body.append(capa);
  let juego = null, minimizada = false, relojEspera = null;

  const abrir = () => { capa.hidden = false; document.body.classList.add('en-sala'); };
  const minimizar = () => { minimizada = true; capa.hidden = true; document.body.classList.remove('en-sala'); };
  function cerrar() {
    capa.hidden = true; document.body.classList.remove('en-sala');
    clearInterval(relojEspera);
    if (juego) { juego.destruir(); juego = null; }
    capa.replaceChildren();
  }

  return {
    mostrar(sala, jugadas, forzar = false) {
      if (!sala) { minimizada = false; return cerrar(); }
      if (forzar) minimizada = false;
      if (minimizada) return juego && juego.recibir(sala, jugadas);
      abrir();
      if (sala.estado === 'espera') {
        if (juego) { juego.destruir(); juego = null; }
        clearInterval(relojEspera);
        const el = SalaDeEspera(sala, minimizar);
        capa.replaceChildren(el.el);
        if (el.tic) relojEspera = setInterval(el.tic, 250);
      } else {
        clearInterval(relojEspera);
        if (!juego) { juego = Partida(sala, jugadas, entornoJugador(minimizar)); capa.replaceChildren(juego.el); }
        else juego.recibir(sala, jugadas);
      }
    },
    desbloquear() { if (juego) juego.desbloquear(); },
    cerrar,
  };
})();

function cabecera(sala, minimizar) {
  const nivel = NIVELES[sala.nivel] || NIVELES.normal;
  const btnSonido = h('button', { class: 'btn btn-chico btn-fantasma', 'aria-label': 'Silenciar sonidos', onclick: () => {
    silencio = !silencio; setSilencio(silencio); try { localStorage.setItem('guaro.silencio', silencio ? '1' : '0'); } catch { /* ok */ }
    btnSonido.textContent = silencio ? '🔇' : '🔊';
  } }, silencio ? '🔇' : '🔊');
  const titulo = sala.tipo === 'publica' ? 'Partida pública' : `Sala privada ${sala.codigo}`;
  return h('header', { class: 'sala-cabecera' },
    h('button', { class: 'btn btn-chico btn-fantasma', onclick: minimizar, title: 'Volver al lobby sin salir de la sala' }, '← Lobby'),
    h('div', { class: 'sala-titulo' },
      h('span', { class: 'sala-marca' }, 'GUARO ROYAL · PARQUÉS'),
      h('b', {}, titulo), h('small', {}, `${nivel.emoji} ${nivel.nombre}`)),
    h('div', { class: 'sala-acciones' }, btnSonido,
      h('button', { class: 'btn btn-chico btn-peligro', onclick: () => {
        if (sala.estado === 'jugando' && !confirm('¿Salir de la partida? Tus turnos se saltarán.')) return;
        enviar({ type: 'sala_salir' });
      } }, 'Salir de la sala')));
}

// La partida (js/salas/partida.js) con lo que puede hacer un JUGADOR de este navegador
function entornoJugador(minimizar) {
  return {
    yoId: () => yo.id,
    enviar,
    enLinea,
    cabecera: (s) => cabecera(s, minimizar),
    botonesFin: (s, cerrar) => {
      const host = s.anfitrion === yo.id;
      const otra = s.tipo === 'publica'
        ? h('button', { class: 'btn btn-amarillo', onclick: () => { cerrar(); quiereBuscar = true; enviar({ type: 'sala_salir' }); setTimeout(() => enviar({ type: 'partida_buscar', nivel: nivelPublica }), 300); } }, 'Buscar otra partida')
        : host ? h('button', { class: 'btn btn-amarillo', onclick: () => { cerrar(); enviar({ type: 'sala_revancha' }); } }, 'Revancha')
        : h('span', { class: 's-nota' }, 'El anfitrión puede pedir revancha');
      return [h('button', { class: 'btn btn-fantasma', onclick: () => { cerrar(); enviar({ type: 'sala_salir' }); } }, 'Salir'), otra];
    },
  };
}

// ── Sala de espera ──
function SalaDeEspera(sala, minimizar) {
  const publica = sala.tipo === 'publica';
  const soyHost = sala.anfitrion === yo.id;
  const mio = sala.jugadores.find(j => j.id === yo.id) || {};
  const activos = sala.jugadores.filter(j => !j.fuera);
  const listos = activos.filter(j => j.listo).length;
  const puede = activos.length >= config.privada.min && listos === activos.length;
  const copiar = async () => {
    try { await navigator.clipboard.writeText(sala.codigo); toast('Código copiado 📋'); } catch { toast(`El código es ${sala.codigo}`); }
  };
  const cuenta = h('div', { class: 's-cuenta', 'aria-live': 'polite' });
  const tic = publica ? () => {
    const s = Math.max(0, Math.ceil(((sala.empiezaEn || Date.now()) - Date.now()) / 1000));
    cuenta.textContent = s > 0 ? `La partida empieza en ${s} s` : 'Empezando…';
  } : null;
  if (tic) tic();

  const el = h('section', { class: 'sala-espera' },
    cabecera(sala, minimizar),
    publica
      ? h('div', { class: 's-tarjeta codigo-sala' }, h('span', { class: 's-etiqueta' }, 'Partida pública'), cuenta,
          h('p', { class: 's-nota' }, 'Mientras tanto, elige si juegas con Modo Agua 💧'))
      : h('div', { class: 's-tarjeta codigo-sala' },
          h('span', { class: 's-etiqueta' }, 'Código de la sala'),
          h('div', { class: 'codigo', 'aria-label': `Código ${sala.codigo.split('').join(' ')}` }, ...sala.codigo.split('').map(c => h('span', {}, c))),
          h('button', { class: 'btn btn-chico btn-dorado', onclick: copiar }, '📋 Copiar'),
          h('p', { class: 's-nota' }, 'Pásale este código a quien quieras invitar: la sala no aparece en ninguna lista.')),
    h('div', { class: 's-tarjeta' },
      h('h3', {}, `Jugadores (${activos.length}/${sala.maxJugadores})`),
      h('ul', { class: 'lista-jugadores' }, ...activos.map(j => {
        const c = COLORES[j.color], esYo = j.id === yo.id;
        return h('li', { class: `s-jugador ${j.listo || publica ? 'listo' : ''}`, style: { '--c': c.hex, '--cn': c.neon } },
          h('span', { class: 'ficha-mini', 'aria-hidden': 'true' }),
          h('span', { class: 'jugador-nombre' },
            h('span', {}, j.nombre, esYo ? h('small', {}, ' (tú)') : null, !publica && j.id === sala.anfitrion ? h('small', { title: 'Anfitrión' }, ' 👑') : null),
            h('small', { class: 'color-nombre' }, c.nombre)),
          esYo
            ? h('button', { class: `pill ${j.agua ? 'activo agua' : ''}`, title: 'Modo Agua: el shot se cambia por agua o un reto',
                'aria-pressed': String(!!j.agua), onclick: () => enviar({ type: 'sala_agua', agua: !j.agua }) }, '💧 Agua')
            : (j.agua ? h('span', { class: 'pill activo agua' }, '💧') : null),
          publica ? null : esYo
            ? h('button', { class: `pill pill-listo ${j.listo ? 'activo' : ''}`, 'aria-pressed': String(!!j.listo),
                onclick: () => enviar({ type: 'sala_listo', listo: !j.listo }) }, j.listo ? '✔ Listo' : '¿Listo?')
            : h('span', { class: `pill pill-listo ${j.listo ? 'activo' : ''}` }, j.listo ? '✔ Listo' : 'Esperando'));
      }))),
    publica ? null : soyHost
      ? (puede ? h('button', { class: 'btn btn-grande btn-rojo pulso', onclick: () => enviar({ type: 'sala_empezar' }) }, '🎲 Empezar partida')
          : h('p', { class: 's-esperando' }, activos.length < config.privada.min ? `Esperando a que entren al menos ${config.privada.min} jugadores`
            : `Esperando a que todos estén listos (${listos}/${activos.length})`))
      : h('p', { class: 's-esperando' }, mio.listo ? 'El anfitrión empieza cuando todos estén listos' : 'Marca "¿Listo?" cuando quieras jugar'),
    Reglas(sala));                                       // las reglas de esta sala, para leerlas antes de empezar
  return { el, tic };
}

// Arranque: primero lo que llegó antes de que este módulo cargara, luego lo que vaya llegando
{
  const u = window.guaroUltimos || {};
  for (const t of ['welcome', 'salas_config', 'busqueda_estado', 'sala_estado']) if (u[t]) recibir(u[t]);
  window.addEventListener('guaro:mensaje', (e) => recibir(e.detail));
}
pintarPanel();

// Para depurar desde la consola: window.guaroSalas.sala()
window.guaroSalas = { sala: () => salaActual, jugadas: () => jugadasActuales, yo: () => ({ ...yo }), busqueda: () => busqueda };
