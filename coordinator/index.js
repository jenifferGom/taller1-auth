require('dotenv').config();

const http    = require('http');
const crypto  = require('crypto');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { URL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');

// ───────────────────────── configuración del servidor ─────────────────────────

const PORT           = parseInt(process.env.PORT, 10) || 5000;
const JWT_SECRET     = process.env.JWT_SECRET;
const COORDINATOR_ID = process.env.COORDINATOR_ID || `coord-${PORT}`;
const PUBLIC_URL     = process.env.PUBLIC_URL || `ws://localhost:${PORT}`;
const PEER_URL       = process.env.PEER_URL   || `ws://localhost:${PORT}/peer`;
const AUTH_URLS_RAW  = process.env.AUTH_URLS  || process.env.AUTH_SERVICE_URL || 'http://localhost:4000';
const AUTH_URLS      = AUTH_URLS_RAW.split(',').map(s => s.trim()).filter(Boolean);

// ───────────────────────── reglas del parqués (ajustables) ─────────────────────────

const COLORS        = ['yellow', 'blue', 'red', 'green'];
const TRACK_LEN     = 68;                 // casillas del recorrido común
const SIDE_LEN      = 17;                 // casillas por lado
const EXIT_OFFSET   = 5;                  // casilla de salida dentro de cada lado
const EXITS         = [0, 1, 2, 3].map(i => i * SIDE_LEN + EXIT_OFFSET);   // 5, 22, 39, 56
const TRACK_LAST    = TRACK_LEN - 1 - EXIT_OFFSET;                        // progreso 63 = última casilla común
const LANE_LEN      = 7;                  // pasillo final
const CROWN         = TRACK_LAST + LANE_LEN + 1;                          // progreso 71 = corona (meta)
// Seguros: las 4 salidas + una casilla a 12 pasos de cada salida
const SAFE_SQUARES  = new Set([...EXITS, ...EXITS.map(e => (e + 12) % TRACK_LEN)]);

const PIECES_PER_PLAYER = 4;
const MIN_PLAYERS       = 2;
const MAX_PLAYERS       = 4;
const CAPTURE_BONUS     = 20;   // pasos extra al capturar
const CROWN_BONUS       = 10;   // pasos extra al coronar
const PAIRS_LIMIT       = 3;    // 3 pares seguidos = la ficha más avanzada va a la cárcel
const JAIL_ROLLS        = 3;    // intentos por turno cuando todas las fichas están en la cárcel
// Para sacar una ficha de la cárcel se necesita un par; sacar una ficha consume ambos dados.

const TURN_MS        = 30000;   // tiempo por acción
const BOT_DELAY_MS   = 1200;    // jugada automática (jugador AFK o desconectado)
const ROOM_IDLE_MS   = 60000;   // sala sin nadie conectado
const FINISHED_TTL   = 10 * 60 * 1000;
const MAX_ROOMS      = 200;
const MAX_SPECTATORS = 100;

const CHAT_MAX_LEN      = 200;
const CHAT_HISTORY_SIZE = 50;
const CHAT_RATE_MS      = 1000;

const HEARTBEAT_INTERVAL_MS      = 2000;
const PEER_DISCOVERY_INTERVAL_MS = 3000;
const ROOMS_SYNC_INTERVAL_MS     = 2000;

if (!JWT_SECRET) { console.error('JWT_SECRET no definido'); process.exit(1); }

// ───────────────────────── estado ─────────────────────────

const rooms           = new Map();   // roomId -> room
const userRoom        = new Map();   // userId -> roomId
const clients         = new Map();   // userId -> { ws, username }
const spectators      = new Set();   // ws de espectadores
const peerConnections = new Map();   // coordinatorId -> ws
const knownPeers      = new Map();   // coordinatorId -> { publicUrl, peerUrl }
const remoteRooms     = new Map();   // coordinatorId -> { ts, rooms: [] }
const lobbyChat       = [];
const chatRateLimits  = new Map();
const seenChatIds     = new Set();

let chatMsgCtr = 0;
let roomCtr    = 0;

// ───────────────────────── utilidades ─────────────────────────

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function sendRaw(ws, raw) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(raw); }
function sendToUser(userId, payload) { sendJson(clients.get(userId)?.ws, payload); }
function cleanText(text, max) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);
}
function trackIndex(side, progress) {
  if (side == null || progress < 0 || progress > TRACK_LAST) return null;
  return (EXITS[side] + progress) % TRACK_LEN;
}
function getUserRoom(userId) {
  const id = userRoom.get(userId);
  return id ? rooms.get(id) : null;
}

// ───────────────────────── difusión ─────────────────────────

function broadcastRoom(room, payload) {
  const raw = JSON.stringify(payload);
  for (const p of room.players) sendRaw(clients.get(p.userId)?.ws, raw);
  for (const ws of room.spectators) sendRaw(ws, raw);
}
function broadcastLobby(payload) {
  const raw = JSON.stringify(payload);
  for (const c of clients.values()) sendRaw(c.ws, raw);
  for (const ws of spectators) sendRaw(ws, raw);
}
function broadcastToPeers(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of peerConnections.values()) sendRaw(ws, raw);
}

