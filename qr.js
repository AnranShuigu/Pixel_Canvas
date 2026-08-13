'use strict';
// ================= 二维码 / 条码生成器（无限像素画布） =================
// 二维码：手写 QR（byte 模式，版本 1-10，L/M/Q/H 纠错，含 Reed-Solomon、掩码、格式/版本信息）
// 条码：Code 39（标准表，支持 0-9 A-Z - . 空格 $ / + %）
// 依赖 pixel-canvas.js 全局：screenToWorld / cssW / cssH / beginStroke / paintCellRaw /
//   markDirtyRect / endStroke / requestRender

const qrEl = function (id) { return document.getElementById(id); };

// ---------- GF(256) 与 Reed-Solomon ----------
const QR_EXP = new Uint8Array(512), QR_LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { QR_EXP[i] = x; QR_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255];
})();
function qrMul(a, b) { if (!a || !b) return 0; return QR_EXP[QR_LOG[a] + QR_LOG[b]]; }
function rsGeneratorPoly(ecLen) {
  let g = [1];
  for (let i = 0; i < ecLen; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { ng[j] ^= qrMul(g[j], QR_EXP[i]); ng[j + 1] ^= g[j]; }
    g = ng;
  }
  return g.reverse(); // 系数反转为 [最高次, ..., 常数]
}
function rsEncode(data, ecLen) {
  const g = rsGeneratorPoly(ecLen);
  const buf = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ buf[0];
    buf.shift();
    buf.push(0);
    for (let i = 0; i < ecLen; i++) buf[i] ^= qrMul(g[i + 1], factor);
  }
  return buf;
}
// 版本 1-6（L 纠错）：[dataCodewords, ecCodewords, blocks]
const QR_VERSIONS = {
  1: [19, 7, 1], 2: [34, 10, 1], 3: [55, 15, 1], 4: [80, 20, 1], 5: [108, 26, 1], 6: [136, 18, 2]
};

