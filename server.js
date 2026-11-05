'use strict';
// =====================================================
//  저스트 원 (Just One) - 실시간 협동 단어 게임 서버
// =====================================================
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { NORMAL_WORDS, EASY_TOPICS } = require('./words');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const TOTAL_ROUNDS = 13;
const REVIEW_SECONDS = 12;
const CLUE_TIMES = [10, 15, 20, 30, 60];
const CHAR_COUNT = 8;
const EMOJIS = ['laugh', 'cry', 'angry', 'speechless', 'surprised'];
const HOST_HANDOFF_MS = 30 * 1000;          // 방장이 30초 이상 끊기면 방장 넘김
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;     // 아무도 없는 방은 3시간 뒤 삭제

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

const rooms = new Map();

// ---------------- 유틸 ----------------
const newId = () => crypto.randomBytes(8).toString('hex');
const norm = (s) => String(s || '').replace(/\s+/g, '');
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

// 힌트 검사: 한글 단어만, 정답/정답 일부/합성어 금지
function validateClue(raw, word) {
  const t = String(raw || '').trim();
  const w = norm(word);
  if (!t) return '힌트를 입력해 주세요.';
  if (/\s/.test(t)) return '띄어쓰기 없이 한 단어로 적어 주세요.';
  if (t.length > 12) return '힌트는 12글자까지 쓸 수 있어요.';
  if (/[a-zA-Zａ-ｚＡ-Ｚ]/.test(t)) return '영어는 쓸 수 없어요.';
  if (/[0-9０-９]/.test(t)) return '숫자는 쓸 수 없어요.';
  if (/[ㄱ-ㅎㅏ-ㅣ]/.test(t)) return '자음·모음만 따로 쓸 수 없어요. (예: ㅋㅋ, ㅠㅠ)';
  if (!/^[가-힣]+$/.test(t)) return '한글 단어만 쓸 수 있어요. (특수문자·이모티콘·한자 불가)';
  if (t.includes(w)) return '정답 단어가 들어간 힌트는 쓸 수 없어요.';
  if (w.includes(t)) return '정답 단어의 일부는 힌트로 쓸 수 없어요.';
  for (let i = 0; i < t.length - 1; i++) {
    if (w.includes(t.substr(i, 2))) return '정답과 두 글자 이상 겹치는 합성어는 쓸 수 없어요.';
  }
  return null;
}

const getPlayer = (room, id) => room.players.find((p) => p.id === id);
const givers = (room) => (room.r ? room.players.filter((p) => p.id !== room.r.guesserId) : []);
function freeChar(room) {
  for (let i = 0; i < CHAR_COUNT; i++) if (!room.players.some((p) => p.charId === i)) return i;
  return 0;
}

// ---------------- 타이머 ----------------
function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.endsAt = null;
  room.phaseDuration = null;
}
function setTimer(room, sec, fn) {
  clearTimer(room);
  room.endsAt = Date.now() + sec * 1000;
  room.phaseDuration = sec;
  // 네트워크 지연을 감안해 0.4초 여유
  room.timer = setTimeout(() => {
    room.timer = null;
    try { fn(); } catch (e) { console.error(e); }
    broadcast(room);
  }, sec * 1000 + 400);
}

// ---------------- 게임 진행 ----------------
function resetGame(room) {
  clearTimer(room);
  room.round = 0;
  room.history = [];
  room.turnOrder = [];
  room.turnPtr = 0;
  room.used = {};
  room.topicQueue = [];
  room.lastTopic = null;
  room.endedEarly = false;
  room.r = null;
}

function draw(room, key, pool, n) {
  const used = room.used[key] || (room.used[key] = new Set());
  let avail = pool.filter((w) => !used.has(w));
  if (avail.length < n) { used.clear(); avail = pool.slice(); }
  const picked = shuffle(avail).slice(0, n);
  picked.forEach((w) => used.add(w));
  return picked;
}

function nextTopic(room) {
  if (!room.topicQueue.length) {
    room.topicQueue = shuffle(Object.keys(EASY_TOPICS));
    if (room.topicQueue[0] === room.lastTopic) room.topicQueue.push(room.topicQueue.shift());
  }
  room.lastTopic = room.topicQueue.shift();
  return room.lastTopic;
}