// Lista de jugadores en línea (requisito del taller): se envía a TODOS los conectados
// cada vez que alguien entra o sale, incluido el que acaba de conectarse.
function broadcastPlayers() {
  const players = Array.from(clients.entries()).map(([userId, c]) => ({ userId, username: c.username }));
  const raw = JSON.stringify({ type: 'players_update', players });
  for (const c of clients.values()) sendRaw(c.ws, raw);
  for (const ws of spectators) sendRaw(ws, raw);
}

// ───────────────────────── salas: resúmenes y vistas ─────────────────────────

function roomSummary(room) {
  return {
    id: room.id, name: room.name, status: room.status,
    players: room.players.filter(p => !p.left).length, maxPlayers: room.maxPlayers,
    coordinatorId: COORDINATOR_ID, publicUrl: PUBLIC_URL,
  };
}

function listRooms() {
  const list = Array.from(rooms.values()).map(roomSummary);
  for (const { rooms: rs } of remoteRooms.values()) list.push(...rs);
  return list;
}

function pieceState(progress) {
  if (progress < 0) return 'jail';
  if (progress >= CROWN) return 'crown';
  if (progress > TRACK_LAST) return 'lane';
  return 'track';
}

function roomView(room) {
  const t = room.turn;
  return {
    id: room.id, name: room.name, status: room.status,
    hostId: room.hostId, maxPlayers: room.maxPlayers, winner: room.winner,
    players: room.players.map((p, seat) => ({
      userId: p.userId, username: p.username, seat,
      side: p.side, color: p.side != null ? COLORS[p.side] : null,
      connected: p.connected, left: !!p.left, auto: !!p.auto,
      pieces: p.pieces.map(pc => ({
        id: pc.id, progress: pc.progress, state: pieceState(pc.progress),
        track: trackIndex(p.side, pc.progress),
      })),
    })),
    turn: t ? {
      playerIndex: t.index, userId: room.players[t.index]?.userId,
      phase: t.phase, dice: t.dice, isPair: t.isPair, pairsInRow: t.pairsInRow,
      pending: t.pending, deadline: t.deadline,
      legal: room.status === 'playing' && t.phase === 'move' ? availableMoves(room, t.index) : [],
    } : null,
  };
}

const BOARD_INFO = {
  trackLength: TRACK_LEN, exits: EXITS, safeSquares: Array.from(SAFE_SQUARES),
  trackLastProgress: TRACK_LAST, laneLength: LANE_LEN, crownProgress: CROWN,
  colors: COLORS, piecesPerPlayer: PIECES_PER_PLAYER,
  captureBonus: CAPTURE_BONUS, crownBonus: CROWN_BONUS,
};

// ───────────────────────── motor de reglas ─────────────────────────

function occupants(room, idx) {
  const res = [];
  room.players.forEach((pl, pi) => {
    if (pl.left) return;
    for (const pc of pl.pieces) if (trackIndex(pl.side, pc.progress) === idx) res.push({ pi, piece: pc });
  });
  return res;
}

// ¿Hay una barrera (2+ fichas de un mismo oponente) en la casilla?
function opponentBarrier(room, idx, pi) {
  const counts = new Map();
  for (const o of occupants(room, idx)) {
    if (o.pi === pi) continue;
    counts.set(o.pi, (counts.get(o.pi) || 0) + 1);
  }
  for (const n of counts.values()) if (n >= 2) return true;
  return false;
}

// Evalúa mover una ficha `steps` casillas. Devuelve null si es ilegal.
function evaluateMove(room, pi, piece, steps) {
  const pl = room.players[pi];
  if (piece.progress < 0 || piece.progress >= CROWN) return null;
  const target = piece.progress + steps;
  if (target > CROWN) return null;                      // hay que entrar a la corona con cuenta exacta

  for (let p = piece.progress + 1; p <= target; p++) {
    const idx = trackIndex(pl.side, p);
    if (idx !== null && opponentBarrier(room, idx, pi)) return null;   // las barreras no se pasan
  }

  if (target < CROWN) {
    const own = pl.pieces.filter(pc => pc !== piece && pc.progress === target).length;
    if (own >= 2) return null;                          // máximo 2 fichas propias por casilla
  }

  let capture = null;
  const idx = trackIndex(pl.side, target);
  if (idx !== null) {
    const opp = occupants(room, idx).filter(o => o.pi !== pi);
    if (opp.length) {
      if (SAFE_SQUARES.has(idx)) return null;           // no se puede caer en un seguro ocupado por un rival
      capture = opp[0];
    }
  }
  return { target, capture, crowns: target === CROWN };
}

