'use strict';
// ================= 纹理生成器（无限像素画布） =================
// 11 种纹理：砖墙 / 棋盘格 / 环境 / Gabor / IES / 迷幻 / 噪波 / 天空 / 沃罗诺伊 / 波浪 / 白噪波
// 参数：长 L、宽 Wd（周期/格大小）、X/Y 偏移、缩放、种子、倍频、双色 A/B
// 依赖 pixel-canvas.js 的全局：clamp / rgbaToHex / sampleNoise / permFor /
//   screenToWorld / cssW / cssH / beginStroke / paintCellRaw / markDirtyRect / endStroke / requestRender

const texEl = function (id) { return document.getElementById(id); };

// ---- 颜色工具 ----
function texHexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function textureToColor(v, cA, cB) {
  const pa = texHexToRgb(cA), pb = texHexToRgb(cB);
  const t = clamp(v, 0, 1);
  return rgbaToHex(
    Math.round(pa[0] + (pb[0] - pa[0]) * t),
    Math.round(pa[1] + (pb[1] - pa[1]) * t),
    Math.round(pa[2] + (pb[2] - pa[2]) * t), 255);
}
// 白噪波 / 种子哈希
function texHash(x, y, seed) {
  let h = (seed >>> 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// 纹理采样：返回 0..1
function sampleTexture(type, x, y, L, Wd, scale, seed, oct, p) {
  const sx = x / Math.max(0.01, scale), sy = y / Math.max(0.01, scale);
  switch (type) {
    case 'brick': {
      const bw = Math.max(1, L), bh = Math.max(1, Wd);
      const row = Math.floor(sy / bh);
      const off = (row % 2) * (bw / 2);
      const px = ((sx + off) % bw + bw) % bw;
      const py = ((sy % bh) + bh) % bh;
      return (px < 1 || py < 1) ? 0 : 1; // 砖缝 = 深色(B)，砖面 = 亮色(A)
    }
    case 'checker': {
      const i = Math.floor(sx / Math.max(1, L)), j = Math.floor(sy / Math.max(1, Wd));
      return (i + j) % 2 === 0 ? 0 : 1;
    }
    case 'environ': {
      // 环境渐变：中心光源 + 径向衰减
      const r = Math.hypot(sx, sy) / Math.max(1, L);
      return clamp(1 - r / 2, 0, 1);
    }
    case 'gabor': {
      const f = 1 / Math.max(1, L);
      const theta = Math.PI / 4;
      const gx = sx * Math.cos(theta) + sy * Math.sin(theta);
      const gy = -sx * Math.sin(theta) + sy * Math.cos(theta);
      const sigma = Math.max(1, Wd);
      const g = Math.exp(-(gx * gx + gy * gy) / (2 * sigma * sigma)) * Math.cos(2 * Math.PI * f * gx);
      return clamp(0.5 + 0.5 * g, 0, 1);
    }
    case 'ies': {
      // IES 光分布：中心亮 + 角度瓣
      const r = Math.hypot(sx, sy);
      const a = Math.atan2(sy, sx);
      const lobes = 0.5 + 0.5 * Math.cos(a * 4 + (seed % 360) * 0.01);
      return clamp(1 / (1 + r / Math.max(1, Wd)) * (0.3 + 0.7 * lobes), 0, 1);
    }
    case 'magic': {
      // 迷幻：正弦叠加
      const f = 6.283 / Math.max(1, L);
      const v = Math.sin(sx * f + Math.sin(sy * f * 2 + (seed % 1000) * 0.01) * 2);
      return clamp(0.5 + 0.5 * v, 0, 1);
    }
    case 'noise': {
      // 噪波 fbm（Perlin 多倍频）
      let v = 0, amp = 1, fr = 1, sum = 0;
      for (let o = 0; o < oct; o++) {
        v += amp * sampleNoise('perlin', x, y, scale * fr, 1, p);
        sum += amp; amp *= 0.5; fr *= 2;
      }
      return v / sum;
    }
    case 'sky': {
      // 天空：垂直渐变
      const t = clamp((sy + L / 2) / L, 0, 1);
      return t;
    }
    case 'voronoi': {
      // 沃罗诺伊：Worley F1 距离
      const g = Math.max(1, L);
      const ix = Math.floor(sx / g), iy = Math.floor(sy / g);
      let best = 1e9;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const cx = (ix + ox) * g + texHash(ix + ox, iy + oy, seed) * g;
        const cy = (iy + oy) * g + texHash(ix + ox + 77, iy + oy - 31, seed) * g;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < best) best = d;
      }
      return clamp(best / g, 0, 1);
    }
    case 'wave': {
      const f = 6.283 / Math.max(1, L);
      return clamp(0.5 + 0.5 * Math.sin(sx * f + (seed % 1000) * 0.01), 0, 1);
    }
    case 'white':
    default:
      return texHash(x, y, seed);
  }
}

