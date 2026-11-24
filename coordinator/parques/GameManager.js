// ─────────────────────────────────────────────────────────────
// Guaro Royal · Parqués · GameManager (una partida por sala)
// ─────────────────────────────────────────────────────────────
// Recibe una COPIA de la sala y una acción ya identificada (userId del JWT) y devuelve
// { sala } con el estado nuevo, o { error: { code, message } }. No envía mensajes ni sabe quién es
// el dueño: eso es de RoomManager. El azar entra por ctx (los dados los tira el servidor).
//
// Acciones: empezar · tirar · mover · shot_ok · elegir · saltar · revancha
// ctx = { tirarDados(): [d1, d2], azar(n): entero 0..n-1, enLinea(userId): boolean, minJugadores }
const R = require('./GameRules');

const err = (code, message) => ({ error: { code, message } });
const activos = (sala) => sala.jugadores.filter(j => !j.fuera);

/** ¿Qué puede hacer ahora el jugador de turno? (lo calcula el servidor; el navegador solo lo dibuja) */
function jugadasPara(sala, userId) {
  if (!sala || sala.estado !== 'jugando' || !sala.game || sala.shots.length) return [];
  if (R.jugadorActual(sala.game).id !== userId || sala.game.fase !== 'mover') return [];
  return R.getValidMoves(sala.game).map(({ ficha, dados, pasos, desde, hasta, come, alCielo }) => ({ ficha, dados, pasos, desde, hasta, come, alCielo }));
}

/** Arranca la partida con los jugadores activos (colores por orden de llegada, primer turno al azar) */
function iniciar(s, ctx) {
  const js = activos(s);
  s.jugadores = js.map(j => ({ ...j }));
  // Con solo 2 jugadores siempre quedan en diagonal (esquinas opuestas del tablero)
  if (js.length === 2 && (js[0].color + 2) % 4 !== js[1].color) {
    js[1] = { ...js[1], color: (js[0].color + 2) % 4 };
    s.jugadores[1].color = js[1].color;
  }
  s.game = R.crearPartida(js.map(({ id, nombre, color, agua }) => ({ id, nombre, color, agua: !!agua })),
    { nivel: s.nivel, primero: ctx.azar(js.length), reglas: s.reglas });
  s.estado = 'jugando'; s.shots = []; s.empiezaEn = null;
  s.seq++; s.ultimo = { seq: s.seq, tipo: 'inicio', jugadorId: R.jugadorActual(s.game).id };
  console.log(`[parques] ${s.codigo}: empieza la partida (${js.map(j => j.nombre).join(', ')}), nivel ${s.nivel}`);
  return s;
}

function aplicar(s, accion, ctx) {
  const yo = accion.userId;
  const soyHost = yo === s.anfitrion;
  const miembro = s.jugadores.some(j => j.id === yo && !j.fuera);

  switch (accion.tipo) {
    case 'empezar': {
      if (s.tipo !== 'privada') return err('empieza_sola', 'La partida pública empieza sola al terminar la cuenta');
      if (!soyHost) return err('solo_anfitrion', 'Solo el anfitrión puede empezar');
      if (s.estado !== 'espera') return err('sala_en_juego', 'La partida ya empezó');
      const js = activos(s);
      if (js.length < ctx.minJugadores) return err('faltan_jugadores', `Hacen falta al menos ${ctx.minJugadores} jugadores`);
      if (!js.every(j => j.listo)) return err('no_todos_listos', 'Todavía hay jugadores que no están listos');
      return { sala: iniciar(s, ctx) };
    }

    case 'tirar': {
      const e = turnoValido(s, yo, 'tirar'); if (e) return e;
      const dados = ctx.tirarDados();                    // azar del SERVIDOR: el navegador nunca manda dados
      const r = R.aplicarTirada(s.game, dados);
      return { sala: tras(s, r, { tipo: 'tirada', dados }, ctx) };
    }

    case 'mover': {
      const e = turnoValido(s, yo, 'mover'); if (e) return e;
      const pedidos = Array.isArray(accion.dados) ? accion.dados.join(',') : '';
      const mov = R.getValidMoves(s.game).find(x => x.ficha === accion.ficha && x.dados.join(',') === pedidos);
      if (!mov) return err('movimiento_invalido', 'Ese movimiento no se puede hacer');
      const dados = s.game.dados;
      const r = R.aplicarMovimiento(s.game, mov);
      return { sala: tras(s, r, { tipo: 'movimiento', dados, mov: { ficha: mov.ficha, dados: mov.dados } }, ctx) };
    }

    case 'shot_ok': {
      const sh = s.shots[0];
      if (!sh || sh.tipo !== 'shot' || sh.id !== accion.shotId) return err('shot_no_vigente', 'Ese shot ya se confirmó');
      if (yo !== sh.jugadorId && !(soyHost && !ctx.enLinea(sh.jugadorId))) return err('no_es_tu_shot', 'Solo quien toma confirma el shot');
      s.shots.shift();
      s.game = { ...s.game, jugadores: s.game.jugadores.map(j => (j.id === sh.jugadorId ? { ...j, shots: j.shots + sh.cantidad } : j)) };
      return { sala: normalizar(s) };
    }

    case 'elegir': {
      const sh = s.shots[0];
      if (!sh || sh.tipo !== 'elegir' || sh.id !== accion.shotId) return err('shot_no_vigente', 'Esa elección ya se hizo');
      if (yo !== sh.por && !(soyHost && !ctx.enLinea(sh.por))) return err('no_te_toca_elegir', 'Elige quien se comió la ficha');
      const victima = s.game.jugadores.find(j => j.id === accion.jugadorId && j.id !== sh.por && !j.fuera);
      if (!victima) return err('eleccion_invalida', 'Elige a otro jugador de la partida');
      const por = s.game.jugadores.find(j => j.id === sh.por);
      s.shots[0] = conModo({ id: sh.id, tipo: 'shot', jugadorId: victima.id, cantidad: sh.cantidad, razon: 'comes', datos: { por: por.nombre } }, s, ctx);
      return { sala: s };
    }

    case 'saltar': {                                    // el anfitrión destraba la partida si el de turno no está
      if (!soyHost) return err('solo_anfitrion', 'Solo el anfitrión puede saltar el turno');
      if (s.estado !== 'jugando') return err('sin_partida', 'No hay partida en curso');
      const actual = R.jugadorActual(s.game);
      if (ctx.enLinea(actual.id)) return err('jugador_en_linea', `${actual.nombre} está conectado: espera su jugada`);
      s.game = R.saltarTurno(s.game);
      s.seq++; s.ultimo = { seq: s.seq, tipo: 'salto', jugadorId: actual.id };
      return { sala: normalizar(s) };
    }

    case 'revancha': {
      if (s.tipo !== 'privada') return err('solo_privada', 'La revancha es para salas privadas: busca otra partida pública');
      if (!soyHost) return err('solo_anfitrion', 'Solo el anfitrión puede pedir revancha');
      if (s.estado !== 'fin') return err('sin_terminar', 'La partida no ha terminado');
      s.jugadores = activos(s).map(j => ({ ...j, listo: false }));
      s.estado = 'espera'; s.game = null; s.shots = []; s.seq++; s.ultimo = { seq: s.seq, tipo: 'revancha' };
      return { sala: s };
    }

    default:
      if (!miembro) return err('no_estas_en_la_sala', 'No estás en esa sala');
      return err('accion_desconocida', `Acción desconocida: ${accion.tipo}`);
  }
}