// Evalúa sacar una ficha de la cárcel. Captura a los rivales sueltos en tu salida.
function evaluateExit(room, pi, piece) {
  const pl = room.players[pi];
  if (piece.progress !== -1) return null;
  if (pl.pieces.filter(pc => pc.progress === 0).length >= 2) return null;
  const idx = EXITS[pl.side];
  if (opponentBarrier(room, idx, pi)) return null;
  return { captures: occupants(room, idx).filter(o => o.pi !== pi) };
}

function useValue(t, use) {
  if (use === 'sum') {
    const a = t.pending.find(x => x.key === 'd1');
    const b = t.pending.find(x => x.key === 'd2');
    return a && b ? a.value + b.value : null;
  }
  const it = t.pending.find(x => x.key === use);
  return it ? it.value : null;
}

function consume(t, use) {
  const keys = use === 'sum' ? ['d1', 'd2'] : [use];
  t.pending = t.pending.filter(x => !keys.includes(x.key));
}

function addBonus(t, value) { t.pending.push({ key: `b${++t.bonusCtr}`, value }); }

function availableMoves(room, pi) {
  const t = room.turn, pl = room.players[pi], moves = [];
  if (!t || !pl) return moves;
  const uses = t.pending.map(x => x.key);
  if (useValue(t, 'sum') !== null) uses.push('sum');

  for (const use of uses) {
    const steps = useValue(t, use);
    for (const pc of pl.pieces) {
      if (evaluateMove(room, pi, pc, steps)) moves.push({ type: 'move', pieceId: pc.id, use, steps });
    }
  }
  if (t.isPair && useValue(t, 'sum') !== null) {
    for (const pc of pl.pieces) if (evaluateExit(room, pi, pc)) moves.push({ type: 'exit', pieceId: pc.id });
  }
  return moves;
}

function allStuckInJail(pl) {
  return pl.pieces.some(p => p.progress === -1) &&
         pl.pieces.every(p => p.progress === -1 || p.progress >= CROWN);
}

// ───────────────────────── flujo de turnos ─────────────────────────

function startGame(room) {
  const n = room.players.length;
  const sides = n === 2 ? [0, 2] : n === 3 ? [0, 1, 2] : [0, 1, 2, 3];
  room.players.forEach((pl, i) => {
    pl.side = sides[i];
    pl.pieces = Array.from({ length: PIECES_PER_PLAYER }, (_, id) => ({ id, progress: -1 }));
  });
  room.status = 'playing';
  room.turn = {
    index: crypto.randomInt(0, n), phase: 'roll', dice: null, isPair: false,
    pairsInRow: 0, jailRolls: 0, pending: [], bonusCtr: 0, deadline: null,
  };
  room.event = { kind: 'game_started' };
}

function endTurn(room) {
  const t = room.turn;
  t.pending = [];
  if (t.isPair) {                       // un par da turno extra
    t.isPair = false; t.phase = 'roll'; t.jailRolls = 0;
    return;
  }
  const n = room.players.length;
  let i = t.index;
  do { i = (i + 1) % n; } while (room.players[i].left);
  t.index = i; t.phase = 'roll'; t.dice = null;
  t.pairsInRow = 0; t.jailRolls = 0; t.isPair = false;
}

// Si no quedan jugadas legales termina el turno. Devuelve true si lo terminó.
function settle(room) {
  if (availableMoves(room, room.turn.index).length === 0) { endTurn(room); return true; }
  return false;
}

function finishGame(room, winnerIdx, reason) {
  room.status = 'finished';
  room.winner = room.players[winnerIdx]?.userId || null;
  room.turn.phase = 'over'; room.turn.pending = [];
  room.event = { kind: 'game_over', winner: room.winner, reason };
  clearTimeout(room.timer); room.timer = null;
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => deleteRoom(room), FINISHED_TTL);
}

function doRoll(room, pi) {
  if (room.status !== 'playing') return 'not_playing';
  const t = room.turn;
  if (t.index !== pi) return 'not_your_turn';
  if (t.phase !== 'roll') return 'already_rolled';
  const pl = room.players[pi];

  const d1 = crypto.randomInt(1, 7), d2 = crypto.randomInt(1, 7);
  t.dice = [d1, d2]; t.isPair = d1 === d2; t.pending = [];
  const ev = { kind: 'roll', userId: pl.userId, dice: [d1, d2], pair: t.isPair };
  room.event = ev;

  if (t.isPair) {
    t.pairsInRow++;
    if (t.pairsInRow >= PAIRS_LIMIT) {  // tres pares seguidos: castigo
      let victim = null;
      for (const pc of pl.pieces)
        if (pc.progress >= 0 && pc.progress < CROWN && (!victim || pc.progress > victim.progress)) victim = pc;
      if (victim) { victim.progress = -1; ev.penalty = victim.id; }
      t.isPair = false;
      endTurn(room);
      return null;
    }
  }

  if (allStuckInJail(pl) && !t.isPair) {
    t.jailRolls++;
    if (t.jailRolls < JAIL_ROLLS) { ev.retry = true; return null; }   // sigue en fase 'roll'
    endTurn(room);
    return null;
  }

  t.pending = [{ key: 'd1', value: d1 }, { key: 'd2', value: d2 }];
  t.phase = 'move';
  if (settle(room)) ev.noMoves = true;
  return null;
}

