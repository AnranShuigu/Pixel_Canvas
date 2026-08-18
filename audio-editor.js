// ============ 音频编辑器（纯数学 DSP） ============
(function () {
'use strict';

function aePanelOpen() { var p = document.getElementById('audioEditorPanel'); return !!p && p.style.display !== 'none'; }
window.__aeOpen = function () { var p = document.getElementById('audioEditorPanel'); if (!p) return; p.style.display = 'flex'; if (typeof layout === 'function') { try { layout(); } catch (e) {} } };
window.__aeClose = function () { var p = document.getElementById('audioEditorPanel'); if (!p) return; p.style.display = 'none'; if (typeof stopAll === 'function') { try { stopAll(); } catch (e) {} } };
(function () { var cb = document.getElementById('ae-closeBtn'); if (cb) cb.addEventListener('click', window.__aeClose); })();
(function () { var ab = document.getElementById('me-btnAudioEditor'); if (ab) ab.addEventListener('click', function () { if (window.__meClose) window.__meClose(); if (window.__aeOpen) window.__aeOpen(); }); })();
(function () { var ab2 = document.getElementById('ae-btnImportSound');
if (ab2) ab2.addEventListener('click', function () {
  if (!samples || !samples.length) { alert('请先在音频编辑器中导入音频或生成物理建模声音。'); return; }
  var nm = prompt('声音名称（将出现在节点编辑器「声音」分类的「声音A」下拉中）', '音频编辑器声音');
  if (!nm || !nm.trim()) return;
  nm = nm.trim();
  if (typeof SOUND_LIB === 'undefined' || typeof getAudioCtx !== 'function') { alert('节点编辑器声音库不可用。'); return; }
  var ctx = getAudioCtx();
  var buf = ctx.createBuffer(1, samples.length, sampleRate);
  buf.getChannelData(0).set(samples);
  SOUND_LIB[nm] = { name: nm, buffer: buf, duration: buf.duration };
  if (renderSoundUI) renderSoundUI();
  if (renderNodeGraph) renderNodeGraph();
  alert('已将当前音频导入声音库「' + nm + '」（' + buf.duration.toFixed(1) + ' 秒）。\n可在节点编辑器「声音」分类节点的「声音A」下拉中选择。');
}); })();


const el = function (id) { return document.getElementById(id); };
const cv = el('waveCanvas'), wctx = cv.getContext('2d');
const scv = el('specCanvas'), sctx = scv.getContext('2d');
const mw = el('miniWave'), mwctx = mw.getContext('2d');
const ms = el('miniSpec'), msctx = ms.getContext('2d');
const mst = el('miniSTFT'), mstctx = mst.getContext('2d');

// ---------------- 布局状态 ----------------
let panelWidth = 300;        // 右侧面板宽度（dock 模式）
let mainSplit = 0.54;        // 主区波形占比（0~1）
let toolsDocked = true;      // true=dock 停靠，false=浮动
let toolsHidden = false;
let toolsFloatPos = null;    // {x, y} 浮动位置
let stftCache = null;        // 时频图缓存（样本变化时重算）
let lastAnalyzeT = 0;        // 分析区当前时间

// ---------------- 状态 ----------------
let samples = null;          // Float32Array 单声道
let sampleRate = 44100;
let aux = null;              // 第二段音频（混音 / 卷积）
let history = [];            // 撤销栈
let playing = false, playStart = 0, playOffset = 0, playToken = 0;
let audioCtx = null, srcNode = null;
let specMode = 'fft';        // 'fft' | 'stft'

let redoStack = [];            // 重做栈（编辑撤销后恢复）
function pushHistory() {
  if (!samples) return;
  history.push(samples.slice());
  if (history.length > 30) history.shift();
  redoStack.length = 0;        // 新编辑 → 清空重做
  el('ae-btnReset').disabled = false;
  if (typeof updateEditBtnUI === 'function') updateEditBtnUI();
}
function setSamples(newSamples, keepHistory) {
  samples = newSamples;
  stftCache = null; // 样本变化 → 时频图缓存失效
  if (!keepHistory) { history = []; el('ae-btnReset').disabled = true; }
  updateInfo();
  playOffset = 0;
  el('progressBar').value = 0;
  drawWave(null);
  drawSpec();
  updateAnalyze(0);
}
function updateInfo() {
  if (!samples) { el('info').textContent = '未加载音频'; return; }
  const dur = (samples.length / sampleRate).toFixed(2);
  const len = samples.length;
  let rms = 0, peak = 0;
  for (let i = 0; i < len; i++) { rms += samples[i] * samples[i]; if (Math.abs(samples[i]) > peak) peak = Math.abs(samples[i]); }
  rms = Math.sqrt(rms / len);
  el('info').textContent = '时长 ' + dur + 's · ' + len + ' 采样 · ' + (sampleRate / 1000).toFixed(1) + 'kHz · RMS ' + rms.toFixed(4) + ' · 峰值 ' + peak.toFixed(3);
}

// ---------------- DSP：FFT（迭代 radix-2） ----------------
function fft(re, im) {
  const n = re.length;
  // 位反转
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const ang = -2 * Math.PI / size;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += size) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const k = i + j + half;
        const tr = re[k] * cr - im[k] * ci;
        const ti = re[k] * ci + im[k] * cr;
        re[k] = re[i + j] - tr; im[k] = im[i + j] - ti;
        re[i + j] += tr; im[i + j] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}
function hannWindow(n) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1))); return w; }

// ---------------- STFT / iSTFT（重叠相加） ----------------
function stft(x, n, hop) {
  const win = hannWindow(n);
  const num = Math.max(1, Math.floor((x.length - n) / hop) + 1);
  const frames = [];
  for (let m = 0; m < num; m++) {
    const re = new Float32Array(n), im = new Float32Array(n);
    const off = m * hop;
    for (let i = 0; i < n; i++) re[i] = (off + i < x.length ? x[off + i] : 0) * win[i];
    fft(re, im);
    frames.push({ re: re, im: im, off: off });
  }
  return frames;
}
function istft(frames, n, hop, totalLen) {
  const win = hannWindow(n);
  const out = new Float32Array(totalLen || (frames.length * hop + n));
  const norm = new Float32Array(out.length);
  for (const f of frames) {
    const re = f.re.slice(), im = f.im.slice();
    ifft(re, im);
    for (let i = 0; i < n; i++) {
      const idx = f.off + i;
      if (idx >= out.length) break;
      out[idx] += re[i] * win[i];
      norm[idx] += win[i] * win[i];
    }
  }
  for (let i = 0; i < out.length; i++) if (norm[i] > 1e-8) out[i] /= norm[i];
  return out;
}
function normalize1(a) {
  let peak = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > peak) peak = Math.abs(a[i]);
  if (peak > 1e-9) { const s = 1 / peak; for (let i = 0; i < a.length; i++) a[i] *= s; }
}

// ---------------- 时域处理 ----------------
function applyVolume(f) {
  if (!samples) return;
  pushHistory();
  for (let i = 0; i < samples.length; i++) samples[i] *= f;
  setSamples(samples, true);
}
function applyFade(sec) {
  if (!samples) return;
  pushHistory();
  const n = Math.min(samples.length, Math.floor(sec * sampleRate));
  for (let i = 0; i < n; i++) samples[i] *= i / n;
  for (let i = 0; i < n && i < samples.length; i++) samples[samples.length - 1 - i] *= i / n;
  setSamples(samples, true);
}
function applySpeed(r) {
  if (!samples || r <= 0.01) return;
  pushHistory();
  const outLen = Math.max(1, Math.floor(samples.length / r));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * r;
    const i0 = Math.floor(pos), frac = pos - i0;
    out[i] = (i0 + 1 < samples.length) ? samples[i0] * (1 - frac) + samples[i0 + 1] * frac : samples[i0];
  }
  setSamples(out, true);
}
function applyReverse() {
  if (!samples) return;
  pushHistory();
  samples.reverse();
  setSamples(samples, true);
}
function applyNormalize() {
  if (!samples) return;
  pushHistory();
  normalize1(samples);
  setSamples(samples, true);
}
function applyMix() {
  if (!samples || !aux) { alert('请先导入第二段音频（📂 第二段）。'); return; }
  pushHistory();
  const n = Math.max(samples.length, aux.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i < samples.length ? samples[i] : 0;
    const b = i < aux.length ? aux[i] : 0;
    out[i] = (a + b) * 0.7;
  }
  normalize1(out);
  setSamples(out, true);
}
function applyGate(th) {
  if (!samples) return;
  pushHistory();
  const t = th;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) < t) samples[i] = 0;
  setSamples(samples, true);
}

// ---------------- 频域滤波（STFT 频域乘法 = 时域卷积） ----------------
function applyFreqFilter(kind, loHz, hiHz) {
  if (!samples) return;
  pushHistory();
  const n = 2048, hop = 512;
  const frames = stft(samples, n, hop);
  for (const f of frames) {
    for (let k = 0; k <= n / 2; k++) {
      const freq = k * sampleRate / n;
      let g = 1;
      if (kind === 'lp') g = freq <= loHz ? 1 : 0;
      else if (kind === 'hp') g = freq >= hiHz ? 1 : 0;
      else g = (freq >= loHz && freq <= hiHz) ? 1 : 0;
      f.re[k] *= g; f.im[k] *= g;
      if (k > 0 && k < n / 2) { f.re[n - k] *= g; f.im[n - k] *= g; }
    }
  }
  const out = istft(frames, n, hop, samples.length);
  setSamples(out, true);
}

// ---------------- FIR / IIR 滤波器（差分方程） ----------------
// FIR 低通/高通（窗函数法）：h[n] = sin(2πfc(n-M/2)) / (π(n-M/2)) × 窗
function firDesign(kind, cutoffHz, taps) {
  const fc = cutoffHz / sampleRate;
  const M = taps - 1, h = new Float32Array(taps);
  for (let n = 0; n < taps; n++) {
    const m = n - M / 2;
    let v;
    if (m === 0) v = 2 * fc;
    else v = Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    if (kind === 'hp') v = (n === M / 2 ? 1 - 2 * fc : -v);
    h[n] = v * (0.54 - 0.46 * Math.cos(2 * Math.PI * n / M));
  }
  let s = 0; for (let i = 0; i < taps; i++) s += h[i];
  if (Math.abs(s) > 1e-9) for (let i = 0; i < taps; i++) h[i] /= s;
  return h;
}
function applyFIR(kind, cutoffHz) {
  if (!samples) return;
  pushHistory();
  const taps = Math.max(9, Math.min(257, Math.round(8 * sampleRate / Math.max(50, cutoffHz))));
  const h = firDesign(kind, cutoffHz, taps);
  const out = new Float32Array(samples.length);
  for (let n = 0; n < samples.length; n++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const idx = n - k;
      if (idx >= 0) acc += h[k] * samples[idx];
    }
    out[n] = acc;
  }
  setSamples(out, true);
}
// IIR 一阶低通：y[n] = (1-a) x[n] + a y[n-1]；高通：y[n] = a(y[n-1] + x[n] - x[n-1])
function applyIIR(kind, cutoffHz) {
  if (!samples) return;
  pushHistory();
  const wc = 2 * Math.PI * cutoffHz / sampleRate;
  const a = Math.exp(-wc);
  const out = new Float32Array(samples.length);
  let y = 0, xPrev = 0;
  for (let n = 0; n < samples.length; n++) {
    const x = samples[n];
    if (kind === 'lp') y = (1 - a) * x + a * y;
    else y = a * (y + x - xPrev);
    out[n] = y;
    xPrev = x;
  }
  setSamples(out, true);
}

