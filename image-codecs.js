// ===================================================================
// image-codecs.js —— 精简 GIF / APNG 编码器（纯 JS，零依赖）
// 用于「无限像素画布」导出动图（GIF / APNG）
// 导出时按图层顺序：每个可见图层 → 一帧
//
// 对外接口：
//   encodeGIF(frames)      frames: [{canvas, delay(ms)}]  → Uint8Array
//   encodeAPNG(frames)     frames: [{canvas, delay(ms)}]  → Uint8Array
//   decodeAnimatedImage(arrayBuffer) → { frames: [{canvas, delay}], width, height }
// ===================================================================

// ---------- 字节写入器 ----------
function ByteWriter() {
  this.data = [];
  this.writeByte = function (b) { this.data.push(b & 0xff); };
  this.writeU16 = function (v) { this.writeByte(v); this.writeByte(v >> 8); };
  this.writeU32 = function (v) {
    v = v >>> 0;
    this.writeByte(v >>> 24); this.writeByte(v >>> 16); this.writeByte(v >>> 8); this.writeByte(v);
  };
  this.writeString = function (s) { for (let i = 0; i < s.length; i++) this.writeByte(s.charCodeAt(i)); };
  this.toBytes = function () { return new Uint8Array(this.data); };
}

// ===================================================================
// GIF 编码器（GIF89a + LZW + 简单透明色）
// ===================================================================
// LZW 压缩
function GIF_LZW(minCodeSize, indices, colorCount) {
  const out = [];
  const bitBuf = [];
  let cur = 0, curBits = 0;
  function putCode(code, size) {
    cur |= code << curBits;
    curBits += size;
    while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8; }
  }
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  let nextCode = endCode + 1;
  let prev = -1;
  putCode(clearCode, codeSize);
  const resetDict = function () { dict = new Map(); nextCode = endCode + 1; codeSize = minCodeSize + 1; };
  for (let i = 0; i < indices.length; i++) {
    const c = indices[i];
    if (prev < 0) { prev = c; continue; }
    const k = prev + ',' + c;
    if (dict.has(k)) { prev = dict.get(k); continue; }
    putCode(prev, codeSize);
    if (nextCode < (1 << 12)) {
      dict.set(k, nextCode++);
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      putCode(clearCode, codeSize);
      resetDict();
    }
    prev = c;
  }
  if (prev >= 0) putCode(prev, codeSize);
  putCode(endCode, codeSize);
  if (curBits > 0) out.push(cur & 0xff);
  return { data: out, clearCode: clearCode, minCodeSize: minCodeSize };
}

function encodeGIF(frames) {
  const w = frames[0].canvas.width, h = frames[0].canvas.height;
  const writer = new ByteWriter();
  writer.writeString('GIF89a');
  writer.writeU16(w); writer.writeU16(h);
  // 全局颜色表标志 + 颜色数（256 色）
  writer.writeByte(0xF7); // GCT flag + 8-bit
  writer.writeByte(0);    // 背景色
  writer.writeByte(0);    // 像素纵横比
  // 全局颜色表（256 项，运行时填充）
  const gctOffset = writer.data.length;
  for (let i = 0; i < 768; i++) writer.writeByte(0);
  // 收集所有帧的颜色
  const palette = [];
  const colorMap = new Map();
  function colorIdx(r, g, b, a) {
    // 透明 → 0 号色（用黑色占位，透明帧后面处理）
    if (a < 128) return 0;
    const key = r + ',' + g + ',' + b;
    if (colorMap.has(key)) return colorMap.get(key);
    // 0 号色保留给透明
    let idx = colorMap.size + 1;
    if (idx > 255) { idx = 1 + ((colorMap.size * 2654435761) >>> 8) % 255; } // 溢出兜底
    if (colorMap.has(key)) return colorMap.get(key);
    colorMap.set(key, idx);
    if (palette.length < 255) palette.push([r, g, b]);
    return idx;
  }
  // 预扫描所有帧建立调色板
  const frameDatas = frames.map(function (f) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.drawImage(f.canvas, 0, 0);
    const d = cx.getImageData(0, 0, w, h).data;
    // 找出透明像素数量，若整帧全透明则仍用调色板
    let hasTransparent = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 128) { hasTransparent = true; break; }
    return { d: d, transparent: hasTransparent };
  });
  // 构建全局调色板
  const paletteBytes = new Uint8Array(768);
  // 0 号色：透明/黑色
  paletteBytes[0] = 0; paletteBytes[1] = 0; paletteBytes[2] = 0;
  for (const fd of frameDatas) {
    const d = fd.d;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue; // 透明跳过
      const key = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
      if (!colorMap.has(key)) {
        colorMap.set(key, colorMap.size + 1);
      }
    }
  }
  // 填充调色板（最多 256 色，超出取近似）
  let pi = 1;
  for (const [key] of colorMap) {
    if (pi > 255) break;
    const parts = key.split(',');
    paletteBytes[pi * 3] = +parts[0];
    paletteBytes[pi * 3 + 1] = +parts[1];
    paletteBytes[pi * 3 + 2] = +parts[2];
    pi++;
  }
  // 写入调色板
  for (let i = 0; i < 768; i++) writer.data[gctOffset + i] = paletteBytes[i];

  // 帧数据
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const delay = Math.max(2, Math.round((f.delay || 100) / 10)); // 百分之一秒
    const d = frameDatas[fi].d;
    const indices = new Uint8Array(w * h);
    let hasTransparent = false;
    for (let i = 0, pi = 0; i < d.length; i += 4, pi++) {
      if (d[i + 3] < 128) { indices[pi] = 0; hasTransparent = true; }
      else {
        const key = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
        const idx = colorMap.get(key);
        indices[pi] = idx === undefined ? 0 : idx;
      }
    }
    writer.writeByte(0x21); writer.writeByte(0xF9); // 图形控制扩展
    writer.writeByte(4);                             // 块大小
    writer.writeByte(hasTransparent ? 0x09 : 0x04);  // 透明标志
    writer.writeU16(delay);
    writer.writeByte(0); // 透明色索引
    writer.writeByte(0); // 块终止
    writer.writeByte(0x2C); // 图像描述符
    writer.writeU16(0); writer.writeU16(0); writer.writeU16(w); writer.writeU16(h);
    writer.writeByte(0x00); // 无局部颜色表
    // 每行起始写一个最小码长子块
    writer.writeByte(0x08);
    const lzw = GIF_LZW(8, Array.from(indices));
    const chunks = [];
    let i = 0;
    while (i < lzw.data.length) {
      const n = Math.min(255, lzw.data.length - i);
      chunks.push(n);
      for (let j = 0; j < n; j++) chunks.push(lzw.data[i + j]);
      i += n;
    }
    chunks.push(0);
    for (const b of chunks) writer.writeByte(b);
  }
  writer.writeByte(0x3B); // 尾
  return writer.toBytes();
}