function checkMoveCommon(room, pi) {
  if (room.status !== 'playing') return 'not_playing';
  const t = room.turn;
  if (t.index !== pi) return 'not_your_turn';
  if (t.phase !== 'move') return 'roll_first';
  return null;
}

function doMove(room, pi, pieceId, use) {
  const bad = checkMoveCommon(room, pi);
  if (bad) return bad;
  const t = room.turn, pl = room.players[pi];
  const pc = pl.pieces[pieceId];
  if (!pc) return 'bad_piece';
  const steps = useValue(t, typeof use === 'string' ? use : '');
  if (steps === null) return 'bad_die';
  const ev = evaluateMove(room, pi, pc, steps);
  if (!ev) return 'illegal_move';

  consume(t, use);
  const from = pc.progress;
  pc.progress = ev.target;
  const out = { kind: 'move', userId: pl.userId, pieceId, from, to: ev.target, steps, captured: [] };

  if (ev.capture) {
    ev.capture.piece.progress = -1;
    out.captured.push({ userId: room.players[ev.capture.pi].userId, pieceId: ev.capture.piece.id });
    addBonus(t, CAPTURE_BONUS);
  }
  if (ev.crowns) { addBonus(t, CROWN_BONUS); out.crowned = true; }
  room.event = out;

  if (pl.pieces.every(p => p.progress === CROWN)) { finishGame(room, pi, 'crowned'); return null; }
  settle(room);
  return null;
}

function doExit(room, pi, pieceId) {
  const bad = checkMoveCommon(room, pi);
  if (bad) return bad;
  const t = room.turn, pl = room.players[pi];
  const pc = pl.pieces[pieceId];
  if (!pc || pc.progress !== -1) return 'bad_piece';
  if (!t.isPair || useValue(t, 'sum') === null) return 'need_pair';
  const ev = evaluateExit(room, pi, pc);
  if (!ev) return 'illegal_move';

  consume(t, 'sum');
  pc.progress = 0;
  const out = { kind: 'exit', userId: pl.userId, pieceId, captured: [] };
  for (const c of ev.captures) {
    c.piece.progress = -1;
    out.captured.push({ userId: room.players[c.pi].userId, pieceId: c.piece.id });
    addBonus(t, CAPTURE_BONUS);
  }
  room.event = out;
  settle(room);
  return null;
}

// ───────────────────────── temporizador y jugada automática ─────────────────────────

function pickAutoMove(room, pi, moves) {
  let best = null, bestScore = -Infinity;
  for (const m of moves) {
    const pc = room.players[pi].pieces[m.pieceId];
    let score;
    if (m.type === 'exit') score = 60;
    else {
      const ev = evaluateMove(room, pi, pc, m.steps);
      score = pc.progress + m.steps + (ev.capture ? 100 : 0) + (ev.crowns ? 80 : 0);
    }
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

function autoPlay(room) {
  if (room.status !== 'playing') return;
  const t = room.turn, pi = t.index, pl = room.players[pi];
  pl.auto = true;
  if (t.phase === 'roll') doRoll(room, pi);
  else {
    const moves = availableMoves(room, pi);
    if (!moves.length) endTurn(room);
    else {
      const m = pickAutoMove(room, pi, moves);
      if (m.type === 'exit') doExit(room, pi, m.pieceId); else doMove(room, pi, m.pieceId, m.use);
    }
  }
  publish(room);
}

function scheduleTurn(room) {
  clearTimeout(room.timer); room.timer = null;
  if (room.status !== 'playing') { if (room.turn) room.turn.deadline = null; return; }
  const t = room.turn, pl = room.players[t.index];
  // Sala en pausa si no hay ningún humano conectado
  if (!room.players.some(p => !p.left && p.connected)) { t.deadline = null; return; }
  const bot   = !pl.connected || pl.auto;
  const delay = bot ? BOT_DELAY_MS : TURN_MS;
  t.deadline  = bot ? null : Date.now() + delay;
  room.timer  = setTimeout(() => autoPlay(room), delay);
}

function refreshCleanup(room) {
  if (room.status === 'finished') return;
  const anyone = room.players.some(p => !p.left && p.connected);
  if (anyone) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
  else if (!room.cleanupTimer) room.cleanupTimer = setTimeout(() => deleteRoom(room), ROOM_IDLE_MS);
}

function publish(room) {
  scheduleTurn(room);
  refreshCleanup(room);
  broadcastRoom(room, { type: 'room_state', room: roomView(room), event: room.event || null });
  room.event = null;
}

// ───────────────────────── gestión de salas ─────────────────────────

function createRoom(userId, username, name, maxPlayers) {
  const room = {
    id: `${COORDINATOR_ID}-r${++roomCtr}`,
    name: cleanText(name, 30) || `Mesa de ${username}`,
    hostId: userId,
    maxPlayers: Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, parseInt(maxPlayers, 10) || MAX_PLAYERS)),
    status: 'waiting', players: [], spectators: new Set(), chat: [],
    turn: null, winner: null, event: null, timer: null, cleanupTimer: null,
  };
  rooms.set(room.id, room);
  return room;
}

