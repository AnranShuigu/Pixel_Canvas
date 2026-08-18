
(function () {
'use strict';
function mePanelOpen() { var p = document.getElementById('musicEditorPanel'); return !!p && p.style.display !== 'none'; }
window.__meOpen = function () { var p = document.getElementById('musicEditorPanel'); if (!p) return; p.style.display = 'flex'; };
window.__meClose = function () { var p = document.getElementById('musicEditorPanel'); if (!p) return; p.style.display = 'none'; if (typeof stopScheduler === 'function') stopScheduler(); };
(function () { var cb = document.getElementById('me-closeBtn'); if (cb) cb.addEventListener('click', window.__meClose); })();
(function () { var ib = document.getElementById('me-btnImportSound');
if (ib) ib.addEventListener('click', function () {
  if (!state.tracks || !state.tracks.length) { alert('音乐编辑器还没有轨道内容。'); return; }
  var nm = prompt('声音名称（将出现在节点编辑器「声音」分类的「声音A」下拉中）', '音乐编辑器歌曲');
  if (!nm || !nm.trim()) return;
  nm = nm.trim();
  renderSongToSoundLib(nm);
});
function renderSongToSoundLib(nm) {
  var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC) { alert('浏览器不支持 OfflineAudioContext，无法渲染歌曲。'); return; }
  var sr = 44100;
  var stepD = stepDur();
  var steps = totalSteps();
  var dur = steps * stepD;
  var tail = 0.5;
  var off = new AC(2, Math.ceil(sr * (dur + tail)), sr);
  var master = off.createGain();
  master.gain.value = noteVel();
  master.connect(off.destination);
  var anySolo = state.tracks.some(function (t) { return t.solo; });
  for (var ti = 0; ti < state.tracks.length; ti++) {
    var trk = state.tracks[ti];
    if (trk.muted) continue;
    if (anySolo && !trk.solo) continue;
    var def = INSTRUMENTS[trk.instrument];
    if (!def) continue;
    trk.cells.forEach(function (len, key) {
      var parts = String(key).split(',');
      var r = parseInt(parts[0], 10), st = parseInt(parts[1], 10);
      if (isNaN(r) || isNaN(st) || st < 0 || st >= steps) return;
      try { def.synth(off, master, trk, r, 0.05 + st * stepD, noteVel(), (len || 1) * stepD); } catch (e) {}
    });
  }
  off.startRendering().then(function (buf) {
    if (stopInstancesOf) stopInstancesOf(nm);
    SOUND_LIB[nm] = { name: nm, buffer: buf, duration: buf.duration, src: 'song' };
    if (renderSoundUI) renderSoundUI();
    if (renderNodeGraph) renderNodeGraph();
    alert('已将当前歌曲导入声音库「' + nm + '」（' + buf.duration.toFixed(1) + ' 秒 · ' + state.tracks.length + ' 轨）。\n可在节点编辑器「声音」分类节点的「声音A」下拉中选择。');
  }).catch(function (err) {
    alert('离线渲染失败：' + (err && err.message ? err.message : '未知原因'));
  });
}
})();


// ===================================================================
// 音乐编辑器 —— 零依赖、纯前端、双击即开
// -------------------------------------------------------------------
// 组成：钢琴卷帘旋律轨 + 步进鼓轨，多轨道，Web Audio 实时播放，
//       OfflineAudioContext 导出 WAV，工程 JSON 导入导出 + localStorage 自动保存。
//
// 【乐器扩展接口 registerInstrument】
//   registerInstrument('id', {
//     name   显示名称
//     kind   'melody'（音高行，行=半音） | 'drum'（鼓件行，行=鼓件名）
//     color  轨道色块与音符颜色
//     rows   'melody': 行数（半音数）；'drum': 行标签数组（自底向上）
//     synth(ctx, dest, trk, row, when, vel)
//           合成函数：在 when（秒）时刻向 dest 节点发声一次
//           · ctx   = AudioContext（实时）或 OfflineAudioContext（导出）
//           · trk   = 轨道对象 { instrument, octaves, startOctave, ... }
//           · row   = 行索引（自底向上，0 = 最低行）
//           · vel   = 力度 0~1
//           旋律乐器可用 trk 里的八度信息计算频率：
//             baseMidi = (trk.startOctave + 1) * 12
//             freq     = midiToFreq(baseMidi + row)
//   })
//   新增乐器直接在此文件末尾 registerInstrument(...) 即可，无需改其他代码。
// ===================================================================

// ---------------- 工具函数 ----------------
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---------------- 状态 ----------------
const state = {
  bpm: 120,
  volume: 80,
  beatsPerBar: 4,
  bars: 2,
  tracks: [],
  nextTrackId: 1,
  playing: false,
  currentStep: 0,
};
function totalSteps() { return state.bars * state.beatsPerBar * 4; } // 每拍 4 个 16 分音符
function stepDur() { return 60 / state.bpm / 4; } // 每个 16 分音符的秒数
function noteVel() { return clamp(state.volume / 100, 0, 1); }

// ---------------- 乐器注册表 ----------------
const INSTRUMENTS = {};
function registerInstrument(id, def) { INSTRUMENTS[id] = def; }

// ---------------- 音频 ----------------
let audioCtx = null;
let masterGain = null;
let noiseBuffer = null;

function ensureAudio() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = noteVel();
  masterGain.connect(audioCtx.destination);
  // 预生成 2 秒白噪声缓冲（鼓声共用）
  const len = audioCtx.sampleRate * 2;
  noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const d = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return audioCtx;
}

function newNoiseSource(ctx, when, dur) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  src.start(when);
  src.stop(when + dur);
  return src;
}

// 音符包络辅助：指数衰减的 gain
function envGain(ctx, when, peak, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  return g;
}

// ---------------- 内置乐器 ----------------
registerInstrument('piano', {
  name: '钢琴',
  kind: 'melody',
  color: '#5aa2ff',
  rows: 12,
  synth: function (ctx, dest, trk, row, when, vel, dur) {
    const d = dur || 0.42; // 音符时长（长音 = 登~~）
    const f = midiToFreq(noteMidi(trk, row));
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = envGain(ctx, when, 0.42 * vel, d);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + d + 0.08);
  },
});