function setupRound(room) {
  const order = room.turnOrder.filter((id) => getPlayer(room, id));
  const guesserId = order[room.turnPtr % order.length];
  let words;
  let topic = null;
  let choices = null;
  if (room.settings.mode === 'easy') {
    topic = nextTopic(room);
    const pool = EASY_TOPICS[topic].words;
    words = draw(room, 'easy:' + topic, pool, 5);
    const extra = shuffle(pool.filter((w) => !words.includes(w))).slice(0, 3);
    choices = shuffle(words.concat(extra)); // 같은 주제 단어 8개 보기
  } else {
    words = draw(room, 'normal', NORMAL_WORDS, 5);
  }
  room.r = {
    guesserId, words, topic, choices,
    pickedIdx: null,
    clues: {},        // playerId -> 힌트
    status: {},       // playerId -> 'ok' | 'dup' | 'voted'
    votes: {},        // playerId(힌트 주인) -> Set(투표자)
    reviewDone: new Set(),
    guess: null,
    reactions: {},    // target -> Set(누른 사람)
  };
  room.phase = 'pick';
  clearTimer(room);
}

function startGame(room) {
  resetGame(room);
  room.turnOrder = room.players.map((p) => p.id);
  room.round = 1;
  setupRound(room);
}

function pickWord(room, idx) {
  room.r.pickedIdx = idx;
  room.phase = 'clue';
  setTimer(room, room.settings.clueTime, () => endClue(room));
}

function endClue(room) {
  if (room.phase !== 'clue') return;
  const r = room.r;
  // 1) 똑같은 힌트 자동 제거
  const count = {};
  for (const t of Object.values(r.clues)) count[norm(t)] = (count[norm(t)] || 0) + 1;
  for (const [pid, t] of Object.entries(r.clues)) r.status[pid] = count[norm(t)] > 1 ? 'dup' : 'ok';
  const okCount = Object.values(r.status).filter((s) => s === 'ok').length;
  // 2) 힌트 주는 사람이 2명 이상이면 비슷한 힌트 검토(투표) 단계
  if (givers(room).length >= 2 && okCount >= 1) {
    room.phase = 'review';
    setTimer(room, REVIEW_SECONDS, () => endReview(room));
  } else {
    clearTimer(room);
    room.phase = 'guess';
  }
}

function voterCount(room) {
  return Math.max(1, givers(room).filter((p) => p.connected).length);
}

function endReview(room) {
  if (room.phase !== 'review') return;
  const r = room.r;
  const total = voterCount(room);
  for (const [pid, st] of Object.entries(r.status)) {
    const v = r.votes[pid] ? r.votes[pid].size : 0;
    if (st === 'ok' && v * 2 > total) r.status[pid] = 'voted'; // 과반수 찬성 → 제거
  }
  clearTimer(room);
  room.phase = 'guess';
}

function maybeFinishReview(room) {
  if (room.phase !== 'review') return;
  const active = givers(room).filter((p) => p.connected);
  if (active.length && active.every((p) => room.r.reviewDone.has(p.id))) endReview(room);
}

function submitGuess(room, text, pass) {
  const r = room.r;
  const word = r.words[r.pickedIdx];
  const success = !pass && norm(text) === norm(word);
  r.guess = { text: pass ? '' : String(text).trim(), pass: !!pass, success };
  room.history.push({
    round: room.round,
    guesserId: r.guesserId,
    guesserName: (getPlayer(room, r.guesserId) || {}).name || '?',
    word, topic: r.topic, success, pass: !!pass, guess: r.guess.text,
  });
  room.phase = 'result';
  clearTimer(room);
}

function nextRound(room) {
  if (room.round >= TOTAL_ROUNDS) return endGame(room, false);
  room.round += 1;
  room.turnPtr += 1;
  setupRound(room);
}

function endGame(room, early) {
  clearTimer(room);
  room.phase = 'end';
  room.endedEarly = early;
  room.r = null;
}