function addPlayerToRoom(room, userId, username) {
  room.players.push({ userId, username, side: null, pieces: [], connected: true, auto: false, left: false });
  userRoom.set(userId, room.id);
}

function deleteRoom(room) {
  clearTimeout(room.timer); clearTimeout(room.cleanupTimer);
  for (const p of room.players) if (userRoom.get(p.userId) === room.id) {
    userRoom.delete(p.userId);
    sendToUser(p.userId, { type: 'room_closed', roomId: room.id });
  }
  for (const ws of room.spectators) { sendJson(ws, { type: 'room_closed', roomId: room.id }); ws.watching = null; }
  rooms.delete(room.id);
}

function leaveRoom(userId) {
  const room = getUserRoom(userId);
  if (!room) return;
  userRoom.delete(userId);
  const idx = room.players.findIndex(p => p.userId === userId);
  if (idx < 0) return;

  if (room.status === 'playing') {
    const pl = room.players[idx];
    pl.left = true; pl.connected = false;
    pl.pieces.forEach(pc => { pc.progress = -1; });
    room.event = { kind: 'left', userId };
    const active = room.players.filter(p => !p.left);
    if (active.length <= 1) finishGame(room, room.players.indexOf(active[0]), 'forfeit');
    else if (room.turn.index === idx) { room.turn.isPair = false; endTurn(room); }
    publish(room);
  } else {
    room.players.splice(idx, 1);
    if (!room.players.length) { deleteRoom(room); return; }
    if (room.hostId === userId) room.hostId = room.players[0].userId;
    publish(room);
  }
}

// ───────────────────────── chat ─────────────────────────

function pushHistory(list, msg) {
  list.push(msg);
  if (list.length > CHAT_HISTORY_SIZE) list.shift();
}

function handleChat(userId, text, scope) {
  const now = Date.now();
  if (now - (chatRateLimits.get(userId) || 0) < CHAT_RATE_MS) return;
  chatRateLimits.set(userId, now);
  text = cleanText(text, CHAT_MAX_LEN);
  if (!text) return;
  const username = clients.get(userId)?.username || 'Unknown';
  const msg = { id: `${COORDINATOR_ID}-${++chatMsgCtr}`, userId, username, text, ts: now };

  const room = getUserRoom(userId);
  if (scope !== 'lobby' && room) {
    pushHistory(room.chat, msg);
    broadcastRoom(room, { type: 'chat', scope: 'room', roomId: room.id, msg });
    return;
  }
  seenChatIds.add(msg.id);
  pushHistory(lobbyChat, msg);
  broadcastLobby({ type: 'chat', scope: 'lobby', msg });
  broadcastToPeers({ type: 'chat_replicate', origin: COORDINATOR_ID, msg });
}

// ───────────────────────── mensajes del cliente ─────────────────────────

function handleClientMessage(userId, msg) {
  const username = clients.get(userId)?.username;

  switch (msg.type) {
    case 'list_rooms':
      sendToUser(userId, { type: 'rooms_list', rooms: listRooms() });
      return null;

    case 'create_room': {
      if (getUserRoom(userId)) return 'already_in_room';
      if (rooms.size >= MAX_ROOMS) return 'server_full';
      const room = createRoom(userId, username, msg.name, msg.maxPlayers);
      addPlayerToRoom(room, userId, username);
      publish(room);
      return null;
    }

    case 'join_room': {
      if (getUserRoom(userId)) return 'already_in_room';
      const room = rooms.get(msg.roomId);
      if (!room) {
        for (const [cid, { rooms: rs }] of remoteRooms) {
          const r = rs.find(x => x.id === msg.roomId);
          if (r) { sendToUser(userId, { type: 'redirect', roomId: r.id, coordinatorId: cid, publicUrl: r.publicUrl }); return null; }
        }
        return 'room_not_found';
      }
      if (room.status !== 'waiting') return 'game_in_progress';
      if (room.players.length >= room.maxPlayers) return 'room_full';
      addPlayerToRoom(room, userId, username);
      sendToUser(userId, { type: 'chat_history', scope: 'room', roomId: room.id, messages: room.chat.slice(-20) });
      publish(room);
      return null;
    }

    case 'leave_room':
      if (!getUserRoom(userId)) return 'not_in_room';
      leaveRoom(userId);
      sendToUser(userId, { type: 'left_room' });
      return null;

    case 'start_game': {
      const room = getUserRoom(userId);
      if (!room) return 'not_in_room';
      if (room.hostId !== userId) return 'not_host';
      if (room.status !== 'waiting') return 'already_started';
      if (room.players.length < MIN_PLAYERS) return 'not_enough_players';
      startGame(room);
      publish(room);
      return null;
    }

    case 'roll_dice':
    case 'move_piece':
    case 'exit_jail': {
      const room = getUserRoom(userId);
      if (!room) return 'not_in_room';
      const pi = room.players.findIndex(p => p.userId === userId);
      room.players[pi].auto = false;
      let err;
      if (msg.type === 'roll_dice') err = doRoll(room, pi);
      else if (msg.type === 'move_piece') err = doMove(room, pi, Number(msg.pieceId), msg.use);
      else err = doExit(room, pi, Number(msg.pieceId));
      if (!err) publish(room);
      return err;
    }

    case 'chat_message':
      handleChat(userId, msg.text, msg.scope);
      return null;

    default:
      return 'unknown_type';
  }
}