// ---------- QR 编码 → 矩阵 ----------
// ECC 表（版本 1-10 × L/M/Q/H）：[total, ecPerBlock, g1块数, g1数据, g2块数, g2数据]
const QR_ECC = {
  L: {1:[26,7,1,19,0,0],2:[44,10,1,34,0,0],3:[70,15,1,55,0,0],4:[100,20,1,80,0,0],5:[134,26,1,108,0,0],6:[172,18,2,68,0,0],7:[196,20,2,78,0,0],8:[242,24,2,97,0,0],9:[292,30,2,116,0,0],10:[346,18,2,68,2,69]},
  M: {1:[26,10,1,16,0,0],2:[44,16,1,28,0,0],3:[70,26,1,44,0,0],4:[100,18,2,32,0,0],5:[134,24,2,43,0,0],6:[172,16,4,27,0,0],7:[196,18,4,31,0,0],8:[242,22,2,38,2,39],9:[292,22,3,36,2,37],10:[346,26,4,43,1,44]},
  Q: {1:[26,13,1,13,0,0],2:[44,22,1,22,0,0],3:[70,18,2,17,0,0],4:[100,26,2,24,0,0],5:[134,18,2,15,2,16],6:[172,24,4,19,0,0],7:[196,18,2,14,4,15],8:[242,22,4,18,2,19],9:[292,20,4,16,4,17],10:[346,24,6,19,2,20]},
  H: {1:[26,17,1,9,0,0],2:[44,28,1,16,0,0],3:[70,22,2,13,0,0],4:[100,16,4,9,0,0],5:[134,22,2,11,2,12],6:[172,28,4,15,0,0],7:[196,26,4,13,1,14],8:[242,26,4,14,2,15],9:[292,24,4,12,4,13],10:[346,28,6,15,2,16]}
};
const QR_ALIGN = { 2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50] };
// 版本信息（v>=7，BCH(18,6)）
function qrVersionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  return ((ver << 12) | rem) ^ 0x2D85;
}
function buildQRMatrix(text, ecLevel) {
  ecLevel = ecLevel || 'L';
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const tbl = QR_ECC[ecLevel];
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const t = tbl[v];
    const dataTotal = t[2] * t[3] + t[4] * t[5];
    if (4 + 8 + bytes.length * 8 + 4 <= dataTotal * 8) { ver = v; break; }
  }
  if (!ver) {
    const caps = { L: 270, M: 210, Q: 150, H: 118 };
    throw new Error('文本过长：纠错等级 ' + ecLevel + ' 最多约 ' + caps[ecLevel] + ' 个英文字符（L 级容量最大）');
  }
  const t = tbl[ver];
  const ecLen = t[1], g1n = t[2], g1d = t[3], g2n = t[4], g2d = t[5];
  const blocks = g1n + g2n;
  const dataTotal = g1n * g1d + g2n * g2d;
  const bits = [];
  const pushBits = function (val, n) { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  pushBits(4, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  pushBits(0, 4);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  let pad = 0xEC;
  while (data.length < dataTotal) { data.push(pad); pad = pad === 0xEC ? 0x11 : 0xEC; }
  const final = [], ecAll = [];
  let di = 0;
  const blockLens = [];
  for (let b = 0; b < g1n; b++) blockLens.push(g1d);
  for (let b = 0; b < g2n; b++) blockLens.push(g2d);
  for (let b = 0; b < blocks; b++) {
    const blk = data.slice(di, di + blockLens[b]);
    di += blockLens[b];
    final.push(blk);
    ecAll.push(rsEncode(blk, ecLen));
  }
  const codewords = [];
  const maxData = Math.max.apply(null, blockLens);
  for (let i = 0; i < maxData; i++) for (let b = 0; b < blocks; b++) if (i < final[b].length) codewords.push(final[b][i]);
  for (let i = 0; i < ecLen; i++) for (let b = 0; b < blocks; b++) codewords.push(ecAll[b][i]);

  const size = 17 + 4 * ver;
  const m = [];
  const func = [];
  for (let r = 0; r < size; r++) { m.push(new Array(size).fill(0)); func.push(new Array(size).fill(false)); }
  const markF = function (r, c, v) { if (r >= 0 && r < size && c >= 0 && c < size) { m[r][c] = v; func[r][c] = true; } };
  const placeFinder7 = function (r, c) {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const rr = r + i, cc = c + j;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const in7 = i >= 0 && i <= 6 && j >= 0 && j <= 6;
      if (!in7) { markF(rr, cc, 0); continue; }
      const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
      markF(rr, cc, (ring !== 2) ? 2 : 0);
    }
  };
  placeFinder7(0, 0);
  placeFinder7(0, size - 7);
  placeFinder7(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    markF(6, i, (i % 2 === 0) ? 2 : 0);
    markF(i, 6, (i % 2 === 0) ? 2 : 0);
  }
  markF(size - 8, 8, 2);
  const align = QR_ALIGN[ver] || [];
  const placeAlign = function (r, c) {
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const rr = r + i, cc = c + j;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      if (func[rr][cc]) continue;
      const ring = Math.max(Math.abs(i), Math.abs(j));
      markF(rr, cc, (ring !== 1) ? 2 : 0);
    }
  };
  if (align.length) {
    for (const a of align) for (const b of align) {
      if (a === 6 && b === 6) continue;
      if (a === 6 && b === align[align.length - 1]) continue;
      if (b === 6 && a === align[align.length - 1]) continue;
      placeAlign(a, b);
    }
  }
  if (ver >= 7) {
    const vb = qrVersionBits(ver);
    for (let i = 0; i < 18; i++) {
      const a = (vb >> i) & 1;
      const b = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      markF(b, c, a ? 2 : 0);
      markF(c, b, a ? 2 : 0);
    }
  }
  // 格式位区域先标记为功能图形（数据不可写；值在掩码后填入）
  // 副本1（左上：纵向列8 + 横向行8）
  for (let i = 0; i <= 5; i++) func[i][8] = true;
  func[7][8] = true; func[8][8] = true; func[8][7] = true;
  for (let i = 9; i < 15; i++) func[8][14 - i] = true;
  // 副本2（左下 + 右上）
  for (let i = 0; i < 8; i++) func[size - 1 - i][8] = true;
  for (let i = 8; i < 15; i++) func[8][size - 15 + i] = true;
  func[8][size - 8] = true; // 右上 8×9 格式区最左格（与主流实现一致）

  let idx = 0;
  let dir = -1;
  let col = size - 1;
  while (col > 0) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = dir < 0 ? size - 1 - i : i;
      for (let j = 0; j < 2; j++) {
        const c = col - j;
        if (c < 0) continue;
        if (!func[row][c]) {
          const bit = (idx >> 3) < codewords.length ? ((codewords[idx >> 3] >> (7 - (idx & 7))) & 1) : 0;
          idx++;
          m[row][c] = bit;
        }
      }
    }
    dir = -dir;
    col -= 2;
  }
  const maskFn = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
  ];
  const penalty = function (mat) {
    let p = 0;
    for (let r = 0; r < size; r++) {
      let run = 1, prev = mat[r][0] > 1 ? 1 : mat[r][0];
      for (let c = 1; c < size; c++) {
        const v = mat[r][c] > 1 ? 1 : mat[r][c];
        if (v === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else { run = 1; prev = v; }
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1, prev = mat[0][c] > 1 ? 1 : mat[0][c];
      for (let r = 1; r < size; r++) {
        const v = mat[r][c] > 1 ? 1 : mat[r][c];
        if (v === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else { run = 1; prev = v; }
      }
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const a = mat[r][c] > 1 ? 1 : mat[r][c], b = mat[r][c + 1] > 1 ? 1 : mat[r][c + 1];
      const d = mat[r + 1][c] > 1 ? 1 : mat[r + 1][c], e = mat[r + 1][c + 1] > 1 ? 1 : mat[r + 1][c + 1];
      if (a === b && b === d && d === e) p += 3;
    }
    return p;
  };
  let bestM = 0, bestP = Infinity, best = null;
  for (let mi = 0; mi < 8; mi++) {
    const mm = m.map(function (row) { return row.slice(); });
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (func[r][c]) continue;
      if (maskFn[mi](r, c)) mm[r][c] = mm[r][c] === 1 ? 0 : 1;
    }
    const p = penalty(mm);
    if (p < bestP) { bestP = p; bestM = mi; best = mm; }
  }
  const ecBits = { L: 1, M: 0, Q: 3, H: 2 }[ecLevel];
  const fmt = function (mask) {
    let data = (ecBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  };
  const fbits = fmt(bestM);
  const bit = function (x, i) { return (x >> i) & 1; };
  const putFmt = function (mat) {
    // 副本 1（左上：纵向列8 + 横向行8）
    for (let i = 0; i <= 5; i++) { mat[i][8] = bit(fbits, i); func[i][8] = true; }
    mat[7][8] = bit(fbits, 6); func[7][8] = true;
    mat[8][8] = bit(fbits, 7); func[8][8] = true;
    mat[8][7] = bit(fbits, 8); func[8][7] = true;
    for (let i = 9; i < 15; i++) { mat[8][14 - i] = bit(fbits, i); func[8][14 - i] = true; }
    // 副本 2（左下 + 右上）
    for (let i = 0; i < 8; i++) { mat[size - 1 - i][8] = bit(fbits, i); func[size - 1 - i][8] = true; }
    for (let i = 8; i < 15; i++) { mat[8][size - 15 + i] = bit(fbits, i); func[8][size - 15 + i] = true; }
  };
  putFmt(best);
  const out = [];
  for (let r = 0; r < size; r++) out.push(best[r].map(function (v) { return v === 2 ? 1 : v; }));
  return { matrix: out, size: size, version: ver, ec: ecLevel };
}

// ---------- Code 39 ----------
const CODE39 = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000',
  '4': '000110001', '5': '100110000', '6': '001110000', '7': '000100101',
  '8': '100100100', '9': '001100100', 'A': '100001001', 'B': '001001001',
  'C': '101001000', 'D': '000011001', 'E': '100011000', 'F': '001011000',
  'G': '000001101', 'H': '100001100', 'I': '001001100', 'J': '000011100',
  'K': '100000011', 'L': '001000011', 'M': '101000010', 'N': '000010011',
  'O': '100010010', 'P': '001010010', 'Q': '000000111', 'R': '100000110',
  'S': '001000110', 'T': '000010110', 'U': '110000001', 'V': '011000001',
  'W': '111000000', 'X': '010010001', 'Y': '110010000', 'Z': '011010000',
  '-': '010000101', '.': '110000100', ' ': '011000100', '$': '010101000',
  '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100'
};
function buildCode39(text) {
  const upper = text.toUpperCase();
  const allowed = new Set(Object.keys(CODE39));
  let chars = '*';
  for (const ch of upper) {
    if (!allowed.has(ch)) throw new Error('条码仅支持：0-9 A-Z - . 空格 $ / + %');
    chars += ch;
  }
  chars += '*';
  // 生成模块序列：每个字符 9 元素 + 字符间 1 窄空（用 0 表示空隙标记）
  let elements = []; // {w, black}
  for (let ci = 0; ci < chars.length; ci++) {
    const pat = CODE39[chars[ci]];
    for (let i = 0; i < 9; i++) {
      const wide = pat[i] === '1';
      elements.push({ black: i % 2 === 0, w: wide ? 2 : 1 });
    }
    if (ci < chars.length - 1) elements.push({ black: false, w: 1 }); // 字符间隔
  }
  return elements;
}

// ---------- 渲染 ----------
function renderMatrixToCanvas(matrix, scale, quiet, cA, cB, gx0, gy0) {
  const size = matrix.length;
  const dim = (size + quiet * 2) * scale;
  // 居中：屏幕中心
  const [wx, wy] = screenToWorld(cssW() / 2, cssH() / 2);
  const ox = Math.floor(wx - dim / 2), oy = Math.floor(wy - dim / 2);
  beginStroke();
  const cells = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const col = matrix[r][c] ? cA : cB;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      cells.push([ox + (c + quiet) * scale + dx, oy + (r + quiet) * scale + dy, col]);
    }
  }
  paintCellsChunked(cells);
}
function paintCellsChunked(cells) {
  const st = qrEl('importStatus');
  st.style.display = 'block';
  let i = 0;
  (function slice() {
    const t0 = performance.now();
    while (i < cells.length && performance.now() - t0 < 24) {
      paintCellRaw(cells[i][0] + ',' + cells[i][1], cells[i][2]);
      i++;
    }
    if (i < cells.length) {
      st.textContent = '正在绘制… ' + Math.round(i / cells.length * 100) + '%';
      requestAnimationFrame(slice);
      return;
    }
    st.style.display = 'none';
    const last = cells[cells.length - 1];
    markDirtyRect(cells[0][0], cells[0][1], last[0], last[1]);
    endStroke();
    requestRender();
  })();
}

