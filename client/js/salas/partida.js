// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · VISTA DE UNA PARTIDA (tablero, dados, tabla, shots y reglas)
// ─────────────────────────────────────────────────────────────
// La usan el jugador (js/salas/online.js) y el espectador (js/espectador.js, en solo lectura).
// No tiene reglas: anima lo que manda el coordinador (sala.ultimo) y dibuja las "jugadas" que él calculó.
import { COLORES, ANIMACION } from './textos.js';
import { CIELO, CARCEL, jugadorActual, esPar, tabla } from './tablero.js';
import { sonidos, vibrar } from './sound.js';
import { h, esperar, toast } from './ui/dom.js';
import { Board } from './ui/Board.js';
import { Dice } from './ui/Dice.js';
import { PlayerPanel } from './ui/PlayerPanel.js';
import { abrirShot, abrirEleccion } from './ui/ShotModal.js';
import { confeti, letrero, avisoTurno } from './ui/effects.js';
import { Reglas } from './ui/Reglas.js';

/**
 * Partida(sala, jugadas, entorno)
 * entorno = {
 *   yoId(): id del jugador de este navegador (null para un espectador),
 *   enviar(obj): manda una acción al coordinador (el espectador no tiene),
 *   enLinea(id): ¿ese jugador está conectado?,
 *   cabecera(sala): elemento de la cabecera,
 *   botonesFin(sala, cerrar): botones del cuadro de fin de partida,
 *   soloLectura: true en el modo espectador (sin botón de tirar ni clics en el tablero)
 * }
 */