// ───────────────────────── autenticación JWT ─────────────────────────

function verifyUpgradeToken(req) {
  const url   = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) throw new Error('Token no proporcionado');
  const decoded = jwt.verify(token, JWT_SECRET);
  if (!decoded?.userId || !decoded?.username) throw new Error('JWT inválido');
  return { userId: decoded.userId, username: decoded.username };
}

function rejectUpgrade(socket, code = 401, msg = 'Unauthorized') {
  socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// ───────────────────────── servidor HTTP + WS ─────────────────────────

const app = express();
app.use(express.json());
app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

const server       = http.createServer(app);
const wssPublic    = new WebSocketServer({ noServer: true });
const wssPeer      = new WebSocketServer({ noServer: true });
const wssSpectator = new WebSocketServer({ noServer: true });

app.get('/health', (_req, res) => res.json({ status: 'ok', coordinatorId: COORDINATOR_ID, uptime: process.uptime() }));

app.get('/rooms', (_req, res) => res.json({ rooms: listRooms() }));

app.get('/status', (_req, res) => res.json({
  coordinatorId: COORDINATOR_ID, connectedPlayers: clients.size,
  localRooms: rooms.size, spectators: spectators.size,
  peers: Array.from(peerConnections.keys()),
  rooms: Array.from(rooms.values()).map(roomSummary),
}));

server.on('upgrade', (req, socket, head) => {
  try {
    const path = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (path === '/connect') {
      // El JWT se verifica ANTES de admitir la conexión. Si falla (vencido, malformado o
      // firmado con otra clave) se completa el handshake solo para cerrar el socket con
      // código 4001 "invalid token": un 401 HTTP no le llega al navegador como código de cierre.
      let user = null;
      try { user = verifyUpgradeToken(req); } catch (_) {}
      wssPublic.handleUpgrade(req, socket, head, (ws) => {
        if (!user) { ws.close(4001, 'invalid token'); return; }
        wssPublic.emit('connection', ws, req, user);
      });
    } else if (path === '/peer') {
      wssPeer.handleUpgrade(req, socket, head, (ws) => wssPeer.emit('connection', ws, req));
    } else if (path === '/spectate') {
      if (spectators.size >= MAX_SPECTATORS) { rejectUpgrade(socket, 503, 'Full'); return; }
      wssSpectator.handleUpgrade(req, socket, head, (ws) => wssSpectator.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  } catch (_err) {
    rejectUpgrade(socket);
  }
});

// ───────────────────────── jugadores ─────────────────────────

wssPublic.on('connection', (ws, _req, user) => {
  const { userId, username } = user;

  const prev = clients.get(userId);
  if (prev && prev.ws !== ws && prev.ws.readyState === WebSocket.OPEN) prev.ws.close(4000, 'Nueva conexión');
  clients.set(userId, { ws, username, connectedAt: Date.now() });
  console.log(`[+] ${username} conectado`);

  // Reconexión a una sala existente
  const room = getUserRoom(userId);
  if (room) {
    const pl = room.players.find(p => p.userId === userId);
    if (pl) { pl.connected = true; pl.auto = false; }
  } else {
    userRoom.delete(userId);
  }

  sendJson(ws, {
    type: 'welcome',
    you: { userId, username },
    board: BOARD_INFO,
    rules: { turnMs: TURN_MS, pairsLimit: PAIRS_LIMIT, jailRolls: JAIL_ROLLS },
    rooms: listRooms(),
    chatHistory: lobbyChat.slice(-20),
    roomId: room?.id || null,
  });

  if (room) {
    sendJson(ws, { type: 'chat_history', scope: 'room', roomId: room.id, messages: room.chat.slice(-20) });
    publish(room);
  }
  broadcastPlayers();

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
    if (!isPlainObject(msg)) return;
    const err = handleClientMessage(userId, msg);
    if (err) sendJson(ws, { type: 'error', code: err, ref: msg.type });
  });

  ws.on('close', () => {
    if (clients.get(userId)?.ws !== ws) return;     // ya fue reemplazada por otra conexión
    console.log(`[-] ${username} desconectado`);
    clients.delete(userId);          // se elimina del Map ANTES de hacer broadcast
    chatRateLimits.delete(userId);
    broadcastPlayers();
    const r = getUserRoom(userId);
    if (!r) return;
    if (r.status === 'playing') {
      const pl = r.players.find(p => p.userId === userId);
      if (pl) pl.connected = false;
      publish(r);
    } else {
      leaveRoom(userId);
    }
  });

  ws.on('error', (err) => console.error(`[WS] error ${username}:`, err.message));
});

// ───────────────────────── espectadores ─────────────────────────

wssSpectator.on('connection', (ws) => {
  spectators.add(ws);
  ws.watching = null;
  sendJson(ws, { type: 'spectator_welcome', board: BOARD_INFO, rooms: listRooms(), chatHistory: lobbyChat.slice(-20) });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
    if (!isPlainObject(msg)) return;

    if (ws.watching && (msg.type === 'unwatch_room' || msg.type === 'watch_room')) {
      rooms.get(ws.watching)?.spectators.delete(ws);
      ws.watching = null;
    }
    if (msg.type === 'watch_room') {
      const room = rooms.get(msg.roomId);
      if (room) {
        room.spectators.add(ws); ws.watching = room.id;
        sendJson(ws, { type: 'room_state', room: roomView(room), event: null });
        sendJson(ws, { type: 'chat_history', scope: 'room', roomId: room.id, messages: room.chat.slice(-20) });
      } else {
        for (const [cid, { rooms: rs }] of remoteRooms) {
          const r = rs.find(x => x.id === msg.roomId);
          if (r) { sendJson(ws, { type: 'redirect', roomId: r.id, coordinatorId: cid, publicUrl: r.publicUrl }); return; }
        }
        sendJson(ws, { type: 'error', code: 'room_not_found', ref: 'watch_room' });
      }
    }
  });

  const drop = () => {
    spectators.delete(ws);
    if (ws.watching) rooms.get(ws.watching)?.spectators.delete(ws);
  };
  ws.on('close', drop);
  ws.on('error', drop);
});