registerInstrument('synth8', {
  name: '方波合成器',
  kind: 'melody',
  color: '#c084fc',
  rows: 12,
  synth: function (ctx, dest, trk, row, when, vel, dur) {
    const d = dur || 0.18;
    const f = midiToFreq(noteMidi(trk, row));
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const g = envGain(ctx, when, 0.28 * vel, d);
    // 8-bit 感：快速衰减的方波
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + d + 0.06);
  },
});

registerInstrument('bass', {
  name: '贝斯',
  kind: 'melody',
  color: '#4ade80',
  rows: 12,
  synth: function (ctx, dest, trk, row, when, vel, dur) {
    const d = dur || 0.28;
    const f = midiToFreq(noteMidi(trk, row));
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 900;
    const g = envGain(ctx, when, 0.35 * vel, d);
    o.connect(filt); filt.connect(g); g.connect(dest);
    o.start(when); o.stop(when + d + 0.08);
  },
});

registerInstrument('drums', {
  name: '鼓组',
  kind: 'drum',
  color: '#f87171',
  rows: ['Kick', 'Snare', 'HiHat', 'OHat', 'Clap', 'Tom'],
  synth: function (ctx, dest, trk, row, when, vel) {
    const t = when;
    switch (row) {
      case 0: { // Kick：正弦频率下滑
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(150, t);
        o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
        const g = envGain(ctx, t, 0.9 * vel, 0.24);
        o.connect(g); g.connect(dest);
        o.start(t); o.stop(t + 0.3);
        break;
      }
      case 1: { // Snare：噪声带通 + 一点正弦
        const n = newNoiseSource(ctx, t, 0.18);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
        const g = envGain(ctx, t, 0.55 * vel, 0.16);
        n.connect(bp); bp.connect(g); g.connect(dest);
        break;
      }
      case 2: { // HiHat：噪声高通短促
        const n = newNoiseSource(ctx, t, 0.05);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 7000;
        const g = envGain(ctx, t, 0.28 * vel, 0.045);
        n.connect(hp); hp.connect(g); g.connect(dest);
        break;
      }
      case 3: { // Open HiHat：噪声高通稍长
        const n = newNoiseSource(ctx, t, 0.3);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 6500;
        const g = envGain(ctx, t, 0.22 * vel, 0.24);
        n.connect(hp); hp.connect(g); g.connect(dest);
        break;
      }
      case 4: { // Clap：三段噪声爆点
        for (let i = 0; i < 3; i++) {
          const wt = t + i * 0.012;
          const n = newNoiseSource(ctx, wt, 0.08);
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 1.2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, wt);
          g.gain.exponentialRampToValueAtTime(0.4 * vel, wt + 0.005);
          g.gain.exponentialRampToValueAtTime(0.0001, wt + 0.05);
          n.connect(bp); bp.connect(g); g.connect(dest);
        }
        break;
      }
      case 5: { // Tom：正弦下滑低音
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(110, t + 0.2);
        const g = envGain(ctx, t, 0.5 * vel, 0.26);
        o.connect(g); g.connect(dest);
        o.start(t); o.stop(t + 0.32);
        break;
      }
    }
  },
});

// ---------------- 轨道模型 ----------------
function makeTrack(instrId, name) {
  const def = INSTRUMENTS[instrId];
  const trk = {
    id: state.nextTrackId++,
    name: name || def.name,
    instrument: instrId,
    octaves: 2,        // melody 轨显示多少个八度（行数 = 12 * octaves）
    startOctave: 3,    // melody 轨最低八度（C3 起）
    pitchOffset: 0,    // 音高滑动偏移（滚轮在网格上滑动浏览全部音域）
    muted: false,
    solo: false,
    cells: new Map(),  // "row,step" -> 时长（16 分音符格数）
  };
  return trk;
}
function trackRows(trk) {
  const def = INSTRUMENTS[trk.instrument];
  return def.kind === 'melody' ? 12 * trk.octaves : def.rows.length;
}
function rowLabel(trk, row) {
  const def = INSTRUMENTS[trk.instrument];
  if (def.kind === 'melody') {
    const m = noteMidi(trk, row);
    return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1); // 科学音高：midi 60 = C4
  }
  return def.rows[row];
}
// melody 轨某行的实际 MIDI 音高（含 pitchOffset 平移，覆盖全部可听音域 0-127）
function noteMidi(trk, row) {
  const def = INSTRUMENTS[trk.instrument];
  if (def.kind !== 'melody') return row;
  const base = (trk.startOctave + 1) * 12;
  return base + row + (trk.pitchOffset || 0);
}
function noteTitle(trk, r, len) {
  const def = INSTRUMENTS[trk.instrument];
  const nm = def.kind === 'melody' ? (NOTE_NAMES[noteMidi(trk, r) % 12] + (Math.floor(noteMidi(trk, r) / 12) - 1)) : (typeof def.rows === 'object' ? def.rows[r] : r);
  return '音符 ' + nm + ' · 时长 ' + len + ' 格（按住拖放 = 长音；右侧边缘拖 = 拉长；悬停 × 或点击 = 删除）';
}
function makeNoteX() {
  const x = document.createElement('span');
  x.className = 'x';
  x.textContent = '×';
  return x;
}
// 创建音符元素（行号超出当前窗口 [0, rows-1] 的返回 null —— 窗口外音符不显示，滑动音阶可见）
function makeNoteEl(trk, r, s, len) {
  const def = INSTRUMENTS[trk.instrument];
  const rows = trackRows(trk);
  if (r < 0 || r >= rows) return null;
  const n = document.createElement('div');
  n.className = 'note';
  n.dataset.r = r; n.dataset.s = s;
  n.style.setProperty('--col', def.color);
  n.style.left = (s * 26) + 'px';
  n.style.top = ((rows - 1 - r) * 22 + 14 + 1) + 'px'; // 14 = 顶部标尺高度
  n.style.width = (Math.max(1, len) * 26 - 3) + 'px';
  n.title = noteTitle(trk, r, len);
  n.appendChild(makeNoteX());
  return n;
}
// 重建音符层（音阶滑动后音符行号变化，位置需刷新；窗口外音符隐藏）
function updateNoteLayer(trk) {
  const t = trackEls.get(trk.id);
  if (!t) return;
  const st = t.scroll.scrollTop; // 保存滚动位置，避免重建时的锚定跳动
  const mq = t.notesLayer.querySelector('.note-marquee');
  t.notesLayer.querySelectorAll('.note').forEach(function (n) { n.remove(); });
  for (const kv of trk.cells) {
    const parts = kv[0].split(',');
    const el2 = makeNoteEl(trk, +parts[0], +parts[1], kv[1] || 1);
    if (el2) t.notesLayer.appendChild(el2);
  }
  if (mq) t.notesLayer.appendChild(mq);
  t.scroll.scrollTop = st;
}
// 音高滑动后刷新行标签与音符提示（不重建 DOM）
function updatePitchLabels(trk) {
  const def = INSTRUMENTS[trk.instrument];
  if (def.kind !== 'melody') return;
  const t = trackEls.get(trk.id);
  if (!t) return;
  const rows = t.rows;
  const lbs = t.labels.querySelectorAll('.row-label');
  lbs.forEach(function (lb, i) {
    const r = rows - 1 - i;
    const m = noteMidi(trk, r);
    lb.textContent = NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
  });
  t.notesLayer.querySelectorAll('.note').forEach(function (n) {
    n.title = noteTitle(trk, parseInt(n.dataset.r, 10), trk.cells.get(n.dataset.r + ',' + n.dataset.s) || 1);
  });
}