// ---------------- 상태 전송 (사람마다 다르게) ----------------
function stateFor(room, pid) {
  const s = {
    code: room.code,
    hostId: room.hostId,
    myId: pid,
    phase: room.phase,
    settings: room.settings,
    players: room.players.map((p) => ({ id: p.id, name: p.name, charId: p.charId, connected: p.connected })),
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    score: room.history.filter((h) => h.success).length,
    history: room.history,
    endedEarly: room.endedEarly,
    serverNow: Date.now(),
    endsAt: room.endsAt,
    phaseDuration: room.phaseDuration,
    game: null,
  };
  const r = room.r;
  if (!r || room.phase === 'lobby' || room.phase === 'end') return s;

  const isG = pid === r.guesserId;
  const ph = room.phase;
  const reveal = ph === 'result';
  const hideWords = isG && !reveal;
  const g = {
    guesserId: r.guesserId,
    topic: r.topic,
    topicEmoji: r.topic ? EASY_TOPICS[r.topic].emoji : null,
    words: hideWords ? null : r.words,
    pickedIdx: r.pickedIdx,
    word: hideWords || r.pickedIdx == null ? null : r.words[r.pickedIdx],
    givers: givers(room).map((p) => p.id),
    submitted: Object.keys(r.clues),
    myClue: r.clues[pid] || null,
    reviewDone: [...r.reviewDone],
    choices: ph === 'guess' || ph === 'result' ? r.choices : null,
    guess: reveal ? r.guess : null,
    myReacted: Object.entries(r.reactions).filter(([, set]) => set.has(pid)).map(([k]) => k),
    clues: null,
  };
  const item = (cid) => ({
    pid: cid,
    text: r.clues[cid],
    status: r.status[cid] || 'ok',
    votes: r.votes[cid] ? r.votes[cid].size : 0,
    myVote: !!(r.votes[cid] && r.votes[cid].has(pid)),
  });
  if (ph === 'review' && !isG) g.clues = Object.keys(r.clues).map(item);
  if (ph === 'guess') {
    g.clues = isG
      ? Object.keys(r.clues).filter((c) => r.status[c] === 'ok').map((c) => ({ pid: c, text: r.clues[c], status: 'ok' }))
      : Object.keys(r.clues).map(item);
  }
  if (ph === 'result') {
    g.clues = givers(room).map((p) => (r.clues[p.id] ? item(p.id) : { pid: p.id, text: null, status: 'none' }));
  }
  if (ph === 'review') g.voterCount = voterCount(room);
  s.game = g;
  return s;
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', stateFor(room, p.id));
  }
}
const toast = (room, msg) => io.to(room.code).emit('toast', msg);

function scheduleHostHandoff(room) {
  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    const host = getPlayer(room, room.hostId);
    if (host && host.connected) return;
    const next = room.players.find((p) => p.connected);
    if (next) {
      room.hostId = next.id;
      toast(room, `👑 ${next.name}님이 새 방장이 되었어요`);
      broadcast(room);
    }
  }, HOST_HANDOFF_MS);
}

function removePlayer(room, pid) {
  room.players = room.players.filter((p) => p.id !== pid);
  if (!room.players.length) { clearTimer(room); rooms.delete(room.code); return; }
  if (room.hostId === pid) room.hostId = (room.players.find((p) => p.connected) || room.players[0]).id;
}