export function Partida(sala0, jugadas0, entorno) {
  const yoId = () => entorno.yoId();
  const enLinea = (id) => entorno.enLinea(id);
  const soloLectura = !!entorno.soloLectura;
  const enviar = (obj) => { if (!soloLectura) entorno.enviar(obj); };
  const board = Board({ onFicha: tocarFicha, onDestino: (m) => moverA(m) });
  const dice = Dice();
  const btnTirar = h('button', { class: 'btn btn-tirar', onclick: () => tirar() }, 'TIRAR DADOS');
  const btnSaltar = h('button', { class: 'btn btn-chico btn-fantasma', hidden: true, onclick: () => enviar({ type: 'sala_saltar' }) }, '⏭ Saltar turno (no está conectado)');
  const resultado = h('div', { class: 'resultado', 'aria-live': 'polite' });
  const pista = h('p', { class: 'pista' });
  const turno = h('div', { class: 'turno-actual' });
  const panel = h('div', { class: 'contenedor-panel' });
  const cab = h('div', {});
  const reglas = h('div', { class: 'columna-reglas' });            // recuadro "REGLAS DEL JUEGO" al lado del tablero
  if (soloLectura) btnTirar.hidden = true;
  const el = h('section', { class: `sala-juego ${soloLectura ? 'solo-lectura' : ''}` }, cab,
    h('div', { class: 'juego-cuerpo' },
      h('div', { class: 'columna-tablero' }, turno, h('div', { class: 'marco-tablero' }, board.el)),
      h('div', { class: 'columna-lateral' }, h('div', { class: 'zona-dados' }, dice.el, resultado, btnTirar, btnSaltar, pista), panel),
      reglas));

  let sala = sala0, jugadas = [], prev = null, vistoSeq = -1, cola = [], procesando = false, vivo = true;
  let seleccion = null, esperandoServidor = false, animando = false;
  let modalShot = null, modalShotId = null, finMostrado = -1, ultimoTurno = null;

  recibir(sala0, jugadas0);

  function recibir(s, js) { cola.push({ s, js: js || [] }); procesar(); }
  async function procesar() {
    if (procesando) return;
    procesando = true;
    while (cola.length && vivo) {
      const { s, js } = cola.shift();
      if (cola.length && !(s.ultimo && s.ultimo.seq > vistoSeq)) continue;     // estados intermedios sin jugada: se saltan
      await aplicar(s, js);
    }
    procesando = false;
  }
  async function aplicar(s, js) {
    if (!s.game) return;
    const nuevaPartida = !prev || (s.ultimo && s.ultimo.tipo === 'inicio' && s.ultimo.seq > vistoSeq) || s.game.jugadores.length !== prev.jugadores.length;
    if (nuevaPartida) {
      cab.replaceChildren(entorno.cabecera(s));
      reglas.replaceChildren(Reglas(s));
      board.montar(s.game); dice.mostrar(s.game.dados || [1, 1]);
    } else if (s.ultimo && s.ultimo.seq > vistoSeq) {
      animando = true; pintar(sala, true);
      try { await animarJugada(prev, s.ultimo, s.game); } catch (e) { console.warn('[salas] animación', e); }
      animando = false;
    }
    if (s.ultimo) vistoSeq = Math.max(vistoSeq, s.ultimo.seq);
    sala = s; jugadas = js; prev = s.game; esperandoServidor = false;
    if (seleccion && !jugadas.some(m => `${yoId()}:${m.ficha}` === seleccion)) seleccion = null;
    pintar(s);
    atenderShots(s);
    if (s.estado === 'fin' && finMostrado !== s.seq && !s.shots.length) { finMostrado = s.seq; finDePartida(s); }
  }

  // ── Dibujo ──
  function pintar(s, soloTablero = false) {
    const g = s.game, actual = jugadorActual(g), c = COLORES[actual.color];
    const miTurno = actual.id === yoId() && s.estado === 'jugando';
    const bloqueado = animando || esperandoServidor || s.shots.length > 0;
    if (!soloTablero) {
      turno.style.setProperty('--c', c.hex); turno.style.setProperty('--cn', c.neon);
      turno.replaceChildren(s.estado !== 'jugando'
        ? h('span', {}, '🏆 ', h('b', {}, (g.jugadores.find(j => j.id === g.ganador) || { nombre: '—' }).nombre), ' ganó la partida')
        : h('span', {}, miTurno ? '¡Te toca, ' : 'Turno de ', h('b', {}, actual.nombre), miTurno ? '!' : '', h('small', {}, ` · ronda ${g.ronda}`)));
      btnTirar.disabled = !miTurno || g.fase !== 'tirar' || bloqueado;
      btnTirar.style.setProperty('--c', c.hex); btnTirar.style.setProperty('--cn', c.neon);
      btnSaltar.hidden = !(s.anfitrion === yoId() && s.estado === 'jugando' && !miTurno && !enLinea(actual.id));
      panel.replaceChildren(PlayerPanel(g));
      const presas = g.fichas[actual.id].every(r => r === CARCEL || r >= CIELO) && g.fichas[actual.id].some(r => r === CARCEL);
      pista.textContent = s.estado !== 'jugando' ? ''
        : s.shots.length ? 'Pausa: hay un shot pendiente 🥃'
        : soloLectura ? `Juega ${actual.nombre}`
        : !miTurno ? `Esperando a ${actual.nombre}…`
        : g.fase === 'mover' ? (seleccion ? 'Elige el destino (cada círculo es un dado o los dos)' : 'Toca una ficha que brille')
        : presas ? `Necesitas PAR para salir de la cárcel · intento ${g.intentosCarcel + 1} de ${g.reglas.intentosParaSalir}`
        : 'Tira los dados';
      if (g.fase === 'mover' && g.dados) {
        resultado.replaceChildren(...[0, 1].map(d => h('span', { class: `chip-dado chip-${d ? 'b' : 'a'} ${g.usados[d] ? 'usado' : ''}` }, `${d ? 'B' : 'A'}: ${g.dados[d]}`)),
          ...(esPar(g.dados) ? [h('span', { class: 'es-par' }, '¡PAR!')] : []));
      }
      if (ultimoTurno !== null && ultimoTurno !== g.turno && s.estado === 'jugando' && actual.id === yoId()) { avisoTurno(actual); vibrar(80); }
      ultimoTurno = g.turno;
    }
    // Las fichas que brillan y los destinos salen de las "jugadas" que mandó el servidor
    const movs = miTurno && g.fase === 'mover' && !bloqueado ? jugadas : [];
    if (!animando) board.sincronizar(g, {
      turnoColor: s.estado === 'jugando' ? actual.color : null,
      movibles: new Set(movs.map(m => `${actual.id}:${m.ficha}`)),
      seleccion, movs, jugadorId: movs.length ? actual.id : null,
    });
  }

  // ── Acciones: se piden al servidor; la respuesta es el siguiente sala_estado ──
  function tocarFicha(jugadorId, ficha) {
    if (soloLectura) return;
    const g = sala.game;
    if (animando || esperandoServidor || sala.shots.length || g.fase !== 'mover') return;
    if (jugadorActual(g).id !== yoId()) return toast(`Es el turno de ${jugadorActual(g).nombre}`);
    if (jugadorId !== yoId()) return;
    if (!jugadas.some(m => m.ficha === ficha)) return toast('Esa ficha no se puede mover con estos dados');
    const id = `${jugadorId}:${ficha}`;
    seleccion = seleccion === id ? null : id;
    pintar(sala);
  }
  function tirar() {
    if (soloLectura || btnTirar.disabled) return;
    esperandoServidor = true; btnTirar.disabled = true;
    enviar({ type: 'sala_tirar', v: sala.v });
  }
  function moverA(m) {
    if (soloLectura || esperandoServidor || animando) return;
    esperandoServidor = true; seleccion = null; pintar(sala);
    enviar({ type: 'sala_mover', v: sala.v, ficha: m.ficha, dados: m.dados });
  }

  // ── Animación de la jugada que llegó (la ven todos igual) ──
  async function animarJugada(g, u, nuevo) {
    const quien = g.jugadores.find(j => j.id === u.jugadorId) || jugadorActual(g);
    const col = COLORES[quien.color];
    if (u.tipo === 'tirada') {
      resultado.replaceChildren(h('span', { class: 'rodando-texto' }, '🎲 …'));
      sonidos.dados(); vibrar(40);
      await dice.tirar(u.dados, ANIMACION.msDados);
      const par = esPar(u.dados);
      resultado.replaceChildren(h('span', { class: `suma ${par ? 'par' : ''}` }, `${u.dados[0]} + ${u.dados[1]} = ${u.dados[0] + u.dados[1]}`, par ? h('b', {}, ' ¡PAR!') : null));
      if (par) { sonidos.par(); dice.el.classList.add('brilla-par'); setTimeout(() => dice.el.classList.remove('brilla-par'), 1200); }
      for (const e of u.eventos || []) {
        if (e.tipo === 'salen') {
          sonidos.salir(); letrero(e.cuantas > 1 ? '¡SALEN DE LA CÁRCEL!' : '¡SALE DE LA CÁRCEL!', col.neon, 1000);
          const salen = g.fichas[quien.id].map((r, i) => ({ r, i })).filter(x => x.r === CARCEL && nuevo.fichas[quien.id][x.i] === 0);
          for (const x of salen) await board.animarSalida(quien.id, x.i);
        } else if (e.tipo === 'come') {
          await comida(g, e);
        } else if (e.tipo === 'otroIntento') { sonidos.fallo(); await esperar(300); }
        else if (e.tipo === 'noSale') { sonidos.fallo(); letrero(`¡${quien.nombre.toUpperCase()} NO SALIÓ! 😵`, col.neon, 1100); await esperar(700); }
        else if (e.tipo === 'tresPares') { letrero('¡TRES PARES SEGUIDOS! 🔥', col.neon, 1400); vibrar([100, 50, 100]); await esperar(900); }
        else if (e.tipo === 'subeAlCielo') { sonidos.cielo(); confeti(); }
        else if (e.tipo === 'sinMovimientos') { toast(`${quien.nombre} no tiene movimientos: pasa el turno`); await esperar(500); }
      }
    } else if (u.tipo === 'movimiento') {
      if (u.dados) dice.mostrar(u.dados);
      for (const t of u.tramos || []) {
        await board.animarTramo(quien.id, t.ficha, t.desde, t.hasta, ANIMACION.msPorCasilla, () => sonidos.paso());
        for (const e of (u.eventos || []).filter(x => x.tipo === 'come' && x.casilla === t.hasta)) await comida(g, e);
        if (t.hasta >= CIELO) {
          sonidos.cielo(); vibrar([80, 50, 80, 50, 200]);
          const p = board.puntoEnPantalla(quien.id, t.ficha);
          confeti(p ? p.x : undefined, p ? p.y : undefined);
          letrero('¡AL CIELO! ⭐', col.neon); await esperar(500);
        }
      }
    } else if (u.tipo === 'salto') {
      toast(`Se saltó el turno de ${quien.nombre}`);
    }
  }
  async function comida(g, e) {
    const v = g.jugadores.find(j => j.id === e.victima);
    sonidos.comer(); vibrar([200, 80, 200]);
    letrero(e.victima === yoId() ? '¡TE COMIERON!' : `¡SE COMIERON A ${v.nombre.toUpperCase()}!`, COLORES[v.color].neon);
    await board.animarALaCarcel(e.victima, e.ficha);
  }

  // ── Shots: todos ven el modal; confirma quien toma (o el anfitrión si esa persona se desconectó) ──
  // La CLAVE incluye tipo y persona: cuando quien comió elige, el mismo shot (mismo id) pasa de "elegir" a
  // "shot" de la persona elegida, y el modal tiene que cambiar en TODAS las pantallas sin refrescar.
  const claveShot = (sh) => `${sh.id}:${sh.tipo}:${sh.jugadorId || sh.por}`;
  function atenderShots(s) {
    const sh = s.shots[0];
    if (modalShot && (!sh || claveShot(sh) !== modalShotId)) { modalShot.cerrar(); modalShot = null; modalShotId = null; }
    if (!sh || modalShotId === claveShot(sh)) return;
    modalShotId = claveShot(sh);
    const g = s.game, host = s.anfitrion === yoId();
    if (sh.tipo === 'elegir') {
      const por = g.jugadores.find(j => j.id === sh.por);
      modalShot = abrirEleccion(por, g.jugadores.filter(j => j.id !== sh.por && !j.fuera), {
        puedeElegir: sh.por === yoId() || (host && !enLinea(sh.por)),
        alElegir: (id) => enviar({ type: 'sala_elegir', shotId: sh.id, jugadorId: id }) });
    } else {
      const quien = g.jugadores.find(j => j.id === sh.jugadorId);
      const propio = sh.jugadorId === yoId();
      const porOtro = !propio && host && !enLinea(sh.jugadorId);
      modalShot = abrirShot(sh, quien, {
        puedeConfirmar: propio || porOtro,
        textoBoton: porOtro ? `Confirmar por ${quien.nombre} (no está conectado)` : undefined,
        alConfirmar: () => enviar({ type: 'sala_shot_ok', shotId: sh.id }) });
    }
  }

  function finDePartida(s) {
    const g = s.game, ganador = g.jugadores.find(j => j.id === g.ganador) || g.jugadores[0];
    sonidos.victoria(); vibrar([200, 100, 200, 100, 400]);
    confeti(innerWidth / 2, innerHeight / 3, 160);
    setTimeout(() => confeti(innerWidth / 4, innerHeight / 2), 400);
    const c = COLORES[ganador.color];
    const modal = h('div', { class: 'modal-shot salas-raiz abierto modal-fin', role: 'dialog', 'aria-modal': 'true', style: { '--c': c.hex, '--cn': c.neon } },
      h('div', { class: 'modal-contenido' },
        h('div', { class: 'trofeo' }, '🏆'),
        h('h2', { class: 'shot-titulo' }, ganador.id === yoId() ? '¡GANASTE!' : `¡GANÓ ${ganador.nombre.toUpperCase()}!`),
        h('ol', { class: 'tabla-final' }, ...tabla(g).map(j => h('li', { style: { '--c': COLORES[j.color].hex, '--cn': COLORES[j.color].neon } },
          h('span', { class: 'ficha-mini' }), h('b', {}, j.nombre), h('span', {}, `🥃 x${j.shots}`)))),
        h('div', { class: 'fila-botones' }, ...entorno.botonesFin(s, () => modal.remove()))));
    document.body.append(modal);
  }

  return {
    el, recibir,
    desbloquear() { esperandoServidor = false; pintar(sala); },
    destruir() { vivo = false; if (modalShot) modalShot.cerrar(); document.querySelectorAll('.modal-fin').forEach(m => m.remove()); },
  };
}