// ---------------- 卷积（FFT 卷积：时域卷积 = 频域乘积） ----------------
function applyConv(ir) {
  if (!samples || !ir) return;
  pushHistory();
  const a = samples, b = ir;
  const n = nextPow2(a.length + b.length - 1);
  const re = new Float32Array(n), im = new Float32Array(n);
  const re2 = new Float32Array(n), im2 = new Float32Array(n);
  re.set(a); re2.set(b);
  fft(re, im); fft(re2, im2);
  for (let i = 0; i < n; i++) {
    const tr = re[i] * re2[i] - im[i] * im2[i];
    const ti = re[i] * im2[i] + im[i] * re2[i];
    re[i] = tr; im[i] = ti;
  }
  ifft(re, im);
  const out = re.slice(0, a.length + b.length - 1);
  normalize1(out);
  setSamples(out, true);
}
function impulseReverb() {
  const ir = new Float32Array(sampleRate * 0.8);
  for (let i = 0; i < ir.length; i++) ir[i] = Math.exp(-i / (sampleRate * 0.25)) * (Math.random() * 2 - 1) * 0.5;
  return ir;
}
function impulseEcho() {
  const ir = new Float32Array(sampleRate * 0.3);
  ir[0] = 1;
  for (let d = 0.1; d < 0.3; d += 0.1) ir[Math.floor(d * sampleRate)] = 0.6;
  return ir;
}

// ---------------- 统计：自相关基频 / 频谱减法降噪 ----------------
function detectPitch() {
  if (!samples) return null;
  const seg = 2048;
  const x = samples.subarray(0, seg);
  const n = seg;
  // 中心化
  let mean = 0; for (let i = 0; i < n; i++) mean += x[i]; mean /= n;
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) energy[i] = (x[i] - mean) * (x[i] - mean);
  let e0 = 0; for (let i = 0; i < n; i++) e0 += energy[i];
  let bestLag = -1, bestScore = 0;
  const minLag = Math.floor(sampleRate / 2000), maxLag = Math.floor(sampleRate / 60);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0;
    for (let i = 0; i < n - lag; i++) r += (x[i] - mean) * (x[i + lag] - mean);
    const score = r / (e0 + 1e-9);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestScore < 0.1) return null;
  return { freq: sampleRate / bestLag, conf: bestScore };
}
// 频谱减法：从整段估计噪声（最低能量帧均值）并减去
function applySpectralSubtract() {
  if (!samples) return;
  pushHistory();
  const n = 2048, hop = 1024;
  const frames = stft(samples, n, hop);
  // 噪声估计：取幅度最低的 10% 帧的平均幅度
  const mags = frames.map(function (f) {
    let m = 0; for (let k = 0; k <= n / 2; k++) m += Math.abs(f.re[k]);
    return m;
  });
  const sorted = mags.slice().sort(function (a, b) { return a - b; });
  const noiseTh = sorted[Math.max(0, Math.floor(sorted.length * 0.1))];
  const noiseMag = new Float32Array(n / 2 + 1);
  let cnt = 0;
  for (let i = 0; i < frames.length; i++) {
    if (mags[i] > noiseTh) continue;
    cnt++;
    for (let k = 0; k <= n / 2; k++) noiseMag[k] += Math.abs(frames[i].re[k]);
  }
  if (cnt) for (let k = 0; k <= n / 2; k++) noiseMag[k] /= cnt;
  // 频谱减法（软掩膜）
  for (const f of frames) {
    for (let k = 0; k <= n / 2; k++) {
      const mag = Math.abs(f.re[k]);
      const est = Math.max(0, mag - 1.5 * noiseMag[k]);
      const g = mag > 1e-9 ? est / mag : 0;
      f.re[k] *= g; f.im[k] *= g;
      if (k > 0 && k < n / 2) { f.re[n - k] *= g; f.im[n - k] *= g; }
    }
  }
  const out = istft(frames, n, hop, samples.length);
  setSamples(out, true);
}

// ---------------- NMF 矩阵分解（Lee-Seung 乘法更新） ----------------
function nmfDecompose(V, k, iter) {
  // V: R×C 非负矩阵（幅度谱）→ W: R×k, H: k×C
  const R = V.length, C = V[0].length;
  const W = [], H = [];
  for (let i = 0; i < R; i++) { W.push([]); for (let j = 0; j < k; j++) W[i].push(Math.random() * 0.5 + 0.1); }
  for (let j = 0; j < k; j++) { H.push([]); for (let t = 0; t < C; t++) H[j].push(Math.random() * 0.5 + 0.1); }
  const eps = 1e-9;
  for (let it = 0; it < iter; it++) {
    // 更新 H：H = H ⊙ (Wᵀ V) / (Wᵀ W H)
    for (let j = 0; j < k; j++) {
      for (let t = 0; t < C; t++) {
        let num = 0, den = 0;
        for (let i = 0; i < R; i++) { num += W[i][j] * V[i][t]; }
        for (let i = 0; i < R; i++) {
          let rec = 0;
          for (let q = 0; q < k; q++) rec += W[i][q] * H[q][t];
          den += W[i][j] * rec;
        }
        H[j][t] *= num / (den + eps);
      }
    }
    // 更新 W：W = W ⊙ (V Hᵀ) / (W H Hᵀ)
    for (let i = 0; i < R; i++) {
      for (let j = 0; j < k; j++) {
        let num = 0, den = 0;
        for (let t = 0; t < C; t++) num += V[i][t] * H[j][t];
        for (let t = 0; t < C; t++) {
          let rec = 0;
          for (let q = 0; q < k; q++) rec += W[i][q] * H[q][t];
          den += rec * H[j][t];
        }
        W[i][j] *= num / (den + eps);
      }
    }
  }
  return { W: W, H: H };
}
function applyNMF(k) {
  if (!samples) return;
  pushHistory();
  const n = 1024, hop = 512;
  const frames = stft(samples, n, hop);
  const R = n / 2 + 1, C = Math.min(frames.length, 240);
  // 幅度谱矩阵（对数压缩）
  const V = [];
  for (let i = 0; i < R; i++) {
    V.push([]);
    for (let t = 0; t < C; t++) V[i].push(Math.abs(frames[t].re[i]) + 1e-9);
  }
  const { W, H } = nmfDecompose(V, k, 80);
  // 用原相位重合成每成分
  const outList = [];
  for (let c = 0; c < k; c++) {
    const cframes = frames.slice(0, C).map(function (f, t) {
      const re = new Float32Array(n), im = new Float32Array(n);
      for (let i = 0; i <= n / 2; i++) {
        const mag = W[i][c] * H[c][t];
        const ph = Math.atan2(f.im[i], f.re[i]);
        re[i] = mag * Math.cos(ph); im[i] = mag * Math.sin(ph);
        if (i > 0 && i < n / 2) { re[n - i] = mag * Math.cos(-ph); im[n - i] = mag * Math.sin(-ph); }
      }
      return { re: re, im: im, off: f.off };
    });
    const comp = istft(cframes, n, hop, samples.length);
    normalize1(comp);
    outList.push(comp);
  }
  return outList;
}

// 重采样：按新采样率线性插值（采样率越高采样点越多；时长不变，音高随采样率变化）
function resampleAudio(newRate) {
  if (!samples) return;
  if (newRate === sampleRate) { alert('已是该采样率。'); return; }
  pushHistory();
  const oldLen = samples.length;
  const newLen = Math.max(1, Math.round(oldLen * newRate / sampleRate));
  const out = new Float32Array(newLen);
  const ratio = sampleRate / newRate;
  for (let i = 0; i < newLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos), i1 = Math.min(oldLen - 1, i0 + 1);
    const f = pos - i0;
    out[i] = samples[i0] * (1 - f) + samples[i1] * f;
  }
  sampleRate = newRate;
  setSamples(out, true);
  el('sampleRateSel').value = String(newRate);
  updateInfo();
  alert('已重采样到 ' + newRate + 'Hz：' + oldLen + ' → ' + newLen + ' 个采样点。');
}
el('btnResample').addEventListener('click', function () {
  resampleAudio(parseInt(el('sampleRateSel').value, 10));
});

// ---------------- 播放 ----------------
function ensureCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// 音频 buffer 缓存（samples 引用变化时重建；拖动试听复用，避免频繁整段拷贝）
let srcBuffer = null, srcBufferRef = null;
function getSrcBuffer() {
  const ac = ensureCtx();
  if (!srcBuffer || srcBufferRef !== samples) {
    srcBuffer = ac.createBuffer(1, samples.length, sampleRate);
    srcBuffer.copyToChannel(samples, 0);
    srcBufferRef = samples;
  }
  return srcBuffer;
}
function play() {
  if (!samples) return;
  const ac = ensureCtx();
  stop();
  const buffer = getSrcBuffer();
  srcNode = ac.createBufferSource();
  srcNode.buffer = buffer;
  srcNode.connect(ac.destination);
  srcNode.start(0, playOffset);
  playing = true;
  playStart = ac.currentTime - playOffset;
  playToken++;
  el('btnPlay').textContent = '⏸ 暂停';
  requestAnimationFrame(playCursor);
}
function stop() {
  playing = false;
  if (srcNode) { try { srcNode.stop(); } catch (e) {} srcNode = null; }
  el('btnPlay').textContent = '▶ 播放';
}
function pause() {
  if (srcNode) { playOffset = audioCtx.currentTime - playStart; stop(); }
}
function playCursor() {
  if (!playing || !audioCtx || !samples) return;
  const pos = audioCtx.currentTime - playStart;
  if (pos >= samples.length / sampleRate) {
    if (loopPlay) {
      // 循环播放：从头继续
      playOffset = 0;
      drawWave(null);
      updateAnalyze(0);
      play();
    } else {
      stop();
      drawWave(null);
      updateAnalyze(0);
    }
    return;
  }
  drawWave(pos);
  updateAnalyze(pos);
  requestAnimationFrame(playCursor);
}