// ───────────────────────── malla entre coordinadores ─────────────────────────
// Cada sala vive en un único coordinador (su dueño). Los coordinadores solo se
// intercambian: el listado de salas (rooms_sync) y el chat del lobby (chat_replicate).
// Si un jugador quiere entrar a una sala ajena, recibe un mensaje `redirect`.

function sendRoomsSync(ws) {
  sendJson(ws, { type: 'rooms_sync', origin: COORDINATOR_ID, rooms: Array.from(rooms.values()).map(roomSummary) });
}

function handlePeerMessage(data, senderId) {
  let msg;
  try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
  if (!isPlainObject(msg) || msg.origin === COORDINATOR_ID) return;

  switch (msg.type) {
    case 'rooms_sync': {
      if (!Array.isArray(msg.rooms)) break;
      const fallbackUrl = knownPeers.get(senderId)?.publicUrl;
      remoteRooms.set(senderId, {
        ts: Date.now(),
        rooms: msg.rooms.slice(0, MAX_ROOMS).map(r => ({
          id: String(r.id), name: String(r.name).slice(0, 30), status: r.status,
          players: Number(r.players) || 0, maxPlayers: Number(r.maxPlayers) || MAX_PLAYERS,
          coordinatorId: senderId, publicUrl: r.publicUrl || fallbackUrl,
        })),
      });
      break;
    }
    case 'chat_replicate': {
      const m = msg.msg;
      if (!m?.id || seenChatIds.has(m.id)) break;
      seenChatIds.add(m.id);
      if (seenChatIds.size > 2000) {
        const it = seenChatIds.values();
        for (let i = 0; i < 500; i++) seenChatIds.delete(it.next().value);
      }
      pushHistory(lobbyChat, m);
      broadcastLobby({ type: 'chat', scope: 'lobby', msg: m });
      break;
    }
  }
}

wssPeer.on('connection', (ws) => {
  let remoteId = null;
  ws.on('message', (data) => {
    if (!remoteId) {
      let msg;
      try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { ws.close(); return; }
      if (msg.type !== 'hello' || !msg.coordinatorId) { ws.close(); return; }
      remoteId = msg.coordinatorId;
      if (remoteId > COORDINATOR_ID && peerConnections.has(remoteId)) { ws.close(); return; }
      peerConnections.set(remoteId, ws);
      console.log(`[MESH] conectado: ${remoteId} (${peerConnections.size} peers)`);
      sendJson(ws, { type: 'hello', coordinatorId: COORDINATOR_ID });
      sendRoomsSync(ws);
      return;
    }
    handlePeerMessage(data, remoteId);
  });
  ws.on('close', () => {
    if (remoteId && peerConnections.get(remoteId) === ws) {
      peerConnections.delete(remoteId);
      remoteRooms.delete(remoteId);
      console.log(`[MESH] desconectado: ${remoteId}`);
    }
  });
  ws.on('error', () => {});
});