// ---------------- DOM ----------------
const $ = function (id) { return document.getElementById(id); };
const tracksEl = $('me-tracks');
const trackEls = new Map(); // track.id -> { head, cellsGrid, playhead, labels }

// ---------------- 轨道 UI 构建 ----------------
function buildTrack(trk) {
  const def = INSTRUMENTS[trk.instrument];
  const rows = trackRows(trk);
  const steps = totalSteps();

  const box = document.createElement('div');
  box.className = 'track';
  box.dataset.tid = trk.id;

  // 头部
  const head = document.createElement('div');
  head.className = 'track-head';
  const sw = document.createElement('span');
  sw.className = 'swatch'; sw.style.background = def.color;
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.value = trk.name;
  nameInput.title = '轨道名称';
  nameInput.addEventListener('input', function () {
    trk.name = nameInput.value; saveSoon();
  });
  const instrSel = document.createElement('select');
  const ids = Object.keys(INSTRUMENTS);
  for (const id of ids) {
    const op = document.createElement('option');
    op.value = id; op.textContent = INSTRUMENTS[id].name;
    instrSel.appendChild(op);
  }
  instrSel.value = trk.instrument;
  instrSel.addEventListener('change', function () {
    trk.instrument = instrSel.value;
    // melody 轨音符用绝对音高行号（窗口外隐藏不删）；drums 等固定行数轨道过滤超出行
    const ndef = INSTRUMENTS[trk.instrument];
    if (ndef.kind !== 'melody') {
      const newRows = trackRows(trk);
      for (const key of trk.cells.keys()) {
        const r = parseInt(key.split(',')[0], 10);
        if (r < 0 || r >= newRows) trk.cells.delete(key);
      }
    }
    rebuildTrack(trk); saveSoon();
  });

  const countSpan = document.createElement('span');
  countSpan.className = 'row-count';
  const updateCount = function () {
    countSpan.textContent = '行数 ' + trackRows(trk) + ' · 音符 ' + trk.cells.size;
  };
  updateCount();

  const muteBtn = document.createElement('button');
  muteBtn.textContent = '🔇';
  muteBtn.title = '静音';
  const syncMute = function () { muteBtn.classList.toggle('on', trk.muted); };
  syncMute();
  muteBtn.addEventListener('click', function () { trk.muted = !trk.muted; syncMute(); saveSoon(); });

  const soloBtn = document.createElement('button');
  soloBtn.textContent = 'S';
  soloBtn.title = '独奏';
  const syncSolo = function () { soloBtn.classList.toggle('on', trk.solo); };
  syncSolo();
  soloBtn.addEventListener('click', function () { trk.solo = !trk.solo; syncSolo(); saveSoon(); });

  const delBtn = document.createElement('button');
  delBtn.textContent = '🗑';
  delBtn.className = 'del';
  delBtn.title = '删除轨道';
  delBtn.addEventListener('click', function () {
    const idx = state.tracks.indexOf(trk);
    if (idx >= 0) state.tracks.splice(idx, 1);
    trackEls.delete(trk.id);
    box.remove(); updateNoteCount(); saveSoon();
  });

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  head.appendChild(sw); head.appendChild(nameInput); head.appendChild(instrSel);
  head.appendChild(countSpan); head.appendChild(spacer);
  head.appendChild(muteBtn); head.appendChild(soloBtn); head.appendChild(delBtn);

  // 网格区
  const gridArea = document.createElement('div');
  gridArea.className = 'grid-area';
  const labels = document.createElement('div');
  labels.className = 'row-labels';
  for (let r = rows - 1; r >= 0; r--) {
    const lb = document.createElement('div');
    lb.className = 'row-label';
    lb.textContent = rowLabel(trk, r);
    if (def.kind === 'melody' && NOTE_NAMES[r % 12] === 'C') lb.classList.add('highlight');
    if (def.kind === 'drum' && r % 2 === 0) lb.classList.add('highlight');
    labels.appendChild(lb);
  }

  const scroll = document.createElement('div');
  scroll.className = 'cells-scroll';

  // 顶部步进标尺（拍号刻度）
  const ruler = document.createElement('div');
  ruler.className = 'step-ruler';
  for (let s = 0; s < steps; s++) {
    const d = document.createElement('div');
    d.textContent = (s % 4 === 0) ? String(Math.floor(s / 4) + 1) : '';
    const beatIdx = Math.floor(s / 4) % state.beatsPerBar;
    if (s % 4 === 0) d.classList.add('beat');
    if (beatIdx === 0 && s % 4 === 0) d.classList.add('bar');
    ruler.appendChild(d);
  }

  const grid = document.createElement('div');
  grid.className = 'cells-grid';
  grid.style.gridTemplateColumns = 'repeat(' + steps + ', 26px)';
  grid.style.gridTemplateRows = 'repeat(' + rows + ', 22px)';
  for (let r = rows - 1; r >= 0; r--) {
    for (let s = 0; s < steps; s++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r; cell.dataset.s = s;
      cell.style.setProperty('--col', def.color);
      const beatIdx = Math.floor(s / 4) % state.beatsPerBar;
      const barIdx = Math.floor(s / (4 * state.beatsPerBar));
      if (beatIdx === 0) cell.classList.add('beat');
      if (barIdx > 0 && beatIdx === 0 && s % 4 === 0) cell.classList.add('bar');
      grid.appendChild(cell);
    }
  }
  // 音符层：带时长的音符（cells: "row,step" -> 时长，单位 16 分音符格）
  const notesLayer = document.createElement('div');
  notesLayer.className = 'notes-layer';
  for (const entry of trk.cells) {
    const parts = entry[0].split(',');
    const el2 = makeNoteEl(trk, +parts[0], +parts[1], entry[1] || 1);
    if (el2) notesLayer.appendChild(el2);
  }
  // 框选矩形层（每轨一个，跨轨框选时只显示在起始轨）
  const marqueeEl = document.createElement('div');
  marqueeEl.className = 'note-marquee';
  notesLayer.appendChild(marqueeEl);


  // 播放头竖条
  const playhead = document.createElement('div');
  playhead.className = 'playhead';
  playhead.style.height = (rows * 22) + 'px';
  playhead.style.display = 'none';
  scroll.appendChild(ruler);
  scroll.appendChild(grid);
  scroll.appendChild(notesLayer);
  scroll.appendChild(playhead);
  gridArea.appendChild(labels);
  gridArea.appendChild(scroll);
  box.appendChild(head);
  box.appendChild(gridArea);
  tracksEl.appendChild(box);
  // 轨道分隔条（拖拽调整上下轨道高度）
  const divider = document.createElement('div');
  divider.className = 'track-divider';
  divider.dataset.tid = trk.id;
  tracksEl.appendChild(divider);

  trackEls.set(trk.id, { head, grid, playhead, labels, scroll, notesLayer, rows });

  // 同步播放头位置
  if (state.playing) {
    playhead.style.display = 'block';
    playhead.style.left = (state.currentStep * 26) + 'px';
  }
  return box;
}