// ---------------- 面板视图缩放状态 ----------------
const views = {
  wave: { t0: 0, t1: null },   // 主波形时间范围（null = 整段）
  spec: { f0: 20, f1: null },  // 主频谱频率范围（对数轴，null = 默认 20Hz~20kHz/nyq）
  mWave: { half: 0.15 },       // 底部波形窗口半宽（秒）
  mSpec: { f0: 0, f1: null },  // 底部频谱频率范围（线性，null = 0~nyq）
  mSTFT: { t0: 0, t1: null },  // 底部时频图时间范围
};
let loopPlay = false;          // 循环播放开关
// 滚轮缩放绑定：鼠标在哪个面板上滚轮就缩放哪个面板（以鼠标位置为锚点）
function bindZoom(canvasId, zoomFn) {
  const c = el(canvasId);
  c.addEventListener('wheel', function (e) {
    e.preventDefault();
    const r = c.getBoundingClientRect();
    const k = e.deltaY < 0 ? 0.82 : 1.22; // 上滚放大
    zoomFn(Math.max(0, Math.min(r.width, e.clientX - r.left)), r.width, k);
  }, { passive: false });
}
// 主波形：时间轴缩放
function zoomWave(mx, W, k) {
  if (!samples) return;
  const dur = duration();
  let t0 = views.wave.t0, t1 = views.wave.t1 != null ? views.wave.t1 : dur;
  const ratio = Math.max(0, Math.min(1, W ? mx / W : 0));
  const anchor = t0 + (t1 - t0) * ratio;
  let nw = (t1 - t0) * k;
  nw = Math.max(0.005, Math.min(dur, nw));
  let nt0 = anchor - nw * ratio;
  nt0 = Math.max(0, Math.min(dur - nw, nt0));
  if (nw >= dur - 1e-9) { views.wave.t0 = 0; views.wave.t1 = null; }
  else { views.wave.t0 = nt0; views.wave.t1 = nt0 + nw; }
  drawWave(currentT());
  updateAnalyze(currentT());
}
// 主频谱：对数频率轴缩放
function zoomSpec(mx, W, k) {
  if (!samples) return;
  const nyq = sampleRate / 2;
  let f0 = views.spec.f0, f1 = views.spec.f1 != null ? views.spec.f1 : Math.min(nyq, 20000);
  const ratio = Math.max(0, Math.min(1, W ? mx / W : 0));
  const anchor = f0 * Math.pow(f1 / f0, ratio);
  const spanLog = Math.log(f1 / f0) * k;
  let nf0 = anchor / Math.exp(spanLog * ratio);
  let nf1 = anchor * Math.exp(spanLog * (1 - ratio));
  nf0 = Math.max(1, Math.min(nyq / 10, nf0));
  nf1 = Math.max(nf0 * 1.02, Math.min(nyq, nf1));
  if (f1 >= nyq - 1e-6 && f0 <= 20.001) { views.spec.f0 = 20; views.spec.f1 = null; }
  else { views.spec.f0 = nf0; views.spec.f1 = nf1; }
  drawSpec();
}
// 底部波形：窗口缩放
function zoomMWave(mx, W, k) {
  if (!samples) return;
  views.mWave.half = Math.max(0.003, Math.min(20, views.mWave.half * k));
  updateAnalyze(currentT());
}
// 底部频谱：线性频率轴缩放
function zoomMSpec(mx, W, k) {
  if (!samples) return;
  const nyq = sampleRate / 2;
  let f0 = views.mSpec.f0, f1 = views.mSpec.f1 != null ? views.mSpec.f1 : nyq;
  const ratio = Math.max(0, Math.min(1, W ? mx / W : 0));
  const anchor = f0 + (f1 - f0) * ratio;
  let nw = (f1 - f0) * k;
  nw = Math.max(10, Math.min(nyq, nw));
  let nf0 = anchor - nw * ratio;
  nf0 = Math.max(0, Math.min(nyq - nw, nf0));
  views.mSpec.f0 = nf0;
  views.mSpec.f1 = nf0 + nw;
  if (views.mSpec.f1 >= nyq - 1e-6 && views.mSpec.f0 <= 1e-6) { views.mSpec.f0 = 0; views.mSpec.f1 = null; }
  updateAnalyze(currentT());
}
// 底部时频图：时间轴缩放
function zoomMSTFT(mx, W, k) {
  if (!samples) return;
  const dur = duration();
  let t0 = views.mSTFT.t0, t1 = views.mSTFT.t1 != null ? views.mSTFT.t1 : dur;
  const ratio = Math.max(0, Math.min(1, W ? mx / W : 0));
  const anchor = t0 + (t1 - t0) * ratio;
  let nw = (t1 - t0) * k;
  nw = Math.max(0.01, Math.min(dur, nw));
  let nt0 = anchor - nw * ratio;
  nt0 = Math.max(0, Math.min(dur - nw, nt0));
  if (nw >= dur - 1e-9) { views.mSTFT.t0 = 0; views.mSTFT.t1 = null; }
  else { views.mSTFT.t0 = nt0; views.mSTFT.t1 = nt0 + nw; }
  updateAnalyze(currentT());
}
bindZoom('waveCanvas', zoomWave);
bindZoom('specCanvas', zoomSpec);
bindZoom('miniWave', zoomMWave);
bindZoom('miniSpec', zoomMSpec);
bindZoom('miniSTFT', zoomMSTFT);
// 左键拖动平移（放大后可拖动查看窗口外区域；整段视图不可平移）
function bindPan(canvasId, panFn) {
  const c = el(canvasId);
  let pan = null;
  c.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    pan = { x: e.clientX };
    if (c.setPointerCapture) { try { c.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
  });
  c.addEventListener('pointermove', function (e) {
    if (!pan) return;
    const r = c.getBoundingClientRect();
    const dx = e.clientX - pan.x;
    pan.x = e.clientX;
    if (dx !== 0) panFn(dx, Math.max(1, r.width));
  });
  c.addEventListener('pointerup', function () { pan = null; });
  c.addEventListener('pointercancel', function () { pan = null; });
}
// 时间线拖动（波形 / 时频图面板）：按住黄色时间线可拖动定位（不播放，停在移动点，与底部时间进度条联动）；
// 按住非时间线区域 = 平移视图
function bindWavePanel(canvasId, panFn, timeToXRatio, xRatioToTime) {
  const c = el(canvasId);
  let mode = null, pan = null;
  c.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left;
    let lineX = null;
    if (samples) {
      const cur = currentT();
      if (cur >= 0 && cur <= duration()) lineX = timeToXRatio(cur) * r.width;
    }
    if (lineX != null && Math.abs(x - lineX) < 14) {
      mode = 'line';
      if (playing) pause();
      c.classList.add('drag');
      // 用户手势中激活 AudioContext（供后续手动播放用）
      if (samples && !audioCtx) { try { ensureCtx(); } catch (e) { /* 忽略 */ } }
      if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) { /* 忽略 */ } }
      return;
    }
    mode = 'pan';
    pan = { x: e.clientX };
    if (c.setPointerCapture) { try { c.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
  });
  c.addEventListener('pointermove', function (e) {
    if (!mode) return;
    const r = c.getBoundingClientRect();
    if (mode === 'pan') {
      const dx = e.clientX - pan.x;
      pan.x = e.clientX;
      if (dx !== 0) panFn(dx, Math.max(1, r.width));
    } else {
      const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
      playOffset = Math.max(0, Math.min(duration(), xRatioToTime(x / Math.max(1, r.width))));
      // 只定位不播放，与底部时间进度条对齐
      el('progressBar').value = Math.round(playOffset / (duration() || 1) * 1000);
      el('timeCur').textContent = fmtTime(playOffset);
      drawWave(currentT());
      updateAnalyze(currentT());
    }
  });
  function end(e) {
    if (mode === 'line') {
      c.classList.remove('drag');
      // 停在移动到的位置，不自动播放
      stop();
      drawWave(playOffset);
      updateAnalyze(playOffset);
    }
    mode = null;
    pan = null;
  }
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}
// 主波形 / 时频图：时间线比例与反变换（基于各自视图窗口）
function waveTimeToXRatio(t) {
  const dur = duration();
  const t0 = views.wave.t0, t1 = views.wave.t1 != null ? views.wave.t1 : dur;
  return (t - t0) / Math.max(1e-9, t1 - t0);
}
function waveXRatioToTime(ratio) {
  const dur = duration();
  const t0 = views.wave.t0, t1 = views.wave.t1 != null ? views.wave.t1 : dur;
  return t0 + (t1 - t0) * ratio;
}
function stftTimeToXRatio(t) {
  const dur = duration();
  const t0 = views.mSTFT.t0, t1 = views.mSTFT.t1 != null ? views.mSTFT.t1 : dur;
  return (t - t0) / Math.max(1e-9, t1 - t0);
}
function stftXRatioToTime(ratio) {
  const dur = duration();
  const t0 = views.mSTFT.t0, t1 = views.mSTFT.t1 != null ? views.mSTFT.t1 : dur;
  return t0 + (t1 - t0) * ratio;
}
bindWavePanel('waveCanvas', panWave, waveTimeToXRatio, waveXRatioToTime);
bindWavePanel('miniSTFT', panMSTFT, stftTimeToXRatio, stftXRatioToTime);
bindPan('miniWave', panMWave);
bindPan('miniSpec', panMSpec);
function panWave(dx, W) {
  if (!samples) return;
  const dur = duration();
  let t0 = views.wave.t0, t1 = views.wave.t1 != null ? views.wave.t1 : dur;
  const span = t1 - t0;
  if (span >= dur - 1e-9) return; // 整段不可平移
  let nt0 = t0 - dx / W * span;
  nt0 = Math.max(0, Math.min(dur - span, nt0));
  views.wave.t0 = nt0; views.wave.t1 = nt0 + span;
  drawWave(currentT());
  updateAnalyze(currentT());
}
function panSpec(dx, W) {
  if (!samples) return;
  const nyq = sampleRate / 2;
  let f0 = views.spec.f0, f1 = views.spec.f1 != null ? views.spec.f1 : Math.min(nyq, 20000);
  if (f1 >= nyq - 1e-6 && f0 <= 20.001) return; // 全范围不可平移
  const spanR = Math.log(f1 / f0);
  const shift = -dx / W * spanR;
  let nf0 = f0 * Math.exp(shift), nf1 = f1 * Math.exp(shift);
  if (nf0 < 1) { nf1 *= 1 / nf0; nf0 = 1; }
  if (nf1 > nyq) { nf0 *= nyq / nf1; nf1 = nyq; }
  views.spec.f0 = nf0; views.spec.f1 = nf1;
  drawSpec();
}
function panMSpec(dx, W) {
  if (!samples) return;
  const nyq = sampleRate / 2;
  let f0 = views.mSpec.f0, f1 = views.mSpec.f1 != null ? views.mSpec.f1 : nyq;
  if (f1 >= nyq - 1e-6 && f0 <= 1e-6) return;
  const span = f1 - f0;
  let nf0 = f0 - dx / W * span;
  nf0 = Math.max(0, Math.min(nyq - span, nf0));
  views.mSpec.f0 = nf0; views.mSpec.f1 = nf0 + span;
  updateAnalyze(currentT());
}
// 底部波形：窗口中心平移（null = 跟随播放 / 进度位置）
let miniWaveCenter = null;
function panMWave(dx, W) {
  if (!samples) return;
  const dur = duration();
  const win = views.mWave.half;
  if (miniWaveCenter == null) miniWaveCenter = lastAnalyzeT;
  let c = miniWaveCenter - dx / W * win * 2;
  miniWaveCenter = Math.max(0, Math.min(dur, c));
  drawMiniWave(miniWaveCenter);
  el('miniWave').dispatchEvent(new CustomEvent('mini-pan'));
}
function panMSTFT(dx, W) {
  if (!samples) return;
  const dur = duration();
  let t0 = views.mSTFT.t0, t1 = views.mSTFT.t1 != null ? views.mSTFT.t1 : dur;
  const span = t1 - t0;
  if (span >= dur - 1e-9) return;
  let nt0 = t0 - dx / W * span;
  nt0 = Math.max(0, Math.min(dur - span, nt0));
  views.mSTFT.t0 = nt0; views.mSTFT.t1 = nt0 + span;
  updateAnalyze(currentT());
}
// 双击底部波形：恢复跟随播放 / 进度
el('miniWave').addEventListener('dblclick', function () {
  miniWaveCenter = null;
  updateAnalyze(currentT());
});
// 回到默认状态：重置所有视图缩放 + 布局
function resetViews() {
  views.wave = { t0: 0, t1: null };
  views.spec = { f0: 20, f1: null };
  views.mWave = { half: 0.15 };
  views.mSpec = { f0: 0, f1: null };
  views.mSTFT = { t0: 0, t1: null };
  miniWaveCenter = null;
  mainSplit = 0.54; anaS1 = 34; anaS2 = 33; panelWidth = 300;
  bottomAreaH = 210;
  try { localStorage.setItem(AREA_KEY, '210'); } catch (e2) { /* 忽略 */ }
  toolsDocked = true; toolsHidden = false;
  for (const d of PANEL_DEFS) { panels[d.id].visible = true; panels[d.id].docked = true; }
  layout();
  renderPanelList();
  drawWave(null); drawSpec(); updateAnalyze(currentT());
}
el('btnResetView').addEventListener('click', resetViews);
// 循环播放
el('btnLoop').addEventListener('click', function () {
  loopPlay = !loopPlay;
  this.classList.toggle('active', loopPlay);
  this.title = loopPlay ? '循环播放：开（再次点击关闭）' : '循环播放：关';
});
el('btnLoop').classList.toggle('active', loopPlay);