function connectToPeer(peerId, peerUrlStr) {
  if (peerConnections.has(peerId)) return;
  console.log(`[MESH] conectando a ${peerId}...`);
  const ws = new WebSocket(peerUrlStr);
  let done = false;
  ws.on('open', () => sendJson(ws, { type: 'hello', coordinatorId: COORDINATOR_ID }));
  ws.on('message', (data) => {
    if (!done) {
      let msg;
      try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
      if (msg.type === 'hello') {
        done = true;
        peerConnections.set(peerId, ws);
        console.log(`[MESH] conectado: ${peerId} (${peerConnections.size} peers)`);
        sendRoomsSync(ws);
      }
      return;
    }
    handlePeerMessage(data, peerId);
  });
  ws.on('close', () => {
    if (peerConnections.get(peerId) === ws) { peerConnections.delete(peerId); remoteRooms.delete(peerId); }
  });
  ws.on('error', (err) => console.error(`[MESH] error ${peerId}:`, err.message));
}

async function discoverPeers() {
  for (const authUrl of AUTH_URLS) {
    try {
      const res = await fetch(`${authUrl}/coordinator-peers`);
      if (!res.ok) {
        if (res.status === 503) {
          const body = await res.json().catch(() => ({}));
          if (body.leaderUrl) {
            const r2 = await fetch(`${body.leaderUrl}/coordinator-peers`).catch(() => null);
            if (r2?.ok) { _processPeers((await r2.json()).peers || []); return; }
          }
        }
        continue;
      }
      _processPeers((await res.json()).peers || []);
      return;
    } catch (_) {}
  }
}

function _processPeers(peers) {
  for (const peer of peers) {
    if (peer.coordinatorId === COORDINATOR_ID) continue;
    knownPeers.set(peer.coordinatorId, { publicUrl: peer.publicUrl, peerUrl: peer.peerUrl });
    if (!peerConnections.has(peer.coordinatorId) && COORDINATOR_ID < peer.coordinatorId)
      connectToPeer(peer.coordinatorId, peer.peerUrl);
  }
}

// ───────────────────────── latido hacia el servicio de autenticación ─────────────────────────

let _knownLeaderUrl = null;

async function sendHeartbeat() {
  const body    = JSON.stringify({ coordinatorId: COORDINATOR_ID, publicUrl: PUBLIC_URL, peerUrl: PEER_URL, connectedPlayers: clients.size, rooms: rooms.size, uptime: process.uptime() });
  const headers = { 'Content-Type': 'application/json' };
  const targets = _knownLeaderUrl ? [_knownLeaderUrl, ...AUTH_URLS.filter(u => u !== _knownLeaderUrl)] : AUTH_URLS;

  for (const authUrl of targets) {
    try {
      const res = await fetch(`${authUrl}/heartbeat`, { method: 'POST', headers, body });
      if (res.ok) { _knownLeaderUrl = authUrl; return; }
      if (res.status === 503) {
        const data = await res.json().catch(() => ({}));
        if (data.leaderUrl) {
          const r2 = await fetch(`${data.leaderUrl}/heartbeat`, { method: 'POST', headers, body }).catch(() => null);
          if (r2?.ok) { _knownLeaderUrl = data.leaderUrl; return; }
        }
      }
    } catch (_) {}
  }
  console.warn('[HEARTBEAT] Sin auth leader disponible');
}

// ───────────────────────── tareas periódicas ─────────────────────────

function lobbyTick() {
  // Quita listados de coordinadores que dejaron de sincronizar
  const now = Date.now();
  for (const [cid, v] of remoteRooms) if (now - v.ts > 8000) remoteRooms.delete(cid);

  broadcastToPeers({ type: 'rooms_sync', origin: COORDINATOR_ID, rooms: Array.from(rooms.values()).map(roomSummary) });

  // Lista de salas para quien está en el lobby (no en una sala) y para espectadores
  const raw = JSON.stringify({ type: 'rooms_list', rooms: listRooms() });
  for (const [userId, c] of clients) if (!userRoom.has(userId)) sendRaw(c.ws, raw);
  for (const ws of spectators) if (!ws.watching) sendRaw(ws, raw);
}

// ───────────────────────── arranque ─────────────────────────

setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
setInterval(discoverPeers, PEER_DISCOVERY_INTERVAL_MS);
setInterval(lobbyTick, ROOMS_SYNC_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`\nCOORDINADOR PARQUÉS [${COORDINATOR_ID}] | ${PUBLIC_URL} | auth: ${AUTH_URLS.join(', ')}`);
});