// ---------------- 소켓 ----------------
io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    if (!room) return {};
    return { room, me: getPlayer(room, socket.data.pid) };
  };

  function attach(room, p) {
    if (p.socketId && p.socketId !== socket.id) {
      const old = io.sockets.sockets.get(p.socketId);
      if (old) { old.data.code = null; old.emit('replaced'); old.leave(room.code); }
    }
    p.socketId = socket.id;
    p.connected = true;
    socket.data.code = room.code;
    socket.data.pid = p.id;
    socket.join(room.code);
    room.lastActive = Date.now();
  }

  // 공통 핸들러: 방/플레이어 확인 + 에러 처리
  function on(event, needRoom, fn) {
    socket.on(event, (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      try {
        if (needRoom) {
          const { room, me } = ctx();
          if (!room || !me) return reply({ ok: false, error: '방 정보를 찾을 수 없어요.' });
          room.lastActive = Date.now();
          const res = fn(data || {}, room, me);
          if (res && res.error) return reply({ ok: false, error: res.error });
          broadcast(room);
          return reply({ ok: true });
        }
        return fn(data || {}, reply);
      } catch (e) {
        console.error(e);
        reply({ ok: false, error: '오류가 발생했어요.' });
      }
    });
  }

  const cleanName = (n) => String(n || '').trim().slice(0, 8);

  on('create', false, (d, reply) => {
    const name = cleanName(d.name);
    if (!name) return reply({ ok: false, error: '닉네임을 입력해 주세요.' });
    const code = newCode();
    const room = {
      code, hostId: null, players: [], phase: 'lobby',
      settings: { mode: 'normal', clueTime: 20 },
      lastActive: Date.now(),
    };
    resetGame(room);
    rooms.set(code, room);
    const p = { id: newId(), name, charId: 0, connected: true, socketId: null };
    room.players.push(p);
    room.hostId = p.id;
    attach(room, p);
    reply({ ok: true, code, playerId: p.id });
    broadcast(room);
  });

  on('join', false, (d, reply) => {
    const code = String(d.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, error: '그런 방이 없어요. 코드를 확인해 주세요.' });
    const name = cleanName(d.name);
    if (!name) return reply({ ok: false, error: '닉네임을 입력해 주세요.' });

    let p = d.playerId ? getPlayer(room, d.playerId) : null;
    if (!p) {
      const same = room.players.find((x) => x.name === name);
      if (same) {
        // 대기실에서는 같은 닉네임 금지, 게임 중에는 같은 닉네임으로 자리 이어받기
        if (room.phase === 'lobby' && same.connected) return reply({ ok: false, error: '이미 사용 중인 닉네임이에요.' });
        p = same;
      }
    }
    if (!p) {
      if (room.players.length >= MAX_PLAYERS) return reply({ ok: false, error: `방이 꽉 찼어요. (최대 ${MAX_PLAYERS}명)` });
      p = { id: newId(), name, charId: freeChar(room), connected: true, socketId: null };
      room.players.push(p);
      if (room.phase !== 'lobby' && room.phase !== 'end') room.turnOrder.push(p.id); // 게임 중 합류
      toast(room, `🙌 ${name}님이 들어왔어요`);
    }
    attach(room, p);
    reply({ ok: true, code, playerId: p.id });
    broadcast(room);
  });

  on('resume', false, (d, reply) => {
    const room = rooms.get(String(d.code || '').toUpperCase());
    const p = room && getPlayer(room, d.playerId);
    if (!p) return reply({ ok: false });
    attach(room, p);
    reply({ ok: true });
    broadcast(room);
  });

  on('pickChar', true, (d, room, me) => {
    const id = Number(d.charId);
    if (room.phase !== 'lobby') return { error: '대기실에서만 바꿀 수 있어요.' };
    if (!(id >= 0 && id < CHAR_COUNT)) return { error: '잘못된 캐릭터예요.' };
    if (room.players.some((p) => p.id !== me.id && p.charId === id)) return { error: '다른 사람이 고른 캐릭터예요.' };
    me.charId = id;
  });

  on('settings', true, (d, room, me) => {
    if (room.hostId !== me.id) return { error: '방장만 바꿀 수 있어요.' };
    if (room.phase !== 'lobby') return { error: '게임 중에는 바꿀 수 없어요.' };
    if (d.mode === 'normal' || d.mode === 'easy') room.settings.mode = d.mode;
    if (CLUE_TIMES.includes(Number(d.clueTime))) room.settings.clueTime = Number(d.clueTime);
  });

  on('start', true, (d, room, me) => {
    if (room.hostId !== me.id) return { error: '방장만 시작할 수 있어요.' };
    if (room.phase !== 'lobby') return { error: '이미 게임 중이에요.' };
    if (room.players.length < MIN_PLAYERS) return { error: `${MIN_PLAYERS}명 이상 모여야 시작할 수 있어요.` };
    startGame(room);
  });

  on('pick', true, (d, room, me) => {
    const i = Number(d.index);
    if (room.phase !== 'pick' || room.r.guesserId !== me.id) return { error: '지금은 고를 수 없어요.' };
    if (!(i >= 0 && i < 5)) return { error: '1~5 중에서 골라 주세요.' };
    pickWord(room, i);
  });

  on('clue', true, (d, room, me) => {
    const r = room.r;
    if (room.phase !== 'clue' || !r || r.guesserId === me.id) return { error: '지금은 힌트를 낼 수 없어요.' };
    if (r.clues[me.id]) return { error: '이미 힌트를 냈어요.' };
    const err = validateClue(d.text, r.words[r.pickedIdx]);
    if (err) return { error: err };
    r.clues[me.id] = String(d.text).trim();
    if (givers(room).every((p) => r.clues[p.id])) endClue(room);
  });

  on('vote', true, (d, room, me) => {
    const r = room.r;
    if (room.phase !== 'review' || r.guesserId === me.id) return { error: '지금은 투표할 수 없어요.' };
    if (r.status[d.target] !== 'ok') return { error: '투표할 수 없는 힌트예요.' };
    const set = r.votes[d.target] || (r.votes[d.target] = new Set());
    if (set.has(me.id)) set.delete(me.id); else set.add(me.id);
  });

  on('reviewDone', true, (d, room, me) => {
    if (room.phase !== 'review' || room.r.guesserId === me.id) return { error: '지금은 할 수 없어요.' };
    room.r.reviewDone.add(me.id);
    maybeFinishReview(room);
  });

  on('guess', true, (d, room, me) => {
    const r = room.r;
    if (room.phase !== 'guess' || r.guesserId !== me.id) return { error: '지금은 정답을 낼 수 없어요.' };
    if (d.pass) return submitGuess(room, '', true);
    const text = String(d.text || '').trim();
    if (!text) return { error: '정답을 입력해 주세요.' };
    if (room.settings.mode === 'easy' && r.choices && !r.choices.includes(text)) return { error: '보기 중에서 골라 주세요.' };
    submitGuess(room, text.slice(0, 20), false);
  });

  on('next', true, (d, room) => {
    if (room.phase !== 'result' || Number(d.round) !== room.round) return; // 중복 클릭 무시
    nextRound(room);
  });

  on('react', true, (d, room, me) => {
    const r = room.r;
    if (!r || !(room.phase === 'guess' || room.phase === 'result')) return { error: '지금은 반응할 수 없어요.' };
    if (!EMOJIS.includes(d.emoji)) return { error: '잘못된 이모티콘이에요.' };
    const target = String(d.target || '');
    let hiddenFromGuesser = false;
    if (target === 'guess') {
      if (room.phase !== 'result' || !r.guess) return { error: '반응할 수 없어요.' };
    } else if (target.startsWith('hint:')) {
      const hid = target.slice(5);
      if (!r.clues[hid]) return { error: '반응할 수 없어요.' };
      hiddenFromGuesser = room.phase === 'guess' && r.status[hid] !== 'ok';
      if (hiddenFromGuesser && me.id === r.guesserId) return { error: '반응할 수 없어요.' };
    } else return { error: '반응할 수 없어요.' };
    const set = r.reactions[target] || (r.reactions[target] = new Set());
    if (set.has(me.id)) return { error: '답변마다 한 번만 누를 수 있어요.' };
    set.add(me.id);
    for (const p of room.players) {
      if (!p.connected || !p.socketId) continue;
      if (hiddenFromGuesser && p.id === r.guesserId) continue;
      io.to(p.socketId).emit('reaction', { target, emoji: d.emoji, pid: me.id });
    }
  });

  // ----- 방장 도구 -----
  on('host:force', true, (d, room, me) => {
    if (room.hostId !== me.id) return { error: '방장만 할 수 있어요.' };
    if (room.phase === 'clue') endClue(room);
    else if (room.phase === 'review') endReview(room);
    else return { error: '지금은 쓸 수 없어요.' };
  });

  on('host:skip', true, (d, room, me) => {
    if (room.hostId !== me.id) return { error: '방장만 할 수 있어요.' };
    if (!['pick', 'clue', 'review', 'guess'].includes(room.phase)) return { error: '지금은 쓸 수 없어요.' };
    room.turnPtr += 1;
    setupRound(room); // 같은 라운드 번호로 다음 사람이 술래
    toast(room, '⏭️ 방장이 술래를 다음 사람에게 넘겼어요');
  });

  on('host:end', true, (d, room, me) => {
    if (room.hostId !== me.id) return { error: '방장만 할 수 있어요.' };
    if (room.phase === 'lobby' || room.phase === 'end') return { error: '게임 중이 아니에요.' };
    endGame(room, true);
    toast(room, '🛑 방장이 게임을 종료했어요');
  });

  on('restart', true, (d, room, me) => {
    if (room.hostId !== me.id) return { error: '방장만 할 수 있어요.' };
    resetGame(room);
    room.phase = 'lobby';
  });

  on('kick', true, (d, room, me) => {
    if (room.hostId !== me.id) return { error: '방장만 할 수 있어요.' };
    if (room.phase !== 'lobby') return { error: '대기실에서만 내보낼 수 있어요.' };
    const t = getPlayer(room, d.playerId);
    if (!t || t.id === me.id) return { error: '내보낼 수 없어요.' };
    if (t.socketId) io.to(t.socketId).emit('kicked');
    removePlayer(room, t.id);
  });

  socket.on('leave', (_d, cb) => {
    const { room, me } = ctx();
    socket.data.code = null;
    if (room && me) {
      socket.leave(room.code);
      if (room.phase === 'lobby') removePlayer(room, me.id);
      else { me.connected = false; me.socketId = null; scheduleHostHandoff(room); maybeFinishReview(room); }
      if (rooms.has(room.code)) broadcast(room);
    }
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const { room, me } = ctx();
    if (!room || !me || me.socketId !== socket.id) return;
    me.connected = false;
    me.socketId = null;
    room.lastActive = Date.now();
    if (room.hostId === me.id) scheduleHostHandoff(room);
    maybeFinishReview(room);
    broadcast(room);
  });
});

// 오래 비어 있는 방 정리
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.every((p) => !p.connected) && now - room.lastActive > ROOM_TTL_MS) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`🎮 저스트 원 서버 실행 중: http://localhost:${PORT}`));