// ---------------- 绘制 ----------------
function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}
function duration() { return samples ? samples.length / sampleRate : 0; }
function currentT() {
  if (playing && audioCtx) return audioCtx.currentTime - playStart;
  return playOffset;
}
// 布局：控制面板 dock/浮动 + 各面板停靠/浮动/隐藏（底部进度条+分析区高度可调）
let bottomAreaH = 210; // 底部区（时间条 + 分析区）高度，可拖动调整（120~420）
const AREA_KEY = 'audio-editor-area-h';
function layout() {
  const ma = el('mainArea');
  ma.style.right = toolsDocked && !toolsHidden ? (panelWidth + 16) + 'px' : '0px';
  ma.style.bottom = (bottomAreaH + 6) + 'px';
  el('bottomArea').style.height = bottomAreaH + 'px';
  el('vAreaSplitter').style.bottom = bottomAreaH + 'px';
  const tools = el('tools');
  tools.style.display = toolsHidden ? 'none' : '';
  if (toolsDocked) {
    tools.classList.remove('float');
    tools.style.right = '10px';
    tools.style.top = '56px';
    tools.style.bottom = (bottomAreaH + 10) + 'px';
    tools.style.left = 'auto';
    tools.style.height = 'auto';
  } else {
    tools.classList.add('float');
    if (!toolsFloatPos) {
      const ma2 = el('mainArea').getBoundingClientRect();
      toolsFloatPos = { x: Math.max(20, ma2.left + 40), y: 90 };
    }
    tools.style.left = toolsFloatPos.x + 'px';
    tools.style.top = toolsFloatPos.y + 'px';
    tools.style.right = 'auto';
    tools.style.bottom = 'auto';
    tools.style.height = '480px';
  }
  const vs = el('vSplitter');
  vs.style.display = (toolsDocked && !toolsHidden) ? 'block' : 'none';
  vs.style.right = (panelWidth + 6) + 'px';
  vs.style.bottom = (bottomAreaH + 10) + 'px';
  applyPanelLayout();
  resizeCanvases();
}
// ---------------- 通用面板系统：每个面板可停靠 / 浮动 / 隐藏 ----------------
const PANEL_DEFS = [
  { id: 'wave', title: '波形（主）', container: 'mainArea' },
  { id: 'spec', title: '频谱（主）', container: 'mainArea' },
  { id: 'mWave', title: '波形（当前时间）', container: 'analyzeWrap' },
  { id: 'mSpec', title: '频谱（当前帧）', container: 'analyzeWrap' },
  { id: 'mSTFT', title: '时频图', container: 'analyzeWrap' },
];
// 停靠容器内固定顺序（浮动移出后停靠时按此重排，空缺自动由其余面板填充）
const PANEL_ORDER = {
  mainArea: ['pane-wave', 'hSplitter', 'pane-spec'],
  analyzeWrap: ['pane-mWave', 'anaSplit1', 'pane-mSpec', 'anaSplit2', 'pane-mSTFT'],
};
const panels = {};
for (const d of PANEL_DEFS) panels[d.id] = { visible: true, docked: true, pos: null };
let anaS1 = 34, anaS2 = 33; // 底部分析区前两个面板宽度（%），第三个自动填满
function applyPanelLayout() {
  for (const d of PANEL_DEFS) {
    const pane = document.getElementById('pane-' + d.id);
    const st = panels[d.id];
    if (!st.docked) {
      // 浮动：移出容器 → body，fixed 定位可拖
      if (pane.parentElement !== document.body) document.body.appendChild(pane);
      pane.classList.add('float');
      pane.style.display = st.visible ? '' : 'none';
      if (!st.pos) {
        const ma = el('mainArea').getBoundingClientRect();
        st.pos = { x: Math.max(10, ma.left + 30 + Math.random() * 60), y: 120 + Math.random() * 40 };
      }
      pane.style.left = st.pos.x + 'px';
      pane.style.top = st.pos.y + 'px';
      pane.style.width = '460px';
      pane.style.height = '280px';
    } else {
      // 停靠：放回容器并按固定顺序重排
      pane.classList.remove('float');
      pane.style.left = 'auto'; pane.style.top = 'auto';
      pane.style.width = 'auto'; pane.style.height = 'auto';
      pane.style.display = st.visible ? '' : 'none';
      const container = document.getElementById(d.container);
      if (pane.parentElement !== container) container.appendChild(pane);
      reorderContainer(container, PANEL_ORDER[d.container]);
    }
  }
  // 停靠面板的比例分配
  if (panels.wave.docked && panels.spec.docked && panels.wave.visible && panels.spec.visible) {
    document.getElementById('pane-wave').style.flex = '0 0 ' + (mainSplit * 100) + '%';
    document.getElementById('pane-spec').style.flex = '1 1 0';
    el('hSplitter').style.display = '';
  } else {
    el('hSplitter').style.display = 'none';
    const anyWave = panels.wave.visible && panels.wave.docked;
    const anySpec = panels.spec.visible && panels.spec.docked;
    const wave = document.getElementById('pane-wave'), spec = document.getElementById('pane-spec');
    wave.style.flex = anyWave && !anySpec ? '1 1 0' : '0 0 ' + (mainSplit * 100) + '%';
    spec.style.flex = anySpec && !anyWave ? '1 1 0' : '1 1 0';
  }
  // 底部三个面板比例 + 手柄显示
  const mw = panels.mWave, ms2 = panels.mSpec, mt = panels.mSTFT;
  const mwOn = mw.visible && mw.docked, msOn = ms2.visible && ms2.docked, mtOn = mt.visible && mt.docked;
  const s1 = document.getElementById('pane-mWave'), s2 = document.getElementById('pane-mSpec'), s3 = document.getElementById('pane-mSTFT');
  s1.style.flex = mwOn && !(msOn || mtOn) ? '1 1 0' : '0 0 ' + anaS1 + '%';
  s2.style.flex = msOn && !(mwOn || mtOn) ? '1 1 0' : '0 0 ' + anaS2 + '%';
  s3.style.flex = '1 1 0';
  el('anaSplit1').style.display = (mwOn && msOn) ? '' : 'none';
  el('anaSplit2').style.display = (msOn && mtOn) ? '' : 'none';
}
function reorderContainer(container, order) {
  for (const id of order) {
    const c = document.getElementById(id);
    // 只重排已在容器内的元素；浮动中的面板保持在 body
    if (c && c.parentElement === container) container.appendChild(c);
  }
}
// 控制面板内「面板管理」列表
function renderPanelList() {
  const box = el('panelList');
  box.innerHTML = '';
  const rows = PANEL_DEFS.concat([{ id: 'tools', title: '控制面板', container: null }]);
  for (const d of rows) {
    const row = document.createElement('div');
    row.className = 'plist-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const st = d.id === 'tools' ? { visible: !toolsHidden } : panels[d.id];
    cb.checked = st.visible;
    cb.addEventListener('change', function () {
      if (d.id === 'tools') setToolsHidden(!cb.checked);
      else { panels[d.id].visible = cb.checked; applyPanelLayout(); resizeCanvases(); }
    });
    const lb = document.createElement('label');
    lb.textContent = d.title;
    lb.addEventListener('click', function () { cb.click(); });
    const ft = document.createElement('button');
    if (d.id === 'tools') {
      ft.textContent = toolsDocked ? '🪟' : '⛶';
      ft.title = '浮动 / 停靠';
      ft.addEventListener('click', function () { toolsDocked = !toolsDocked; layout(); renderPanelList(); });
    } else {
      ft.textContent = panels[d.id].docked ? '🪟' : '⛶';
      ft.title = '浮动 / 停靠';
      ft.classList.toggle('on', !panels[d.id].docked);
      ft.addEventListener('click', function () {
        panels[d.id].docked = !panels[d.id].docked;
        applyPanelLayout(); resizeCanvases(); renderPanelList();
      });
    }
    row.appendChild(cb); row.appendChild(lb); row.appendChild(ft);
    box.appendChild(row);
  }
}
// 面板头部通用绑定：🪟 浮动 / ✕ 隐藏 / 拖动移动（浮动时）
function bindPaneHead(paneId, d) {
  const pane = document.getElementById('pane-' + paneId);
  const head = pane.querySelector('.pane-head');
  const st = panels[d.id];
  head.querySelector('[data-act=float]').addEventListener('click', function () {
    st.docked = !st.docked;
    applyPanelLayout(); resizeCanvases(); renderPanelList();
  });
  head.querySelector('[data-act=close]').addEventListener('click', function () {
    st.visible = false;
    applyPanelLayout(); resizeCanvases(); renderPanelList();
  });
  head.addEventListener('pointerdown', function (e) {
    if (e.target.tagName === 'BUTTON') return;
    if (st.docked) return; // 停靠时标题不移动
    e.preventDefault();
    head.classList.add('drag');
    const sx = st.pos.x, sy = st.pos.y;
    const ox = e.clientX, oy = e.clientY;
    function move(ev) {
      st.pos = { x: sx + (ev.clientX - ox), y: sy + (ev.clientY - oy) };
      pane.style.left = st.pos.x + 'px';
      pane.style.top = st.pos.y + 'px';
    }
    function up() {
      head.classList.remove('drag');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    }
    document.addEventListener('pointermove', function (e) { if (!aePanelOpen()) return; move(e); });
    document.addEventListener('pointerup', function (e) { if (!aePanelOpen()) return; up(e); });
  });
}
for (const d of PANEL_DEFS) bindPaneHead(d.id, d);