function turnoValido(s, yo, fase) {
  if (s.estado !== 'jugando' || !s.game) return err('sin_partida', 'No hay partida en curso');
  if (!s.jugadores.some(j => j.id === yo && !j.fuera)) return err('no_estas_en_la_sala', 'No estás en esa partida');
  if (s.shots.length) return err('shot_pendiente', 'Primero hay que tomarse el shot 🥃');
  if (R.jugadorActual(s.game).id !== yo) return err('no_es_tu_turno', `Es el turno de ${R.jugadorActual(s.game).nombre}`);
  if (s.game.fase !== fase) return err('fase_incorrecta', fase === 'tirar' ? 'Primero mueve tus fichas' : 'Primero tira los dados');
  return null;
}

/** Modo Agua: el shot de un jugador con agua se cambia por agua o por un reto (lo elige el servidor) */
function conModo(shot, s, ctx) {
  const j = s.game.jugadores.find(x => x.id === shot.jugadorId);
  if (!j || !j.agua) return { ...shot, modo: 'guaro' };
  if (ctx.azar(2) === 0) return { ...shot, modo: 'reto', reto: R.RETOS[ctx.azar(R.RETOS.length)] };
  return { ...shot, modo: 'agua' };
}

/** Guarda el resultado de una jugada: estado nuevo, shots en cola y "ultimo" (para que todos animen lo mismo) */
function tras(s, r, extra, ctx) {
  const yo = R.jugadorActual(s.game).id;
  s.game = r.game;
  for (const o of R.checkShotEvents(r.eventos, r.game)) {
    const id = s.sigShot++;
    s.shots.push(o.tipo === 'shot' ? conModo({ ...o, id }, s, ctx) : { ...o, id });
  }
  s.seq++;
  s.ultimo = { seq: s.seq, jugadorId: yo, eventos: r.eventos, tramos: r.tramos || [], ...extra };
  if (r.game.fase === 'fin') s.estado = 'fin';
  return normalizar(s);
}

/** Deja la sala consistente si alguien se fue: se descartan sus shots, se salta su turno y, si queda uno, gana */
function normalizar(s) {
  if (!s.game || s.estado !== 'jugando') return s;
  const fuera = new Set(s.jugadores.filter(j => j.fuera).map(j => j.id));
  if (!fuera.size) return s;
  // Quien se fue: sus fichas vuelven a su casa (la interfaz las pinta grises) y ya no estorban en el tablero
  const fichas = { ...s.game.fichas };
  for (const id of fuera) if (fichas[id]) fichas[id] = fichas[id].map(() => R.CARCEL);
  s.game = { ...s.game, fichas, jugadores: s.game.jugadores.map(j => (fuera.has(j.id) ? { ...j, fuera: true } : j)) };
  s.shots = s.shots.filter(o => !fuera.has(o.tipo === 'elegir' ? o.por : o.jugadorId));
  const quedan = s.game.jugadores.filter(j => !j.fuera);
  if (quedan.length < 2) {
    s.game = { ...s.game, fase: 'fin', ganador: quedan[0] ? quedan[0].id : null, perdedor: null };
    s.estado = 'fin'; s.shots = [];
    s.seq++; s.ultimo = { seq: s.seq, tipo: 'abandono', jugadorId: s.game.ganador };
    return s;
  }
  if (fuera.has(R.jugadorActual(s.game).id)) s.game = R.saltarTurno(s.game);
  return s;
}

module.exports = { aplicar, iniciar, normalizar, jugadasPara, activos };