// 全量重建所有轨道（布局变化：小节数/拍号等）
function rebuildTracks() {
  trackEls.clear();
  tracksEl.innerHTML = '';
  for (const trk of state.tracks) buildTrack(trk);
  updateNoteCount();
}

// 重建单条轨道（乐器切换等：行数变化）
function rebuildTrack(trk) {
  const old = trackEls.get(trk.id);
  if (old) {
    const box = old.grid.closest('.track');
    const div = box.nextElementSibling;
    if (div && div.classList.contains('track-divider')) div.remove();
    box.remove();
    trackEls.delete(trk.id);
  }
  buildTrack(trk);
}

// ---------------- 网格交互（点击 / 拖动绘制） ----------------
let painting = null; // { trk, val }
let resizingNote = null; // 音符拉长：{ trk, r, s, startX, baseLen }
let dividerDrag = null; // 轨道分隔条拖拽：{ prev, startY, baseH }

function findTrkByEl(el) {
  const box = el.closest('.track');
  if (!box || !box.dataset.tid) return null;
  return state.tracks.find(function (x) { return x.id === parseInt(box.dataset.tid, 10); });
}

function setCell(trk, r, s, val, len) {
  const key = r + ',' + s;
  if (val) trk.cells.set(key, len || 1); else trk.cells.delete(key);
  const t = trackEls.get(trk.id);
  if (t) {
    // 更新音符层
    const old = t.notesLayer.querySelector('.note[data-r="' + r + '"][data-s="' + s + '"]');
    if (old) old.remove();
    if (val) {
      const el2 = makeNoteEl(trk, r, s, len || 1);
      if (el2) t.notesLayer.appendChild(el2);
    }
    const countSpan = t.head.querySelector('.row-count');
    if (countSpan) countSpan.textContent = '行数 ' + trackRows(trk) + ' · 音符 ' + trk.cells.size;
  }
  updateNoteCount();
  saveSoon();
}
// 更新单个音符的时长显示（拉长时调用）
function updateNoteLen(trk, r, s) {
  const t = trackEls.get(trk.id);
  if (!t) return;
  const len = trk.cells.get(r + ',' + s) || 1;
  const n = t.notesLayer.querySelector('.note[data-r="' + r + '"][data-s="' + s + '"]');
  if (n) n.style.width = (Math.max(1, len) * 26 - 3) + 'px';
}

// ---------------- 框选工具 ----------------
let noteSelectMode = false;    // 框选模式开关
let noteMarquee = null;        // 框选进行中：{ trk, x0, y0, x1, y1 }（列/行坐标）
const selectedNotes = new Set(); // 选中音符 "轨道id:r,s"