function resizeCanvases() {
  const fit = function (cid) {
    const c = document.getElementById(cid);
    if (!c) return;
    const r = c.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    c.width = Math.max(50, Math.round(r.width));
    c.height = Math.max(40, Math.round(r.height));
  };
  fit('waveCanvas'); fit('specCanvas'); fit('miniWave'); fit('miniSpec'); fit('miniSTFT');
  drawWave(playing && audioCtx ? currentT() : null);
  drawSpec();
  updateAnalyze(currentT());
}
function drawWave(cursor) {
  const W = cv.width, H = cv.height;
  wctx.fillStyle = '#10131b';
  wctx.fillRect(0, 0, W, H);
  wctx.strokeStyle = '#2c313d'; wctx.lineWidth = 1;
  wctx.beginPath();
  wctx.moveTo(0, H / 2); wctx.lineTo(W, H / 2);
  wctx.stroke();
  if (!samples) {
    wctx.fillStyle = '#64748b'; wctx.font = '14px system-ui';
    wctx.textAlign = 'center';
    wctx.fillText('导入音频以显示波形（📂 导入音频）', W / 2, H / 2 - 10);
    return;
  }
  const dur = samples.length / sampleRate;
  const t0 = views.wave.t0, t1 = views.wave.t1 != null ? views.wave.t1 : dur;
  const span = Math.max(1e-6, t1 - t0);
  const i0 = Math.max(0, Math.floor(t0 * sampleRate));
  const i1 = Math.min(samples.length, Math.ceil(t1 * sampleRate));
  if (i1 - i0 < 2) return;
  const buckets = Math.max(2, Math.floor(W / 2));
  const step = Math.max(1, Math.floor((i1 - i0) / buckets));
  wctx.strokeStyle = '#3b82f6';
  wctx.lineWidth = 1;
  wctx.beginPath();
  for (let b = 0; b < buckets; b++) {
    const is = i0 + b * step, ie = Math.min(i1, is + step);
    let mn = 1, mx = -1;
    for (let i = is; i < ie; i++) { const v = samples[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const x = b / buckets * W;
    const y1 = H / 2 - mn * H * 0.45, y2 = H / 2 - mx * H * 0.45;
    wctx.moveTo(x, y1); wctx.lineTo(x, y2);
  }
  wctx.stroke();
  // 时间刻度（缩放时显示窗口起止）
  wctx.fillStyle = 'rgba(148,163,184,.6)';
  wctx.font = '10px ui-monospace, Consolas, monospace';
  wctx.fillText(fmtTime(t0), 4, H - 4);
  wctx.textAlign = 'right';
  wctx.fillText(fmtTime(t1), W - 4, H - 4);
  wctx.textAlign = 'left';
  if (cursor !== null && cursor >= 0 && cursor >= t0 && cursor <= t1) {
    const x = (cursor - t0) / span * W;
    wctx.strokeStyle = '#f59e0b'; wctx.lineWidth = 2;
    wctx.beginPath(); wctx.moveTo(x, 0); wctx.lineTo(x, H); wctx.stroke();
  }
}
function drawSpec() {
  const W = scv.width, H = scv.height;
  sctx.fillStyle = '#0d1017';
  sctx.fillRect(0, 0, W, H);
  if (!samples) {
    sctx.fillStyle = '#64748b'; sctx.font = '14px system-ui'; sctx.textAlign = 'center';
    sctx.fillText('频谱显示（📊 FFT 分析 / STFT 频谱图）', W / 2, H / 2);
    return;
  }
  if (specMode === 'fft') drawFFT(W, H);
  else drawSTFT(W, H);
}
function drawFFT(W, H) {
  const n = 2048;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = i < samples.length ? samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))) : 0;
  fft(re, im);
  const half = n / 2;
  // 对数频率轴（可滚轮缩放）：默认 20Hz ~ min(nyq, 20kHz)
  const nyq = sampleRate / 2;
  const f0 = views.spec.f0, f1 = views.spec.f1 != null ? views.spec.f1 : Math.min(nyq, 20000);
  const dB = [];
  for (let i = 0; i < half; i++) dB.push(20 * Math.log10(Math.hypot(re[i], im[i]) + 1e-9));
  const maxDb = Math.max.apply(null, dB), minDb = maxDb - 80;
  const curve = function () {
    sctx.beginPath();
    for (let x = 0; x < W; x++) {
      const freq = f0 * Math.pow(f1 / f0, x / W);
      const bin = Math.floor(freq / sampleRate * n);
      const v = 1 - (dB[bin] - minDb) / (maxDb - minDb);
      const y = v * (H - 2) + 1;
      if (x === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
    }
  };
  sctx.fillStyle = 'rgba(59,130,246,.9)';
  curve();
  sctx.lineTo(W, H); sctx.lineTo(0, H); sctx.closePath();
  sctx.fill();
  sctx.strokeStyle = '#3b82f6'; sctx.lineWidth = 1.5;
  curve();
  sctx.stroke();
  sctx.fillStyle = 'rgba(255,255,255,.6)';
  sctx.font = '10px system-ui'; sctx.textAlign = 'left';
  sctx.fillText(f0 < 1000 ? f0 + 'Hz' : (f0 / 1000).toFixed(1) + 'kHz', 4, H - 4);
  sctx.textAlign = 'right';
  sctx.fillText(f1 < 1000 ? f1 + 'Hz' : (f1 / 1000).toFixed(1) + 'kHz', W - 4, H - 4);
  sctx.textAlign = 'center';
  sctx.fillText('FFT 频谱（对数频率轴 · 滚轮缩放）', W / 2, 12);
}
function drawSTFT(W, H) {
  const n = 1024, hop = 512;
  const frames = stft(samples, n, hop);
  const rows = n / 2, cols = Math.min(frames.length, Math.floor(W));
  const minF = 20, maxF = Math.min(sampleRate / 2, 12000);
  // 预计算每列最大
  const colMax = new Float32Array(cols);
  for (let t = 0; t < cols; t++) {
    let mx = 1e-9;
    for (let k = 0; k < rows; k++) {
      const freq = k * sampleRate / n;
      if (freq < minF) continue;
      const v = Math.hypot(frames[t].re[k], frames[t].im[k]);
      if (v > mx) mx = v;
    }
    colMax[t] = mx;
  }
  const img = sctx.createImageData(W, H);
  const data = img.data;
  for (let y = 0; y < H; y++) {
    const freq = maxF * Math.pow(minF / maxF, y / H);
    const k = Math.floor(freq / sampleRate * n);
    for (let x = 0; x < W; x++) {
      const t = Math.floor(x / W * cols);
      const v = Math.hypot(frames[t].re[k], frames[t].im[k]) / (colMax[t] + 1e-9);
      const i = (y * W + x) * 4;
      const heat = Math.pow(Math.min(1, v), 0.5);
      data[i] = Math.floor(heat * 255);
      data[i + 1] = Math.floor(heat * 255 * 0.4);
      data[i + 2] = Math.floor(heat * 255 * 0.05);
      data[i + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);
  sctx.fillStyle = 'rgba(255,255,255,.7)';
  sctx.font = '11px system-ui';
  sctx.fillText('STFT 时频图（X=时间，Y=频率，颜色=能量）', 6, 12);
}

// ---------------- 底部分析区：波形 / 频谱 / 时频图（特定时间） ----------------
function updateAnalyze(t) {
  if (!samples) { clearMini(); return; }
  lastAnalyzeT = t;
  drawMiniWave(t);
  drawMiniSpec(t);
  drawMiniSTFT(t);
  // 进度条与时间
  const dur = duration();
  el('progressBar').value = Math.round(Math.max(0, Math.min(1, t / (dur || 1))) * 1000);
  el('timeCur').textContent = fmtTime(t);
  el('timeTot').textContent = fmtTime(dur);
}
function clearMini() {
  mwctx.clearRect(0, 0, mw.width, mw.height);
  msctx.clearRect(0, 0, ms.width, ms.height);
  mstctx.clearRect(0, 0, mst.width, mst.height);
  el('timeCur').textContent = '0:00.0';
  el('timeTot').textContent = '0:00.0';
}
function drawMiniWave(t) {
  const W = mw.width, H = mw.height;
  // 标题跟随缩放显示实际窗口大小
  const title = el('mWaveTitle');
  if (title) title.textContent = '🌊 波形（当前时间 ±' + (views.mWave.half < 0.01 ? views.mWave.half.toFixed(4) : views.mWave.half.toFixed(3)) + 's）';
  mwctx.fillStyle = '#10131b';
  mwctx.fillRect(0, 0, W, H);
  mwctx.strokeStyle = '#2c313d'; mwctx.lineWidth = 1;
  mwctx.beginPath(); mwctx.moveTo(0, H / 2); mwctx.lineTo(W, H / 2); mwctx.stroke();
  const win = views.mWave.half; // ±窗口半宽（秒，可滚轮缩放）
  const ct = miniWaveCenter != null ? miniWaveCenter : t; // 拖动平移后显示用户位置
  const half = win * sampleRate;
  const c0 = Math.max(0, Math.floor(ct * sampleRate - half));
  const c1 = Math.min(samples.length, Math.ceil(ct * sampleRate + half));
  if (c1 - c0 < 2) return;
  const buckets = Math.max(2, Math.floor(W / 2));
  const step = Math.max(1, Math.floor((c1 - c0) / buckets));
  mwctx.strokeStyle = '#3b82f6';
  mwctx.beginPath();
  for (let b = 0; b < buckets; b++) {
    const i0 = c0 + b * step, i1 = Math.min(c1, i0 + step);
    let mn = 1, mx = -1;
    for (let i = i0; i < i1; i++) { const v = samples[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const x = b / buckets * W;
    mwctx.moveTo(x, H / 2 - mn * H * 0.45); mwctx.lineTo(x, H / 2 - mx * H * 0.45);
  }
  mwctx.stroke();
  mwctx.fillStyle = 'rgba(255,255,255,.55)'; mwctx.font = '10px system-ui';
  mwctx.fillText('t=' + ct.toFixed(2) + 's', 6, H - 4);
}
function drawMiniSpec(t) {
  const W = ms.width, H = ms.height;
  msctx.fillStyle = '#10131b';
  msctx.fillRect(0, 0, W, H);
  const n = 2048;
  const c0 = Math.max(0, Math.floor(t * sampleRate - n / 2));
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const idx = c0 + i;
    re[i] = (idx < samples.length ? samples[idx] : 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
  }
  fft(re, im);
  const half = n / 2;
  const dB = [];
  let maxDb = -Infinity;
  for (let i = 1; i < half; i++) {
    const d = 20 * Math.log10(Math.hypot(re[i], im[i]) + 1e-9);
    dB.push(d); if (d > maxDb) maxDb = d;
  }
  if (!isFinite(maxDb)) maxDb = -40;
  const minDb = maxDb - 70;
  const nyq = sampleRate / 2;
  const f0 = views.mSpec.f0, f1 = views.mSpec.f1 != null ? views.mSpec.f1 : nyq;
  const fSpan = Math.max(1, f1 - f0);
  msctx.strokeStyle = '#4cd964';
  msctx.beginPath();
  for (let x = 0; x < W; x++) {
    const freq = f0 + fSpan * x / W;
    const bin = Math.max(1, Math.min(half - 1, Math.floor(freq / sampleRate * n)));
    const v = 1 - (dB[bin - 1] - minDb) / (maxDb - minDb);
    const y = v * (H - 2) + 1;
    if (x === 0) msctx.moveTo(x, y); else msctx.lineTo(x, y);
  }
  msctx.stroke();
  msctx.fillStyle = 'rgba(255,255,255,.55)'; msctx.font = '10px system-ui';
  msctx.fillText(f0 < 1000 ? f0 + 'Hz' : (f0 / 1000).toFixed(0) + 'kHz', 4, H - 4);
  msctx.textAlign = 'right';
  msctx.fillText(f1 < 1000 ? f1 + 'Hz' : (f1 / 1000).toFixed(0) + 'kHz', W - 4, H - 4);
  msctx.textAlign = 'left';
}
function drawMiniSTFT(t) {
  const W = mst.width, H = mst.height;
  mstctx.fillStyle = '#10131b';
  mstctx.fillRect(0, 0, W, H);
  if (!samples) return;
  if (!stftCache) stftCache = stft(samples, 1024, 512);
  const frames = stftCache;
  const rows = 512, cols = frames.length;
  const minF = 20, maxF = Math.min(sampleRate / 2, 12000);
  const dur = duration();
  const vt0 = views.mSTFT.t0, vt1 = views.mSTFT.t1 != null ? views.mSTFT.t1 : dur;
  const vspan = Math.max(1e-6, vt1 - vt0);
  const colMax = new Float32Array(cols);
  for (let t2 = 0; t2 < cols; t2++) {
    let mx = 1e-9;
    for (let k = 1; k < rows; k++) {
      const freq = k * sampleRate / 1024;
      if (freq < minF || freq > maxF) continue;
      const v = Math.hypot(frames[t2].re[k], frames[t2].im[k]);
      if (v > mx) mx = v;
    }
    colMax[t2] = mx;
  }
  const img = mstctx.createImageData(W, H);
  const data = img.data;
  for (let y = 0; y < H; y++) {
    const freq = maxF * Math.pow(minF / maxF, y / H);
    const k = Math.floor(freq / sampleRate * 1024);
    for (let x = 0; x < W; x++) {
      const time = vt0 + x / W * vspan;
      const f2 = Math.min(cols - 1, Math.max(0, Math.floor(time / dur * cols)));
      const v = Math.hypot(frames[f2].re[k], frames[f2].im[k]) / (colMax[f2] + 1e-9);
      const i = (y * W + x) * 4;
      const heat = Math.pow(Math.min(1, v), 0.5);
      data[i] = Math.floor(heat * 255);
      data[i + 1] = Math.floor(heat * 255 * 0.4);
      data[i + 2] = Math.floor(heat * 255 * 0.05);
      data[i + 3] = 255;
    }
  }
  mstctx.putImageData(img, 0, 0);
  // 当前时间竖线（在窗口内才显示）
  if (t >= vt0 && t <= vt1) {
    const x = (t - vt0) / vspan * W;
    mstctx.strokeStyle = '#f59e0b'; mstctx.lineWidth = 2;
    mstctx.beginPath(); mstctx.moveTo(x, 0); mstctx.lineTo(x, H); mstctx.stroke();
  }
}
// 跳转到指定时间（秒）
function seekTo(t, autoplay) {
  if (!samples) return;
  const dur = duration();
  const wasPlaying = playing;
  stop();
  playOffset = Math.max(0, Math.min(dur, t));
  drawWave(playOffset);
  drawSpec();
  updateAnalyze(playOffset);
  if (autoplay && wasPlaying) play();
}

// ---------------- WAV 编解码 ----------------
function encodeWAV(samplesArr, rate) {
  const n = samplesArr.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const ws = function (off, s) { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    let v = Math.max(-1, Math.min(1, samplesArr[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------------- 事件绑定 ----------------
el('btnImport').addEventListener('click', function () { el('ae-fileInput').click(); });
el('ae-fileInput').addEventListener('change', function () {
  const f = this.files && this.files[0];
  if (!f) return;
  const ac = ensureCtx();
  const fr = new FileReader();
  fr.onload = function () {
    ac.decodeAudioData(fr.result, function (buf) {
      const ch = buf.getChannelData(0);
      sampleRate = buf.sampleRate;
      // 转单声道（取第一声道）
      setSamples(new Float32Array(ch), false);
    }, function () { alert('无法解码该音频格式。'); });
  };
  fr.readAsArrayBuffer(f);
  this.value = '';
});
el('btnImportAux').addEventListener('click', function () { el('auxFileInput').click(); });
el('auxFileInput').addEventListener('change', function () {
  const f = this.files && this.files[0];
  if (!f) return;
  const ac = ensureCtx();
  const fr = new FileReader();
  fr.onload = function () {
    ac.decodeAudioData(fr.result, function (buf) {
      aux = new Float32Array(buf.getChannelData(0));
      alert('已导入第二段音频（' + (aux.length / buf.sampleRate).toFixed(2) + 's），可用于混音 / 卷积。');
    }, function () { alert('无法解码该音频格式。'); });
  };
  fr.readAsArrayBuffer(f);
  this.value = '';
});
el('btnExport').addEventListener('click', function () {
  if (!samples) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(encodeWAV(samples, sampleRate));
  a.download = 'audio-' + Date.now() + '.wav';
  a.click();
});
el('btnPlay').addEventListener('click', function () {
  if (!samples) return;
  if (playing) pause(); else play();
});
el('btnStop').addEventListener('click', function () { stop(); playOffset = 0; drawWave(null); });
el('ae-btnReset').addEventListener('click', function () {
  if (history.length) {
    redoStack.push(samples.slice());
    samples = history.pop();
    stftCache = null;
    if (!history.length) el('ae-btnReset').disabled = true;
    updateInfo(); drawWave(null); drawSpec(); updateAnalyze(0);
    updateEditBtnUI();
  }
});

// 时域
el('volRange').addEventListener('input', function () { el('volVal').textContent = this.value + '%'; });
el('btnVol').addEventListener('click', function () { applyVolume(+el('volRange').value / 100); });
el('fadeRange').addEventListener('input', function () { el('fadeVal').textContent = (this.value / 1000).toFixed(1) + 's'; });
el('btnFade').addEventListener('click', function () { applyFade(+el('fadeRange').value / 1000); });
el('speedRange').addEventListener('input', function () { el('speedVal').textContent = (this.value / 100).toFixed(2) + 'x'; });
el('btnSpeed').addEventListener('click', function () { applySpeed(+el('speedRange').value / 100); });
el('btnReverse').addEventListener('click', applyReverse);
el('btnNormalize').addEventListener('click', applyNormalize);
el('btnMix').addEventListener('click', applyMix);
el('gateRange').addEventListener('input', function () { el('gateVal').textContent = this.value + '%'; });
el('btnGate').addEventListener('click', function () { applyGate(+el('gateRange').value / 100); });

// 频域
el('btnFFT').addEventListener('click', function () { specMode = 'fft'; drawSpec(); el('fftOut').textContent = '已显示 FFT 频谱（对数频率轴 20Hz–20kHz）。'; });
el('btnPitch').addEventListener('click', function () {
  const r = detectPitch();
  el('fftOut').textContent = r ? '基频 ≈ ' + r.freq.toFixed(1) + ' Hz（自相关置信度 ' + r.conf.toFixed(2) + '）' : '未检测到稳定基频（音频可能过短或为噪声）。';
});
el('btnLP').addEventListener('click', function () { applyFreqFilter('lp', +el('lpFreq').value, 0); });
el('btnHP').addEventListener('click', function () { applyFreqFilter('hp', 0, +el('hpFreq').value); });
el('btnBP').addEventListener('click', function () { applyFreqFilter('bp', +el('bpLo').value, +el('bpHi').value); });

// 卷积
el('btnIR1').addEventListener('click', function () { applyConv(impulseReverb()); });
el('btnIR2').addEventListener('click', function () { applyConv(impulseEcho()); });
el('btnConv').addEventListener('click', function () {
  if (!aux) { alert('请先导入第二段音频作为脉冲响应（📂 第二段）。'); return; }
  applyConv(aux);
});

// 统计
el('btnDenoise').addEventListener('click', function () {
  const before = samples ? detectPitch() : null;
  applySpectralSubtract();
  const after = detectPitch();
  el('statOut').textContent = '频谱减法完成。降噪前基频 ' + (before ? before.freq.toFixed(1) + 'Hz' : '无') + '，降噪后 ' + (after ? after.freq.toFixed(1) + 'Hz' : '无') + '。';
});

// NMF
el('btnNMF').addEventListener('click', function () {
  const k = +el('nmfK').value;
  const comps = applyNMF(k);
  if (!comps) return;
  // 保存原信号，把第 1 个成分作为当前音频
  el('nmfOut').textContent = '已分解出 ' + k + ' 个成分。当前音频 = 成分 1（' + k + ' 个成分可分别播放：点成分按钮切换）。';
  samples = comps[0];
  stftCache = null;
  updateInfo(); drawWave(null); drawSpec(); updateAnalyze(0);
  // 提供切换按钮
  let btns = '';
  for (let i = 0; i < comps.length; i++) {
    btns += '<button class="a-btn" data-nmf="' + i + '">成分 ' + (i + 1) + '</button> ';
  }
  el('nmfOut').innerHTML = '已分解（NMF, k=' + k + '，80 次迭代）。当前为成分 1。切换：' + btns;
  el('nmfOut').querySelectorAll('[data-nmf]').forEach(function (b) {
    b.addEventListener('click', function () {
      samples = comps[+this.dataset.nmf];
      stftCache = null;
      updateInfo(); drawWave(null); drawSpec(); updateAnalyze(0);
    });
  });
});

// ---------------- 布局交互：进度条 / 分界手柄 / 面板浮动与隐藏 ----------------
// 时间进度条：拖动定位（不播放，停在移动到的位置）；播放中拖动先暂停
(function () {
  const bar = el('progressBar');
  bar.addEventListener('pointerdown', function () {
    if (playing) pause();
    // 在用户手势（pointerdown）中激活 AudioContext（供后续手动播放用）
    if (samples && !audioCtx) { try { ensureCtx(); } catch (e) { /* 忽略 */ } }
    if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) { /* 忽略 */ } }
  });
  bar.addEventListener('input', function () {
    if (!samples) return;
    playOffset = (+bar.value / 1000) * duration();
    drawWave(playOffset);
    updateAnalyze(playOffset);
  });
  bar.addEventListener('change', function () {
    // 停在移动到的位置，不自动播放
    stop();
    drawWave(playOffset);
    updateAnalyze(playOffset);
  });
})();
// 主区分界（波形 / 频谱 上下）
(function () {
  const sp = el('hSplitter');
  sp.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    sp.classList.add('drag');
    const startY = e.clientY, startSplit = mainSplit;
    const ma = el('mainArea');
    function move(ev) {
      mainSplit = Math.max(0.12, Math.min(0.85, startSplit + (ev.clientY - startY) / (ma.clientHeight || 1)));
      applyPanelLayout();
      resizeCanvases();
    }
    function up() {
      sp.classList.remove('drag');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    }
    document.addEventListener('pointermove', function (e) { if (!aePanelOpen()) return; move(e); });
    document.addEventListener('pointerup', function (e) { if (!aePanelOpen()) return; up(e); });
  });
})();
// 底部分析区两个分界手柄（三个面板之间横向调整大小）
function bindAnaSplitter(id, key) {
  const sp = el(id);
  sp.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    sp.classList.add('drag');
    const startX = e.clientX;
    const startA = key === 'anaS1' ? anaS1 : anaS2;
    const wrap = el('analyzeWrap');
    function move(ev) {
      const delta = (ev.clientX - startX) / (wrap.clientWidth || 1) * 100;
      let a = startA + delta;
      if (key === 'anaS1') {
        a = Math.max(10, Math.min(80 - anaS2, a));
        anaS1 = a;
      } else {
        a = Math.max(10, Math.min(90 - anaS1, a));
        anaS2 = a;
      }
      applyPanelLayout();
      resizeCanvases();
    }
    function up() {
      sp.classList.remove('drag');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    }
    document.addEventListener('pointermove', function (e) { if (!aePanelOpen()) return; move(e); });
    document.addEventListener('pointerup', function (e) { if (!aePanelOpen()) return; up(e); });
  });
}
bindAnaSplitter('anaSplit1', 'anaS1');
bindAnaSplitter('anaSplit2', 'anaS2');
// 面板宽度（主区 / 工具栏 左右）
(function () {
  const vs = el('vSplitter');
  vs.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    vs.classList.add('drag');
    const startX = e.clientX, startW = panelWidth;
    function move(ev) {
      panelWidth = Math.max(180, Math.min(580, startW + (startX - ev.clientX)));
      layout();
    }
    function up() {
      vs.classList.remove('drag');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    }
    document.addEventListener('pointermove', function (e) { if (!aePanelOpen()) return; move(e); });
    document.addEventListener('pointerup', function (e) { if (!aePanelOpen()) return; up(e); });
  });
})();
// 主区 / 底部区（时间条）垂直分界：拖动调整上下大小，时间条位置随动
(function () {
  const vs = el('vAreaSplitter');
  vs.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    vs.classList.add('drag');
    const startY = e.clientY, startH = bottomAreaH;
    const vh = window.innerHeight;
    function move(ev) {
      bottomAreaH = Math.max(120, Math.min(420, startH + (startY - ev.clientY)));
      try { localStorage.setItem(AREA_KEY, String(bottomAreaH)); } catch (e2) { /* 忽略 */ }
      layout();
    }
    function up() {
      vs.classList.remove('drag');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    }
    document.addEventListener('pointermove', function (e) { if (!aePanelOpen()) return; move(e); });
    document.addEventListener('pointerup', function (e) { if (!aePanelOpen()) return; up(e); });
  });
})();
// 面板浮动 / 停靠
el('btnToolsFloat').addEventListener('click', function () {
  toolsDocked = !toolsDocked;
  layout();
});
// 面板头部拖动（浮动模式移动）
(function () {
  const head = el('toolsHead');
  head.addEventListener('pointerdown', function (e) {
    if (e.target.tagName === 'BUTTON') return;
    if (toolsDocked || toolsHidden) return;
    e.preventDefault();
    head.classList.add('drag');
    const startX = e.clientX, startY = e.clientY;
    const sx = toolsFloatPos.x, sy = toolsFloatPos.y;
    function move(ev) {
      toolsFloatPos = { x: sx + (ev.clientX - startX), y: sy + (ev.clientY - startY) };
      const tools = el('tools');
      tools.style.left = toolsFloatPos.x + 'px';
      tools.style.top = toolsFloatPos.y + 'px';
    }
    function up() {
      head.classList.remove('drag');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    }
    document.addEventListener('pointermove', function (e) { if (!aePanelOpen()) return; move(e); });
    document.addEventListener('pointerup', function (e) { if (!aePanelOpen()) return; up(e); });
  });
})();
// 隐藏 / 显示面板
function setToolsHidden(h) {
  toolsHidden = h;
  el('tools').style.display = h ? 'none' : '';
  el('btnToolsShow').style.display = h ? '' : 'none';
  layout();
}
el('btnToolsHide').addEventListener('click', function () { setToolsHidden(true); });
el('btnToggleTools').addEventListener('click', function () { setToolsHidden(!toolsHidden); });
el('btnToolsShow').addEventListener('click', function () { setToolsHidden(false); });