let textureGenerating = false;
// 纹理种子历史（最近两次）与自动换种子
let textureSeedHist = [];
function renderTextureSeedHist() {
  const box = texEl('textureSeedHist');
  if (!box) return;
  box.innerHTML = '';
  if (!textureSeedHist.length) { box.innerHTML = '<span class="n-note">生成后自动记录前两次种子</span>'; return; }
  textureSeedHist.slice().reverse().forEach(function (s, i) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.style.cssText = 'padding:2px 8px;font-size:11px;margin-right:6px;';
    b.textContent = (i === 0 ? '🕘 上一次种子 ' : '🕘 上上次种子 ') + s;
    b.title = '点击回填该种子';
    b.addEventListener('click', function () { texEl('texSeed').value = s; });
    box.appendChild(b);
  });
}

renderTextureSeedHist();
// 生成纹理：居中放置、分片生成（每帧 ≤24ms）、支持撤销
function generateTexture() {
  if (textureGenerating) return;
  const w = Math.max(1, Math.floor(+texEl('texW').value || 128));
  const h = Math.max(1, Math.floor(+texEl('texH').value || 128));
  if (w > 4096 || h > 4096) { alert('大小不能超过 4096×4096。'); return; }
  if (w * h > 4000000 &&
      !confirm('纹理较大（' + w + '×' + h + '，约 ' + Math.round(w * h / 1000000) +
               'M 像素），生成可能需要较长时间，是否继续？')) return;
  const type = texEl('texType').value;
  const L = Math.max(1, Math.floor(+texEl('texLen').value || 32));
  const Wd = Math.max(1, Math.floor(+texEl('texWid').value || 32));
  const scale = Math.max(0.01, +texEl('texScale').value || 1);
  const offX = +texEl('texOffX').value || 0;
  const offY = +texEl('texOffY').value || 0;
  const seed = Math.floor(+texEl('texSeed').value) >>> 0;
  const oct = Math.max(1, Math.min(8, Math.floor(+texEl('texOct').value || 1)));
  const cA = texEl('texColA').value || '#3b82f6';
  const cB = texEl('texColB').value || '#1e3a8a';
  const p = permFor(seed);
  const wx2 = screenToWorld(cssW() / 2, cssH() / 2)[0];
  const wy2 = screenToWorld(cssW() / 2, cssH() / 2)[1];
  const gx0 = Math.floor(wx2 - w / 2), gy0 = Math.floor(wy2 - h / 2);
  beginStroke();
  textureGenerating = true;
  const st = texEl('importStatus');
  st.style.display = 'block';
  let row = 0;
  (function slice() {
    const t0 = performance.now();
    while (row < h && performance.now() - t0 < 24) {
      const gy = gy0 + row;
      for (let x = 0; x < w; x++) {
        const v = sampleTexture(type, gx0 + x + offX, gy + offY, L, Wd, scale, seed, oct, p);
        paintCellRaw((gx0 + x) + ',' + gy, textureToColor(v, cA, cB));
      }
      row++;
    }
    if (row < h) {
      st.textContent = '正在生成纹理… ' + Math.round(row / h * 100) + '%';
      requestAnimationFrame(slice);
      return;
    }
    st.style.display = 'none';
    textureGenerating = false;
    // 记录本次种子并自动切换新种子（下次无需手动输入）
    textureSeedHist.push(seed);
    if (textureSeedHist.length > 2) textureSeedHist.shift();
    renderTextureSeedHist();
    texEl('texSeed').value = Math.floor(Math.random() * 1000000);
    markDirtyRect(gx0, gy0, gx0 + w - 1, gy0 + h - 1);
    endStroke();
    requestRender();
  })();
}

// ---- 面板开关 ----
texEl('btnOpenTexture').addEventListener('click', function () {
  texEl('texturePanel').classList.add('open');
});
texEl('btnCloseTexture').addEventListener('click', function () {
  texEl('texturePanel').classList.remove('open');
});
texEl('btnTexSeed').addEventListener('click', function () {
  texEl('texSeed').value = Math.floor(Math.random() * 1000000);
});
texEl('btnGenTexture').addEventListener('click', generateTexture);