function showMarquee(trk, x0, y0, x1, y1) {
  const t = trackEls.get(trk.id);
  if (!t) return;
  const mq = t.notesLayer.querySelector('.note-marquee');
  if (!mq) return;
  const rows = t.rows;
  mq.style.display = 'block';
  mq.style.left = (Math.min(x0, x1) * 26) + 'px';
  mq.style.top = ((rows - 1 - Math.max(y0, y1)) * 22 + 14 + 1) + 'px';
  mq.style.width = ((Math.abs(x1 - x0) + 1) * 26) + 'px';
  mq.style.height = ((Math.abs(y1 - y0) + 1) * 22) + 'px';
}
function hideMarquee() {
  document.querySelectorAll('.note-marquee').forEach(function (m) { m.style.display = 'none'; });
}
function finishMarquee() {
  if (!noteMarquee) return;
  const m = noteMarquee;
  const rs = Math.min(m.y0, m.y1), re = Math.max(m.y0, m.y1);
  const cs = Math.min(m.x0, m.x1), ce = Math.max(m.x0, m.x1);
  noteMarquee = null;
  hideMarquee();
  // 跨轨收集框内音符
  selectedNotes.clear();
  for (const t of state.tracks) {
    for (const kv of t.cells) {
      const parts = kv[0].split(',');
      const r = +parts[0], s = +parts[1];
      if (r >= rs && r <= re && s >= cs && s <= ce) selectedNotes.add(t.id + ':' + kv[0]);
    }
  }
  // 高亮
  document.querySelectorAll('.note.selected').forEach(function (n) { n.classList.remove('selected'); });
  for (const key of selectedNotes) {
    const p = key.split(':');
    const t = trackEls.get(+p[0]);
    if (!t) continue;
    const pp = p[1].split(',');
    const n = t.notesLayer.querySelector('.note[data-r="' + pp[0] + '"][data-s="' + pp[1] + '"]');
    if (n) n.classList.add('selected');
  }
}
function clearNoteSelection() {
  selectedNotes.clear();
  document.querySelectorAll('.note.selected').forEach(function (n) { n.classList.remove('selected'); });
}
function deleteSelectedNotes() {
  const keys = Array.from(selectedNotes);
  clearNoteSelection();
  for (const key of keys) {
    const p = key.split(':');
    const t = state.tracks.find(function (x) { return x.id === +p[0]; });
    if (!t) continue;
    const pp = p[1].split(',');
    setCell(t, +pp[0], +pp[1], false);
  }
}

tracksEl.addEventListener('pointerdown', function (e) {
  // 右键：框选模式下删除选中的音符
  if (e.button === 2) {
    if (noteSelectMode && selectedNotes.size) {
      e.preventDefault();
      deleteSelectedNotes();
    }
    return;
  }
  if (e.button !== 0) return;
  // 分隔条：拖拽调整上下轨道高度
  const div = e.target.closest('.track-divider');
  if (div) {
    e.preventDefault();
    const prev = div.previousElementSibling;
    if (prev && prev.classList.contains('track')) {
      dividerDrag = { prev: prev, startY: e.clientY, baseH: prev.offsetHeight };
    }
    return;
  }
  // 音符悬停删除按钮 ×
  const nx = e.target.closest('.note .x');
  if (nx) {
    e.preventDefault();
    const note = nx.closest('.note');
    const trk = findTrkByEl(note);
    if (trk) setCell(trk, +note.dataset.r, +note.dataset.s, false);
    return;
  }
  // 框选模式：从空格子开始拖拽框选
  if (noteSelectMode) {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    e.preventDefault();
    const trk = findTrkByEl(cell);
    if (!trk) return;
    const s = +cell.dataset.s, r = +cell.dataset.r;
    noteMarquee = { trk: trk, x0: s, y0: r, x1: s, y1: r };
    showMarquee(trk, s, r, s, r);
    return;
  }
  // 音符：右侧边缘 = 拉长；中间点击 = 删除
  const note = e.target.closest('.note');
  if (note) {
    e.preventDefault();
    const trk = findTrkByEl(note);
    if (!trk) return;
    const r = parseInt(note.dataset.r, 10), s = parseInt(note.dataset.s, 10);
    const rect = note.getBoundingClientRect();
    if (e.clientX - rect.left > rect.width - 9) {
      resizingNote = { trk: trk, r: r, s: s, startX: e.clientX, baseLen: trk.cells.get(r + ',' + s) || 1 };
      return;
    }
    setCell(trk, r, s, false);
    return;
  }
  // 空格子：放置音符（按住拖动 = 拉长）
  const cell = e.target.closest('.cell');
  if (!cell) return;
  e.preventDefault();
  const trk = findTrkByEl(cell);
  if (!trk) return;
  const r = parseInt(cell.dataset.r, 10);
  const s = parseInt(cell.dataset.s, 10);
  painting = { trk, val: true, r: r, s: s };
  setCell(trk, r, s, true);
});

tracksEl.addEventListener('pointermove', function (e) {
  if (noteMarquee) {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    noteMarquee.x1 = +cell.dataset.s;
    noteMarquee.y1 = +cell.dataset.r;
    showMarquee(noteMarquee.trk, noteMarquee.x0, noteMarquee.y0, noteMarquee.x1, noteMarquee.y1);
    return;
  }
  if (!painting || !(e.buttons & 1)) return;
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const trk = findTrkByEl(cell);
  if (!trk || trk !== painting.trk) return;
  if (painting.val) {
    // 放置模式：按住不放拖动 = 变长音（从起点列拉长）
    const len = Math.max(1, +cell.dataset.s - painting.s + 1);
    trk.cells.set(painting.r + ',' + painting.s, len);
    updateNoteLen(trk, painting.r, painting.s);
    saveSoon();
    return;
  }
  setCell(trk, parseInt(cell.dataset.r, 10), parseInt(cell.dataset.s, 10), painting.val);
});