// ---------- 生成入口 ----------
function generateQrcode() {
  const text = qrEl('qrText').value;
  if (!text) { alert('请输入要编码的文本'); return; }
  const type = qrEl('qrType').value;
  const cA = qrEl('qrColA').value || '#000000';
  const cB = qrEl('qrColB').value || '#ffffff';
  const size = Math.max(3, Math.min(40, +qrEl('qrSize').value || 8));
  try {
    if (type === 'qr') {
      const { matrix } = buildQRMatrix(text, qrEl('qrEc').value || 'L');
      renderMatrixToCanvas(matrix, size, 4, cA, cB, 0, 0);
    } else {
      const elements = buildCode39(text);
      // 条码：宽 = 元素总宽，高 = size
      let width = 0;
      for (const e of elements) width += e.w;
      const [wx, wy] = screenToWorld(cssW() / 2, cssH() / 2);
      const ox = Math.floor(wx - width / 2), oy = Math.floor(wy - size / 2);
      const cells = [];
      let x = 0;
      for (const e of elements) {
        if (e.black) for (let dx = 0; dx < e.w; dx++) for (let dy = 0; dy < size; dy++) cells.push([ox + x + dx, oy + dy, cA]);
        x += e.w;
      }
      paintCellsChunked(cells);
    }
  } catch (e) {
    alert(e.message);
  }
}

// ---------- 面板开关 ----------
qrEl('btnOpenQrcode').addEventListener('click', function () {
  qrEl('qrcodePanel').classList.add('open');
});
qrEl('btnCloseQrcode').addEventListener('click', function () {
  qrEl('qrcodePanel').classList.remove('open');
});
qrEl('btnGenQrcode').addEventListener('click', generateQrcode);