// ---------------- 初始化 ----------------
(function () {
  try { const v = parseInt(localStorage.getItem(AREA_KEY), 10); if (v >= 120 && v <= 420) bottomAreaH = v; } catch (e) { /* 忽略 */ }
})();
window.addEventListener('resize', function () { if (!aePanelOpen()) return; layout(); });
renderPanelList();
layout();

// ================= 物理建模合成（Physical Modeling Synthesis）=================
// 不依赖录音，从物理规则重建发声：Karplus-Strong 数字波导（拨/击/拉弦）、
// 模态合成（鼓膜/铃铛非谐模态）、共振峰+谐波激励（人声/吹奏）。
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function freqToNote(f) {
  const n = Math.round(12 * Math.log2(f / 440) + 69);
  const oct = Math.floor(n / 12) - 1;
  return NOTE_NAMES[((n % 12) + 12) % 12] + oct;
}
// —— 激励器 + 共鸣器：Karplus-Strong 数字波导（拨弦/击弦）——
// 短噪声激励 → 带反馈延迟线（波在弦上往返），双点平均 = 波导损耗
function karplusStrong(freq, dur, sr, opts) {
  const N = Math.max(2, Math.round(sr / freq));
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  const delay = new Float32Array(N);
  for (let i = 0; i < N; i++) delay[i] = (Math.random() * 2 - 1) * opts.strength;
  const d = opts.damping;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = delay[j];
    out[i] = s;
    const nxt = (j + 1) % N;
    delay[j] = d * 0.5 * (s + delay[nxt]); // 相邻点平均（低通）→ 高频快速衰减
    j = nxt;
  }
  return out;
}
// —— 拉弦（小提琴）：持续弓激励 + KS 波导，tanh 非线性弓摩擦模型 ——
function bowedString(freq, dur, sr, opts) {
  const N = Math.max(2, Math.round(sr / freq));
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  const delay = new Float32Array(N);
  for (let i = 0; i < N; i++) delay[i] = (Math.random() * 2 - 1) * opts.strength * 0.3;
  const v = opts.bow;
  const stiff = 40, press = 0.9;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = delay[j];
    out[i] = s;
    const rel = s - v;
    const exc = Math.tanh(rel * stiff) * press * 0.08; // 粘滑摩擦
    const nxt = (j + 1) % N;
    delay[j] = opts.damping * 0.5 * (s + delay[nxt]) + exc;
    j = nxt;
  }
  return out;
}
// —— 模态合成：把复杂振动分解为多个阻尼正弦模态叠加（鼓膜/铃铛/金属）——
function modalSynth(freq, dur, sr, opts) {
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  const inharm = opts.inharmonic;
  const RATIOS = [1, 1.59, 2.14, 2.44, 2.92, 3.50, 3.60, 3.93, 4.17, 4.59, 4.70, 5.0]; // 圆膜模态比
  const AMPS = [1, 0.75, 0.5, 0.4, 0.28, 0.2, 0.15, 0.12, 0.1, 0.08, 0.06, 0.05];
  const modes = opts.modes || 5;
  for (let k = 0; k < modes; k++) {
    const ratio = inharm ? Math.pow(k + 1, 1.35) : (RATIOS[k] || (k + 1));
    const f = freq * ratio;
    const d = opts.dampRate * (1 + k * (inharm ? 0.35 : 0.12));
    const A = opts.strength * (AMPS[k] || 0.05) / (1 + k * 0.05);
    const phi = Math.random() * Math.PI * 2;
    const w = 2 * Math.PI * f / sr;
    const dec = Math.exp(-d / sr);
    let amp = A;
    for (let i = 0; i < n; i++) {
      out[i] += amp * Math.cos(w * i + phi);
      amp *= dec;
    }
  }
  return out;
}
// —— 钢琴：3 弦失谐 + 音板共鸣（低通）——
function pianoSynth(freq, dur, sr, opts) {
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  for (let s = 0; s < 3; s++) {
    const cents = (s === 1 ? 0 : (s === 0 ? -opts.detune : opts.detune)) / 1200;
    const buf = karplusStrong(freq * Math.pow(2, cents), dur, sr, { strength: opts.strength * (s === 1 ? 1 : 0.8), damping: opts.damping });
    for (let i = 0; i < n; i++) out[i] += buf[i] / 3;
  }
  let lp = 0;
  const a = 0.85;
  for (let i = 0; i < n; i++) { lp = lp * a + out[i] * (1 - a); out[i] = lp; }
  return out;
}
// —— 人声/吹奏：谐波激励 → 共振峰带通滤波 ——
function voiceSynth(freq, dur, sr, opts) {
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  const H = 12;
  const w0 = 2 * Math.PI * freq / sr;
  const FORM = [600, 1000, 2400];
  const biq = FORM.map(function (f0) {
    const w = 2 * Math.PI * f0 / sr, Q = 8, alpha = Math.sin(w) / (2 * Q);
    const a0 = 1 + alpha;
    return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  });
  const res = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let h = 1; h <= H; h++) x += Math.sin(h * w0 * i) / h / 1.6;
    x += (Math.random() * 2 - 1) * 0.08 * opts.strength;
    x *= opts.strength;
    let y = 0;
    for (const b of biq) {
      const yy = b.b0 * x + b.b1 * b.x1 + b.b2 * b.x2 - b.a1 * b.y1 - b.a2 * b.y2;
      b.x2 = b.x1; b.x1 = x; b.y2 = b.y1; b.y1 = yy;
      y += yy;
    }
    res[i] = y / 3;
  }
  return res;
}
// —— 主入口：按类型合成 ——
function physSynthesize() {
  const type = el('physType').value;
  const freq = +el('physFreq').value;
  const dur = +el('physDur').value;
  const strength = +el('physStr').value;
  const damping = +el('physDamp').value;
  const modes = +el('physModes').value;
  const bow = +el('physBow').value;
  const detune = +el('physDetune').value;
  if (type === 'pluck') return karplusStrong(freq, dur, sampleRate, { strength: strength, damping: damping });
  if (type === 'bow') return bowedString(freq, dur, sampleRate, { strength: strength, damping: damping, bow: bow });
  if (type === 'drum') return modalSynth(freq, dur, sampleRate, { strength: strength, modes: modes, inharmonic: false, dampRate: 1.5 + (1 - damping) * 60 });
  if (type === 'bell') return modalSynth(freq, dur, sampleRate, { strength: strength, modes: modes, inharmonic: true, dampRate: 0.5 + (1 - damping) * 40 });
  if (type === 'piano') return pianoSynth(freq, dur, sampleRate, { strength: strength, damping: damping, detune: detune });
  return voiceSynth(freq, dur, sampleRate, { strength: strength, modes: modes });
}
function physNormalize(buf, peak) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > m) m = Math.abs(buf[i]);
  if (m > 0) { const g = peak / m; for (let i = 0; i < buf.length; i++) buf[i] *= g; }
  return buf;
}
function physPreview(buf) {
  const cv2 = el('physCanvas');
  cv2.width = Math.max(300, cv2.clientWidth || 300);
  cv2.height = 120;
  const ctx2 = cv2.getContext('2d');
  const W = cv2.width, H = cv2.height;
  ctx2.fillStyle = '#0a0d13'; ctx2.fillRect(0, 0, W, H);
  const mid = H / 2;
  ctx2.strokeStyle = '#38bdf8';
  ctx2.beginPath();
  const step = Math.max(1, Math.floor(buf.length / W));
  for (let x = 0; x < W; x++) {
    let min = 0, max = 0;
    const s0 = Math.min(buf.length, x * step);
    const s1 = Math.min(buf.length, s0 + step);
    for (let i = s0; i < s1; i++) { if (buf[i] < min) min = buf[i]; if (buf[i] > max) max = buf[i]; }
    ctx2.moveTo(x, mid - min * (H / 2 - 2));
    ctx2.lineTo(x, mid - max * (H / 2 - 2));
  }
  ctx2.stroke();
}
let physSrc = null;
function physPlayBuf(buf) {
  const ac = ensureCtx();
  if (physSrc) { try { physSrc.stop(); } catch (e) { /* 忽略 */ } }
  const b = ac.createBuffer(1, buf.length, sampleRate);
  b.copyToChannel(buf, 0);
  physSrc = ac.createBufferSource();
  physSrc.buffer = b;
  physSrc.connect(ac.destination);
  physSrc.start();
}
// —— 事件绑定 ——
el('btnPhys').addEventListener('click', function () { el('physOverlay').style.display = 'flex'; });
el('physClose').addEventListener('click', function () { el('physOverlay').style.display = 'none'; });
el('physOverlay').addEventListener('click', function (e) { if (e.target === this) this.style.display = 'none'; });
const physLinks = [
  ['physFreq', 'physFreqVal', ''], ['physDur', 'physDurVal', 's'], ['physStr', 'physStrVal', ''],
  ['physDamp', 'physDampVal', ''], ['physModes', 'physModesVal', ''], ['physBow', 'physBowVal', ''], ['physDetune', 'physDetuneVal', '¢']
];
for (const [r, v, suf] of physLinks) {
  el(r).addEventListener('input', function () {
    const val = r === 'physDur' ? (+this.value).toFixed(1) : this.value;
    el(v).textContent = val + suf;
    el('physNote').textContent = '♪ ' + freqToNote(+el('physFreq').value);
  });
}
function physTypeUI() {
  const t = el('physType').value;
  el('rowModes').style.display = (t === 'drum' || t === 'bell' || t === 'voice') ? '' : 'none';
  el('rowBows').style.display = t === 'bow' ? '' : 'none';
  el('rowDetune').style.display = t === 'piano' ? '' : 'none';
  el('rowDamp').style.display = (t === 'pluck' || t === 'piano' || t === 'bow') ? '' : 'none';
}
el('physType').addEventListener('change', physTypeUI);
el('physGen').addEventListener('click', function () {
  el('physFreq').value = Math.round(80 + Math.random() * 900);
  el('physDur').value = (1 + Math.random() * 3).toFixed(1);
  el('physStr').value = (0.5 + Math.random() * 1.2).toFixed(2);
  el('physDamp').value = (0.955 + Math.random() * 0.04).toFixed(3);
  el('physModes').value = 3 + Math.floor(Math.random() * 7);
  el('physBow').value = (0.4 + Math.random() * 1.2).toFixed(2);
  el('physDetune').value = Math.floor(Math.random() * 25);
  for (const [r, v, suf] of physLinks) {
    const val = r === 'physDur' ? (+el(r).value).toFixed(1) : el(r).value;
    el(v).textContent = val + suf;
  }
  el('physNote').textContent = '♪ ' + freqToNote(+el('physFreq').value);
});
el('physPlay').addEventListener('click', function () {
  const buf = physNormalize(physSynthesize(), 0.9);
  physPreview(buf);
  physPlayBuf(buf);
});
el('physLoad').addEventListener('click', function () {
  const buf = physNormalize(physSynthesize(), 0.95);
  physPreview(buf);
  setSamples(buf);
  el('physOverlay').style.display = 'none';
  el('info').textContent = '已载入物理建模合成音频（' + el('physType').selectedOptions[0].textContent + '）';
});
el('physExport').addEventListener('click', function () {
  const buf = physNormalize(physSynthesize(), 0.95);
  physPreview(buf);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(encodeWAV(buf, sampleRate));
  a.download = 'phys-model-' + Date.now() + '.wav';
  a.click();
});
physTypeUI();