// 音高滑动：滚轮在旋律轨网格上 → 音阶上/下移动，音符块跟随滑动（保持绝对音高；Shift = 快跳八度）
tracksEl.addEventListener('wheel', function (e) {
  // 鼠标所在轨道（整个轨道窗口，含头部与网格）
  const box = e.target.closest('.track');
  if (!box) return;
  const srcTrk = findTrkByEl(box);
  if (!srcTrk) return;
  const t = trackEls.get(srcTrk.id);
  // Shift + 滚轮：左右滑动当前轨道（长轨道水平浏览）
  if (e.shiftKey) {
    e.preventDefault();
    if (t) t.scroll.scrollLeft += e.deltaY;
    return;
  }
  // 普通滚轮：旋律轨 = 音高上下滑动（只作用于鼠标所在轨道）
  if (INSTRUMENTS[srcTrk.instrument].kind !== 'melody') return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1 : -1;
  const rows = trackRows(srcTrk);
  const base = (srcTrk.startOctave + 1) * 12;
  const maxOff = 127 - base - rows + 1;
  const nextOff = clamp((srcTrk.pitchOffset || 0) + delta, -base, maxOff);
  const applied = nextOff - (srcTrk.pitchOffset || 0);
  if (!applied) return;
  // 音符行号反向迁移（绝对音高不变 → 音符块跟随音阶上下移动）
  srcTrk.pitchOffset = (srcTrk.pitchOffset || 0) + applied;
  const moves = [];
  for (const kv of srcTrk.cells) {
    const parts = kv[0].split(',');
    moves.push([parts[0], parts[1], kv[1], +parts[0] - applied]);
  }
  for (const mv of moves) {
    srcTrk.cells.delete(mv[0] + ',' + mv[1]);
    srcTrk.cells.set(mv[3] + ',' + mv[1], mv[2]);
  }
  updatePitchLabels(srcTrk);
  updateNoteLayer(srcTrk);
}, { passive: false });

// 音符拉长 / 分隔条拖拽（全局跟踪）
window.addEventListener('pointermove', function (e) { if (!mePanelOpen()) return;
  if (resizingNote) {
    const dx = e.clientX - resizingNote.startX;
    const len = Math.max(1, Math.round(resizingNote.baseLen + dx / 26));
    resizingNote.trk.cells.set(resizingNote.r + ',' + resizingNote.s, len);
    updateNoteLen(resizingNote.trk, resizingNote.r, resizingNote.s);
    saveSoon();
    return;
  }
  if (dividerDrag) {
    const h = Math.max(64, dividerDrag.baseH + (e.clientY - dividerDrag.startY));
    dividerDrag.prev.style.height = h + 'px';
  }
});
window.addEventListener('pointerup', function () { if (!mePanelOpen()) return;
  if (noteMarquee) finishMarquee();
  painting = null; resizingNote = null; dividerDrag = null;
});
window.addEventListener('pointercancel', function () { if (!mePanelOpen()) return;
  if (noteMarquee) finishMarquee();
  painting = null; resizingNote = null; dividerDrag = null;
});

// 框选工具按钮 + Esc 取消
$('me-btnNoteSelect').addEventListener('click', function () {
  noteSelectMode = !noteSelectMode;
  this.classList.toggle('on', noteSelectMode);
  if (!noteSelectMode) clearNoteSelection();
});
document.addEventListener('keydown', function (e) { if (!mePanelOpen()) return;
  if (e.key === 'Escape') {
    noteSelectMode = false;
    const b = $('me-btnNoteSelect');
    if (b) b.classList.remove('on');
    clearNoteSelection();
  }
});

// ---------------- 播放引擎 ----------------
// 调度器：setInterval 25ms 轮询，用 audioCtx.currentTime 精确对齐每个 step，避免漂移
let schedulerTimer = null;
let nextStepTime = 0;

function isAudible(trk) {
  if (trk.muted) return false;
  if (trk.solo) return true;
  return !state.tracks.some(function (t) { return t.solo; });
}

// 在 when 时刻调度某个 step 的全部音符（实时与离线导出共用）；音符时长 = len 格 × 每格秒数
function scheduleStep(ctx, dest, trk, step, when) {
  if (!isAudible(trk)) return;
  const def = INSTRUMENTS[trk.instrument];
  const vel = noteVel();
  for (const entry of trk.cells) {
    const parts = entry[0].split(',');
    if (parseInt(parts[1], 10) === step) {
      def.synth(ctx, dest, trk, parseInt(parts[0], 10), when, vel, (entry[1] || 1) * stepDur());
    }
  }
}

function schedulerTick() {
  const ctx = audioCtx;
  if (!ctx) return;
  const dur = stepDur();
  while (nextStepTime < ctx.currentTime + 0.12) {
    const step = state.currentStep;
    for (const trk of state.tracks) {
      scheduleStep(ctx, masterGain, trk, step, nextStepTime);
    }
    state.currentStep = (state.currentStep + 1) % totalSteps();
    nextStepTime += dur;
  }
}

function startScheduler() {
  const ctx = ensureAudio();
  if (ctx.state === 'suspended') ctx.resume();
  if (schedulerTimer) return;
  state.currentStep = 0;
  nextStepTime = ctx.currentTime + 0.06;
  schedulerTimer = setInterval(schedulerTick, 25);
  state.playing = true;
  syncPlayUI();
  requestAnimationFrame(playheadLoop);
}

function stopScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
  state.playing = false;
  state.currentStep = 0;
  for (const [, t] of trackEls.entries()) t.playhead.style.display = 'none';
  syncPlayUI();
}

function togglePlay() {
  if (state.playing) stopScheduler(); else startScheduler();
}

// 播放头动画
function playheadLoop() {
  if (!state.playing) return;
  const t = trackEls.values().next().value;
  if (t) {
    for (const [, e] of trackEls.entries()) {
      e.playhead.style.display = 'block';
      e.playhead.style.left = (state.currentStep * 26) + 'px';
    }
  }
  $('me-stepInfo').textContent = state.currentStep + ' / ' + totalSteps();
  requestAnimationFrame(playheadLoop);
}

function syncPlayUI() {
  const btn = $('me-btnPlay');
  btn.textContent = state.playing ? '⏸ 暂停' : '▶ 播放';
  btn.classList.toggle('on', state.playing);
}

// ---------------- 导出 WAV（OfflineAudioContext 渲染） ----------------
function exportWAV() {
  const steps = totalSteps();
  const dur = steps * stepDur();
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.ceil(sr * (dur + 0.6)), sr);
  const master = off.createGain();
  master.gain.value = noteVel();
  master.connect(off.destination);
  for (const trk of state.tracks) {
    for (let s = 0; s < steps; s++) scheduleStep(off, master, trk, s, s * stepDur());
  }
  off.startRendering().then(function (buffer) {
    const blob = encodeWAV(buffer);
    downloadBlob(blob, 'music-' + Date.now() + '.wav');
  }).catch(function (err) {
    alert('导出失败：' + err.message);
  });
}