// ===================================================================
// APNG 编码器（PNG + acTL/fcTL/fdAT 帧块）
// ===================================================================
function crc32Table() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = crc32Table();
function crc32(data, off, len) {
  let c = 0xFFFFFFFF;
  for (let i = off; i < off + len; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(writer, type, payload) {
  writer.writeU32(payload.length);
  const typeOff = writer.data.length;
  writer.writeString(type);
  for (const b of payload) writer.writeByte(b);
  const crc = crc32(writer.data, typeOff, 4 + payload.length);
  writer.writeU32(crc);
}

function encodeAPNG(frames) {
  const w = frames[0].canvas.width, h = frames[0].canvas.height;
  const writer = new ByteWriter();
  // PNG 签名
  writer.writeByte(0x89); writer.writeByte(0x50); writer.writeByte(0x4E); writer.writeByte(0x47);
  writer.writeByte(0x0D); writer.writeByte(0x0A); writer.writeByte(0x1A); writer.writeByte(0x0A);
  // IHDR
  {
    const p = new ByteWriter();
    p.writeU32(w); p.writeU32(h); p.writeByte(8); p.writeByte(6); p.writeByte(0); p.writeByte(0); p.writeByte(0);
    pngChunk(writer, 'IHDR', p.data);
  }
  // acTL
  {
    const p = new ByteWriter();
    p.writeU32(frames.length); p.writeU32(0);
    pngChunk(writer, 'acTL', p.data);
  }
  // 每帧：fcTL + IDAT（首帧）或 fcTL + fdAT
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const delay = Math.max(1, Math.round((f.delay || 100) * 1000)); // 微秒
    // fcTL
    {
      const p = new ByteWriter();
      p.writeU32(fi); // sequence
      p.writeU32(w); p.writeU32(h); p.writeU32(0); p.writeU32(0);
      p.writeU16(delay / 1000); p.writeU16(delay % 1000);
      p.writeByte(0); p.writeByte(0); // dispose/blend
      pngChunk(writer, 'fcTL', p.data);
    }
    // 帧像素 → RGBA
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.clearRect(0, 0, w, h);
    cx.drawImage(f.canvas, 0, 0);
    const d = cx.getImageData(0, 0, w, h).data;
    // 过滤类型 0 每行（简化：用类型 0，PNG 允许）
    const stride = w * 4;
    const raw = new Uint8Array(h * (stride + 1));
    for (let y = 0; y < h; y++) {
      raw[y * (stride + 1)] = 0;
      raw.set(d.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const deflated = deflateRaw(raw);
    if (fi === 0) {
      pngChunk(writer, 'IDAT', deflated);
    } else {
      const p = new ByteWriter();
      p.writeU32(fi); // fdAT sequence（从1开始，0 被 fcTL 使用）
      for (const b of deflated) p.writeByte(b);
      pngChunk(writer, 'fdAT', p.data);
    }
  }
  pngChunk(writer, 'IEND', []);
  return writer.toBytes();
}

// ---------- 极简 deflate（存储模式 stored blocks，无压缩）----------
// PNG 规范允许 stored（非压缩）deflate 块，生成简单且正确
function deflateRaw(data) {
  // zlib header
  const out = [0x78, 0x01];
  let i = 0;
  while (i < data.length) {
    const n = Math.min(65535, data.length - i);
    const last = (i + n >= data.length) ? 1 : 0;
    out.push(last);
    // LEN + NLEN
    out.push(n & 0xff); out.push((n >> 8) & 0xff);
    const nlen = (~n) & 0xffff;
    out.push(nlen & 0xff); out.push((nlen >> 8) & 0xff);
    for (let j = 0; j < n; j++) out.push(data[i + j]);
    i += n;
  }
  // adler32
  let a = 1, b = 0;
  for (let j = 0; j < data.length; j++) {
    a = (a + data[j]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  out.push((adler >>> 24) & 0xff);
  out.push((adler >>> 16) & 0xff);
  out.push((adler >>> 8) & 0xff);
  out.push(adler & 0xff);
  return new Uint8Array(out);
}

// ===================================================================
// 动图解码：GIF / APNG → 帧序列（canvas 数组）
// 优先使用 WebCodecs ImageDecoder（现代浏览器原生支持 GIF/APNG 逐帧），
// 不支持时回退为单帧导入（仅取第一帧）。
// ===================================================================
function decodeAnimatedImage(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const isGif = u8.length > 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46;
  const isPng = u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47;
  if (!isGif && !isPng) return null;
  const isAnimated = isGif || (isPng && findPNGChunk(u8, 'acTL') >= 0);
  if (!isAnimated) return null;
  return decodeWithImageDecoder(arrayBuffer).catch(function () {
    // 回退：GIF/APNG 取第一帧
    return decodeSingleImageFrame(arrayBuffer);
  });
}

// 使用 WebCodecs ImageDecoder 逐帧解码（每帧 → {canvas, delay}）
function decodeWithImageDecoder(arrayBuffer) {
  return new Promise(function (resolve, reject) {
    if (typeof ImageDecoder === 'undefined') return reject(new Error('no ImageDecoder'));
    let decoder = null;
    try {
      decoder = new ImageDecoder({ data: arrayBuffer, type: 'image/' + (isGIFBuffer(arrayBuffer) ? 'gif' : 'png') });
    } catch (e) { return reject(e); }
    decoder.tracks.ready.then(function () {
      const total = decoder.tracks.selectedTrack.frameCount;
      const frameCount = total > 0 ? total : 1;
      const frames = [];
      const delays = [];
      let i = 0;
      (function next() {
        if (i >= frameCount) {
          decoder.close();
          // 填充 canvas 帧
          try { resolve({ frames: frames, width: frames[0].canvas.width, height: frames[0].canvas.height }); }
          catch (e) { reject(e); }
          return;
        }
        decoder.decode({ frameIndex: i }).then(function (result) {
          const vf = result.image;
          const c = document.createElement('canvas');
          c.width = vf.displayWidth || vf.codedWidth;
          c.height = vf.displayHeight || vf.codedHeight;
          const cx = c.getContext('2d');
          cx.clearRect(0, 0, c.width, c.height);
          cx.drawImage(vf, 0, 0);
          vf.close();
          const delay = result.duration === undefined ? 100 : (result.duration / 1000);
          frames.push({ canvas: c, delay: delay });
          i++;
          next();
        }).catch(function (e) { reject(e); });
      })();
    }).catch(reject);
  });
}
function isGIFBuffer(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  return u8.length > 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46;
}
function findPNGChunk(u8, type) {
  let off = 8;
  while (off + 8 <= u8.length) {
    const len = (u8[off] << 24 | u8[off + 1] << 16 | u8[off + 2] << 8 | u8[off + 3]) >>> 0;
    const t = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    if (t === type) return off;
    if (t === 'IEND') break;
    off += 12 + len;
  }
  return -1;
}

function decodeSingleImageFrame(arrayBuffer) {
  return new Promise(function (resolve, reject) {
    const blob = new Blob([arrayBuffer], { type: 'image/gif' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = function () {
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve({ frames: [{ canvas: c, delay: 100 }], width: w, height: h });
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('GIF 解码失败')); };
    img.src = url;
  });
}

// ===================================================================
// 导出接口
// ===================================================================
if (typeof window !== 'undefined') {
  window.encodeGIF = encodeGIF;
  window.encodeAPNG = encodeAPNG;
  window.decodeAnimatedImage = decodeAnimatedImage;
}