// ================= 波形 / 频谱编辑工具（笔刷 / 橡皮 / 框选）=================
let editTool = 'select';
let editAmp = 0.6, editGain = 1.5;
let marqueeSel = null, marqueeDrag = null;
let editSpecFrames = null, editSpecTouched = false;
function updateEditBtnUI() {
  el('ae-btnReset').disabled = !history.length;
  el('ae-btnRedo').disabled = !redoStack.length;
  el('ae-btnRedo').style.opacity = redoStack.length ? '' : '.5';
  el('ae-btnReset').style.opacity = history.length ? '' : '.5';
}
document.querySelectorAll('[data-edit-tool]').forEach(function (b) {
  b.addEventListener('click', function () { setEditTool(this.getAttribute('data-edit-tool')); });
});
function setEditTool(t) {
  editTool = t;
  document.querySelectorAll('[data-edit-tool]').forEach(function (b) {
    b.style.background = b.getAttribute('data-edit-tool') === t ? '#2d4a2f' : '';
    b.style.color = b.getAttribute('data-edit-tool') === t ? '#a7e3aa' : '';
  });
  const editing = t !== 'select';
  el('waveEditOverlay').style.display = editing ? 'block' : 'none';
  el('specEditOverlay').style.display = editing ? 'block' : 'none';
  if (!editing) {
    clearMarqueeBox();
    marqueeSel = null;
    el('editOut').textContent = '';
    if (editSpecFrames) { editSpecFrames = null; drawSpec(); }
  } else {
    el('editOut').textContent = t === 'brush' ? '✏ 笔刷：涂抹放大波形/频谱（增益x' + editGain + '）' :
      t === 'eraser' ? '🧽 橡皮：涂抹静音（波形）或消除频段（频谱）' :
      '🔲 框选：拖动选择区域，再用下方「删除/填充」处理';
    if (t === 'marquee') { el('waveEditOverlay').classList.add('marquee'); el('specEditOverlay').classList.add('marquee'); }
    else { el('waveEditOverlay').classList.remove('marquee'); el('specEditOverlay').classList.remove('marquee'); }
  }
}
el('editAmp').addEventListener('input', function () { editAmp = +this.value; el('editAmpVal').textContent = (+this.value).toFixed(2); });
el('editGain').addEventListener('input', function () { editGain = +this.value; el('editGainVal').textContent = (+this.value).toFixed(1) + 'x'; });
// —— 波形编辑 ——
function waveTimeAtX(x) {
  const ov = el('waveEditOverlay');
  const W = Math.max(1, ov.clientWidth);
  const fx = Math.min(1, Math.max(0, x / W));
  const dur = duration();
  const t0 = views.wave.t0 || 0;
  const t1 = views.wave.t1 != null ? views.wave.t1 : dur;
  return t0 + fx * Math.max(1e-6, t1 - t0);
}
function editWaveApply(tA, tB, mode) {
  if (!samples) return;
  const i0 = Math.max(0, Math.floor(Math.min(tA, tB) * sampleRate));
  const i1 = Math.min(samples.length, Math.ceil(Math.max(tA, tB) * sampleRate));
  if (i0 >= i1) return;
  for (let i = i0; i < i1; i++) {
    if (mode === 'erase') samples[i] = 0;
    else if (mode === 'fill') samples[i] = editAmp;
    else samples[i] *= editGain;
  }
  drawWave(null);
  updateAnalyze(0);
}
(function () {
  const ov = el('waveEditOverlay');
  let drawing = false, lastT = null;
  ov.addEventListener('pointerdown', function (e) {
    if (editTool === 'select' || !samples) return;
    e.preventDefault();
    ov.setPointerCapture(e.pointerId);
    drawing = true;
    if (editTool === 'marquee') {
      const r = ov.getBoundingClientRect();
      marqueeDrag = { x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top };
      showMarqueeBox('wave', marqueeDrag);
      return;
    }
    pushHistory();
    lastT = waveTimeAtX(e.clientX - ov.getBoundingClientRect().left);
    const rad = 0.05;
    editWaveApply(lastT - rad, lastT + rad, editTool === 'brush' ? 'gain' : 'erase');
  });
  ov.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    const r = ov.getBoundingClientRect();
    if (editTool === 'marquee' && marqueeDrag) {
      marqueeDrag.x1 = e.clientX - r.left;
      marqueeDrag.y1 = e.clientY - r.top;
      showMarqueeBox('wave', marqueeDrag);
      return;
    }
    const t = waveTimeAtX(e.clientX - r.left);
    const rad = 0.05;
    editWaveApply(Math.min(lastT, t) - rad, Math.max(lastT, t) + rad, editTool === 'brush' ? 'gain' : 'erase');
    lastT = t;
  });
  const end = function () {
    if (!drawing) return;
    drawing = false;
    if (editTool === 'marquee' && marqueeDrag) {
      marqueeSel = { kind: 'wave', t0: waveTimeAtX(Math.min(marqueeDrag.x0, marqueeDrag.x1)), t1: waveTimeAtX(Math.max(marqueeDrag.x0, marqueeDrag.x1)) };
      el('editOut').textContent = '🔲 已框选 ' + (marqueeSel.t1 - marqueeSel.t0).toFixed(3) + 's → 可用「删除/填充」处理';
    } else {
      updateEditBtnUI();
    }
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
})();
// —— 频谱编辑（STFT 幅度谱）——
function editSpecFreqBin(y, H) {
  const minF = 20, maxF = Math.min(sampleRate / 2, 12000);
  const fy = Math.min(1, Math.max(0, y / Math.max(1, H)));
  const freq = maxF * Math.pow(minF / maxF, fy);
  return Math.max(1, Math.min(511, Math.floor(freq / sampleRate * 1024)));
}
function editSpecFrame(x, W) {
  const fx = Math.min(1, Math.max(0, x / Math.max(1, W)));
  return Math.floor(fx * (editSpecFrames.length - 1));
}
function editSpecApply(f0, f1, k0, k1, mode) {
  if (!editSpecFrames) return;
  // 帧范围扩展 ±1（Hann 50% 重叠：相邻帧窗口覆盖编辑区间，否则重建会被补回）
  const fA = Math.max(0, Math.min(f0, f1) - 1), fB = Math.max(f0, f1) + 1;
  const kA = Math.max(0, Math.min(k0, k1)), kB = Math.max(k0, k1);
  for (let f = fA; f <= fB && f < editSpecFrames.length; f++) {
    const fr = editSpecFrames[f];
    for (let k = kA; k <= kB && k < 512; k++) {
      if (mode === 'erase') { fr.re[k] = 0; fr.im[k] = 0; }
      else if (mode === 'fill') { fr.re[k] = editAmp * 3; fr.im[k] = 0; }
      else { fr.re[k] *= editGain; fr.im[k] *= editGain; }
    }
  }
  editSpecTouched = true;
  drawSTFT(scv.width, scv.height);
}
(function () {
  const ov = el('specEditOverlay');
  let drawing = false, lastF = null, lastK = null;
  ov.addEventListener('pointerdown', function (e) {
    if (editTool === 'select' || !samples) return;
    e.preventDefault();
    ov.setPointerCapture(e.pointerId);
    drawing = true;
    const r = ov.getBoundingClientRect();
    if (editTool === 'marquee') {
      marqueeDrag = { x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top };
      showMarqueeBox('spec', marqueeDrag);
      return;
    }
    pushHistory();
    if (!editSpecFrames) editSpecFrames = stft(samples, 1024, 512);
    editSpecTouched = false;
    drawSTFT(scv.width, scv.height);
    const x = e.clientX - r.left, y = e.clientY - r.top;
    lastF = editSpecFrame(x, r.width);
    lastK = editSpecFreqBin(y, r.height);
    editSpecApply(lastF - 2, lastF + 2, lastK - 3, lastK + 3, editTool === 'brush' ? 'gain' : 'erase');
  });
  ov.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    const r = ov.getBoundingClientRect();
    if (editTool === 'marquee' && marqueeDrag) {
      marqueeDrag.x1 = e.clientX - r.left;
      marqueeDrag.y1 = e.clientY - r.top;
      showMarqueeBox('spec', marqueeDrag);
      return;
    }
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const f = editSpecFrame(x, r.width), k = editSpecFreqBin(y, r.height);
    editSpecApply(Math.min(lastF, f) - 2, Math.max(lastF, f) + 2, Math.min(lastK, k) - 3, Math.max(lastK, k) + 3, editTool === 'brush' ? 'gain' : 'erase');
    lastF = f; lastK = k;
  });
  const end = function () {
    if (!drawing) return;
    drawing = false;
    if (editTool === 'marquee' && marqueeDrag) {
      const W = ov.clientWidth, H = ov.clientHeight;
      marqueeSel = {
        kind: 'spec',
        f0: editSpecFrame(Math.min(marqueeDrag.x0, marqueeDrag.x1), W),
        f1: editSpecFrame(Math.max(marqueeDrag.x0, marqueeDrag.x1), W),
        k0: editSpecFreqBin(Math.min(marqueeDrag.y0, marqueeDrag.y1), H),
        k1: editSpecFreqBin(Math.max(marqueeDrag.y0, marqueeDrag.y1), H)
      };
      el('editOut').textContent = '🔲 已框选频谱区域 → 可用「删除/填充」处理';
      return;
    }
    if (editSpecTouched) {
      const rebuilt = istft(editSpecFrames, 1024, 512, samples.length);
      editSpecFrames = null;
      setSamples(rebuilt);
      updateEditBtnUI();
      el('editOut').textContent = '✓ 频谱编辑已应用（iSTFT 重建），可播放';
    }
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
})();
// —— 框选矩形显示 ——
function showMarqueeBox(kind, d) {
  const ov = kind === 'wave' ? el('waveEditOverlay') : el('specEditOverlay');
  let box = ov.querySelector('.sel-box');
  if (!box) { box = document.createElement('div'); box.className = 'sel-box'; ov.appendChild(box); }
  box.style.left = Math.min(d.x0, d.x1) + 'px';
  box.style.top = Math.min(d.y0, d.y1) + 'px';
  box.style.width = Math.abs(d.x1 - d.x0) + 'px';
  box.style.height = Math.abs(d.y1 - d.y0) + 'px';
  box.style.display = 'block';
}
function clearMarqueeBox() {
  document.querySelectorAll('.sel-box').forEach(function (b) { b.remove(); });
}
(function () {
  const s = document.createElement('style');
  s.textContent = '.edit-overlay .sel-box { position:absolute; border:1.5px solid #f59e0b; background: rgba(245,158,11,.18); pointer-events:none; }';
  document.head.appendChild(s);
})();
// —— 框选删除 / 填充 ——
el('btnMarDel').addEventListener('click', function () {
  if (!marqueeSel || !samples) { el('editOut').textContent = '先框选区域（波形或频谱）'; return; }
  pushHistory();
  if (marqueeSel.kind === 'wave') {
    editWaveApply(marqueeSel.t0, marqueeSel.t1, 'erase');
  } else {
    if (!editSpecFrames) editSpecFrames = stft(samples, 1024, 512);
    editSpecApply(marqueeSel.f0, marqueeSel.f1, marqueeSel.k0, marqueeSel.k1, 'erase');
    const rebuilt = istft(editSpecFrames, 1024, 512, samples.length);
    editSpecFrames = null;
    setSamples(rebuilt);
  }
  marqueeSel = null; clearMarqueeBox();
  updateEditBtnUI();
  el('editOut').textContent = '🗑 已删除选中区域';
});
el('btnMarFill').addEventListener('click', function () {
  if (!marqueeSel || !samples) { el('editOut').textContent = '先框选区域（波形或频谱）'; return; }
  pushHistory();
  if (marqueeSel.kind === 'wave') {
    editWaveApply(marqueeSel.t0, marqueeSel.t1, 'fill');
  } else {
    if (!editSpecFrames) editSpecFrames = stft(samples, 1024, 512);
    editSpecApply(marqueeSel.f0, marqueeSel.f1, marqueeSel.k0, marqueeSel.k1, 'fill');
    const rebuilt = istft(editSpecFrames, 1024, 512, samples.length);
    editSpecFrames = null;
    setSamples(rebuilt);
  }
  marqueeSel = null; clearMarqueeBox();
  updateEditBtnUI();
  el('editOut').textContent = '🎨 已填充选中区域';
});
// —— 撤销 / 重做（按钮 + Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）——
function undoEdit() { el('ae-btnReset').click(); }
function redoEdit() {
  if (!redoStack.length) return;
  history.push(samples.slice());
  samples = redoStack.pop();
  stftCache = null;
  updateInfo(); drawWave(null); drawSpec(); updateAnalyze(0);
  updateEditBtnUI();
}
el('ae-btnRedo').addEventListener('click', redoEdit);
window.addEventListener('keydown', function (e) { if (!aePanelOpen()) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoEdit(); else undoEdit();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redoEdit();
  }
});
updateEditBtnUI();

})();