function encodeWAV(buffer) {
  const nCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = nCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  function wstr(off, s) { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
  wstr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, nCh, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); wstr(36, 'data'); view.setUint32(40, dataSize, true);
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------- 工程 保存 / 导入导出 ----------------
const SAVE_KEY = 'music-editor-save';
let saveTimer = null;
function saveSoon() {
  $('me-autoSaveHint').textContent = '保存中…';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(toJSON()));
      $('me-autoSaveHint').textContent = '✓ 已自动保存';
    } catch (e) { $('me-autoSaveHint').textContent = '保存失败'; }
  }, 400);
}

function toJSON() {
  return {
    app: 'music-editor', version: 1,
    bpm: state.bpm, volume: state.volume,
    beatsPerBar: state.beatsPerBar, bars: state.bars,
    tracks: state.tracks.map(function (trk) {
      return {
        name: trk.name, instrument: trk.instrument,
        octaves: trk.octaves, startOctave: trk.startOctave,
        muted: trk.muted, solo: trk.solo, pitchOffset: trk.pitchOffset || 0,
        cells: Array.from(trk.cells, function (kv) { return kv[0] + ',' + kv[1]; }),
      };
    }),
  };
}

function fromJSON(data) {
  if (!data) return false;
  // 支持导入像素画 v2 工程（颜色 → 乐器/长短，位置 → 音高/时间）
  if (data.app === 'infinite-grid-canvas' && data.version === 2 && Array.isArray(data.pixels)) {
    return fromV2Pixels(data);
  }
  if (data.app !== 'music-editor') return false;
  state.bpm = clamp(parseInt(data.bpm, 10) || 120, 40, 240);
  state.volume = clamp(parseInt(data.volume, 10) || 80, 0, 100);
  state.beatsPerBar = parseInt(data.beatsPerBar, 10) || 4;
  state.bars = clamp(parseInt(data.bars, 10) || 2, 1, 8);
  state.tracks = [];
  state.nextTrackId = 1;
  for (const t of data.tracks || []) {
    if (!INSTRUMENTS[t.instrument]) continue;
    const trk = makeTrack(t.instrument, t.name);
    trk.octaves = t.octaves || 2;
    trk.startOctave = t.startOctave || 3;
    trk.muted = !!t.muted;
    trk.solo = !!t.solo;
    trk.pitchOffset = t.pitchOffset || 0;
    const newRows = trackRows(trk);
    for (const key of t.cells || []) {
      const parts = String(key).split(',');
      const r = parseInt(parts[0], 10);
      const s = parseInt(parts[1], 10);
      // 时长：旧格式 "row,step" → 1 格；新格式 "row,step,len"
      const len = parts.length > 2 ? parseInt(parts[2], 10) : 1;
      // melody 轨行号可为窗口外（音阶滑动偏移后的绝对行号）
      if (!isNaN(r) && !isNaN(s)) trk.cells.set(r + ',' + s, len || 1);
    }
    state.tracks.push(trk);
  }
  return true;
}

// ---------------- 从像素画 v2 工程还原音乐 ----------------
// 颜色 → 乐器（色相）+ 长短（明度）；位置 → 时间(step)/音高(行)；横向连续同色像素合并为长音符
function fromV2Pixels(data) {
  const hexToHsl = function (hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return { h: h, s: s, l: l };
  };
  const hueToInstr = function (h) {
    let best = 'piano', bd = 1e9;
    for (const name of Object.keys(INSTR_HUE)) {
      let dd = Math.abs(h - INSTR_HUE[name]);
      if (dd > 180) dd = 360 - dd;
      if (dd < bd) { bd = dd; best = name; }
    }
    return best;
  };
  // 网格：找横向连续同色像素合并为长音符
  const grid = new Map();
  for (const p of data.pixels) grid.set(p[1] + ',' + p[0], p[2]);
  const cells = [];
  for (const p of data.pixels) {
    const x = p[0], y = p[1], col = p[2];
    if (grid.get(y + ',' + (x - 1)) === col) continue; // 左边同色 → 已并入前一个
    let len = 1;
    while (grid.get(y + ',' + (x + len)) === col) len++;
    const hsl = hexToHsl(col);
    cells.push({ instr: hueToInstr(hsl.h), row: y, step: x, len: len });
  }
  // 时间范围 → 小节数（默认 4/4）
  let maxX = 0;
  for (const p of data.pixels) if (p[0] > maxX) maxX = p[0];
  state.bpm = 120;
  state.volume = 80;
  state.beatsPerBar = 4;
  state.bars = clamp(Math.ceil((maxX + 1) / 4), 1, 8);
  state.tracks = [];
  state.nextTrackId = 1;
  const byInstr = {};
  for (const c of cells) (byInstr[c.instr] = byInstr[c.instr] || []).push(c);
  for (const instr of Object.keys(byInstr)) {
    if (!INSTRUMENTS[instr]) continue;
    const trk = makeTrack(instr, instr);
    for (const c of byInstr[instr]) trk.cells.set(c.row + ',' + c.step, c.len);
    state.tracks.push(trk);
  }
  return state.tracks.length > 0;
}

function exportJSON() {
  downloadBlob(new Blob([JSON.stringify(toJSON(), null, 2)], { type: 'application/json' }), 'music-' + Date.now() + '.json');
}

// ---------------- 导出为像素画 v2 工程 ----------------
// 颜色编码：乐器 = 色相，音符长短 = 明度（长音符更暗）+ 横向长度
const INSTR_HUE = { piano: 45, synth8: 190, bass: 280, drums: 0 };
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = function (n) { return (n + h / 30) % 12; };
  const a = s * Math.min(l, 1 - l);
  const f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
  const toHex = function (v) { return Math.round(v * 255).toString(16).padStart(2, '0'); };
  return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}
function exportV2() {
  const j = toJSON();
  const px = [];
  const bars = j.bars || 2, bpb = j.beatsPerBar || 4;
  const total = bars * bpb;
  for (const trk of j.tracks) {
    if (trk.muted) continue;
    const hue = INSTR_HUE[trk.instrument] != null ? INSTR_HUE[trk.instrument] : 220;
    for (const key of trk.cells) {
      const p = String(key).split(',').map(Number);
      const r = p[0], s = p[1], len = p.length > 2 ? p[2] : 1;
      if (isNaN(r) || isNaN(s)) continue;
      // 长短 → 明度：len 1 最亮，越长越暗
      const L = Math.max(30, Math.min(86, 88 - (len || 1) * 6));
      const col = hslToHex(hue, 82, L);
      const npx = Math.max(1, Math.min(len || 1, total - s));
      for (let i = 0; i < npx; i++) px.push([s + i, r, col]);
    }
  }
  const out = { app: 'infinite-grid-canvas', version: 2, pixels: px };
  downloadBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), 'music-' + Date.now() + '-v2.json');
}

// ---------------- UI 绑定 ----------------
function bindToolbar() {
  $('me-btnPlay').addEventListener('click', togglePlay);
  $('me-btnStop').addEventListener('click', stopScheduler);

  const bpmN = $('me-bpm'), bpmR = $('me-bpmRange');
  bpmN.addEventListener('input', function () {
    state.bpm = clamp(parseInt(bpmN.value, 10) || 120, 40, 240);
    bpmR.value = state.bpm; saveSoon();
  });
  bpmR.addEventListener('input', function () {
    state.bpm = parseInt(bpmR.value, 10);
    bpmN.value = state.bpm; saveSoon();
  });

  const volN = $('me-vol'), volR = $('me-volRange');
  volN.addEventListener('input', function () {
    state.volume = clamp(parseInt(volN.value, 10) || 0, 0, 100);
    volR.value = state.volume; saveSoon();
  });
  volR.addEventListener('input', function () {
    state.volume = parseInt(volR.value, 10);
    volN.value = state.volume; saveSoon();
  });

  $('me-beatsPerBar').addEventListener('change', function () {
    state.beatsPerBar = parseInt(this.value, 10);
    rebuildTracks(); saveSoon();
  });
  $('me-bars').addEventListener('change', function () {
    state.bars = parseInt(this.value, 10);
    // 裁掉超出步数的音符
    const steps = totalSteps();
    for (const trk of state.tracks) {
      for (const key of trk.cells.keys()) {
        if (parseInt(key.split(',')[1], 10) >= steps) trk.cells.delete(key);
      }
    }
    rebuildTracks(); saveSoon();
  });

  const addSel = $('me-addInstr');
  for (const id of Object.keys(INSTRUMENTS)) {
    const op = document.createElement('option');
    op.value = id; op.textContent = INSTRUMENTS[id].name;
    addSel.appendChild(op);
  }
  $('me-btnAddTrack').addEventListener('click', function () {
    const id = addSel.value;
    const trk = makeTrack(id);
    state.tracks.push(trk);
    buildTrack(trk);
    trackEls.get(trk.id).grid.closest('.track').scrollIntoView({ block: 'nearest' });
    updateNoteCount(); saveSoon();
  });

  $('me-btnExportWav').addEventListener('click', exportWAV);
  $('me-btnExportJson').addEventListener('click', exportJSON);
  $('me-btnExportV2').addEventListener('click', exportV2);
  $('me-btnImportJson').addEventListener('click', function () { $('me-importFile').click(); });
  $('me-importFile').addEventListener('change', function () {
    const f = this.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        if (fromJSON(JSON.parse(reader.result))) {
          applyLoadedState();
          $('me-autoSaveHint').textContent = '✓ 已导入';
        } else {
          alert('不是有效的音乐编辑器工程文件');
        }
      } catch (e) { alert('导入失败：' + e.message); }
    };
    reader.readAsText(f);
    this.value = '';
  });
  $('me-btnClear').addEventListener('click', function () {
    if (!confirm('清空全部轨道？')) return;
    stopScheduler();
    state.tracks = [];
    rebuildTracks(); saveSoon();
  });

  document.addEventListener('keydown', function (e) { if (!mePanelOpen()) return;
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) {
      e.preventDefault();
      togglePlay();
    }
  });
}

function applyLoadedState() {
  $('me-bpm').value = state.bpm; $('me-bpmRange').value = state.bpm;
  $('me-vol').value = state.volume; $('me-volRange').value = state.volume;
  $('me-beatsPerBar').value = state.beatsPerBar;
  $('me-bars').value = state.bars;
  rebuildTracks();
}

function updateNoteCount() {
  let n = 0;
  for (const trk of state.tracks) n += trk.cells.size;
  $('me-noteCount').textContent = n;
  $('me-stepInfo').textContent = '0 / ' + totalSteps();
}

// ---------------- 初始化 ----------------
function loadSaved() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return fromJSON(JSON.parse(raw));
  } catch (e) { /* 忽略损坏数据 */ }
  return false;
}

function initDemo() {
  // 钢琴旋律（C 大调小乐句，2 小节 32 步；C4=row12，限 C4~B4 范围）
  const piano = makeTrack('piano', '旋律');
  const notes = [
    [12, 0], [16, 2], [19, 4], [17, 6],   // C4 E4 G4 F4
    [16, 8], [14, 10], [12, 12], [14, 14], // E4 D4 C4 D4
    [12, 16], [16, 18], [19, 20], [17, 22],
    [16, 24], [14, 26], [11, 28], [12, 30],
  ];
  for (const [r, s] of notes) piano.cells.set(r + ',' + s, true);
  state.tracks.push(piano);

  // 鼓组：4-on-floor
  const drums = makeTrack('drums', '鼓组');
  for (let s = 0; s < 32; s += 4) drums.cells.set('0,' + s, true);      // Kick
  for (let s = 4; s < 32; s += 8) drums.cells.set('1,' + s, true);      // Snare
  for (let s = 0; s < 32; s += 2) drums.cells.set('2,' + s, true);      // HiHat
  state.tracks.push(drums);
}

bindToolbar();
if (!loadSaved()) initDemo();
applyLoadedState();

})();