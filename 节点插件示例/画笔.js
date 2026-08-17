// ============================================================
// 画笔插件：让「实例化的对象」在画布上绘制像素（对象与笔刷像素不同：
// 对象是节点系统的实例，此插件让实例在移动时按笔刷形状把像素画到画布图层）。
// 用法：📂 导入本文件（节点编辑器 → 插件库 → 导入插件）→ 点【保存】永久保存，
//       然后在节点库「画笔」分类添加节点，或用实例化对象运行。
//
// 节点：
//   【落笔（开始绘制）】          开始绘制（每帧把笔画在实例当前位置，移动即留轨迹）
//   【抬笔（停止绘制）】          停止绘制
//   【将笔的颜色设置为A】         设置笔颜色（节点内颜色选择器）
//   【将笔的颜色增加A】           把当前笔颜色按色相增加 A（度）
//   【将笔的粗细增加B】           笔粗细 += B
//   【将笔的粗细设置B】           笔粗细 = B（不添加此节点时，默认粗细 = 笔刷大小）
//   【全部擦除节点】              擦除该对象所有实例绘制过的像素
// 绘制调用主程序通用 API：window.penAPI（drawAt / eraseObject / brushSize / color）
// ============================================================

// ---- 颜色工具（插件内实现） ----
function penHexToRgb(hex) {
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function penRgbToHex(r, g, b) {
  function cl(v) { return Math.max(0, Math.min(255, Math.round(v))); }
  function p2(v) { const s = cl(v).toString(16); return s.length === 1 ? '0' + s : s; }
  return '#' + p2(r) + p2(g) + p2(b);
}
function penRgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function penHslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return penRgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// ---- 绘制辅助（插件内实现） ----
// 注册全局步进钩子：主程序每帧更新完每个实例后调用，落笔状态下在实例当前位置绘制像素（抬笔即停止）
function penStepDraw(obj, inst) {
  const st = inst.st;
  if (!st || !st.penDown) return;
  const size = (st.penWidth === undefined || st.penWidth === null) ? window.penAPI.brushSize() : st.penWidth;
  const color = st.penColor || window.penAPI.color();
  window.penAPI.drawAt(inst.objectIdx, inst.x, inst.y, size, color);
}
if (!window.__penHookRegistered) {
  window.__penHookRegistered = true; // 编辑/重载插件时不重复注册
  window.penAPI.onStep(penStepDraw);
}

registerNodeType('penDown', {
  name: '落笔（开始绘制）',
  category: '画笔',
  flowIn: true, flowOut: true,
  desc: '开始绘制：每帧把笔（笔刷形状，粗细默认 = 笔刷大小）画在实例当前位置，实例移动即留下像素轨迹',
  run: function (inputs, inst, p, st) {
    st.penDown = true; // 开始绘制（像素由每帧步进钩子在实例当前位置绘制）
  },
});
registerNodeType('penUp', {
  name: '抬笔（停止绘制）',
  category: '画笔',
  flowIn: true, flowOut: true,
  desc: '停止绘制：抬起笔后实例移动不再留下像素',
  run: function (inputs, inst, p, st) {
    st.penDown = false;
  },
});
registerNodeType('penColorSet', {
  name: '将笔的颜色设置为A',
  category: '画笔',
  flowIn: true, flowOut: true,
  desc: '把笔的颜色设置为选择的颜色（后续绘制的像素使用该颜色）',
  params: [{ key: 'color', label: '颜色', type: 'color', def: '#000000' }],
  run: function (inputs, inst, p, st) {
    st.penColor = p.color || '#000000';
  },
});
registerNodeType('penColorAdd', {
  name: '将笔的颜色增加A',
  category: '画笔',
  flowIn: true, flowOut: true,
  desc: '把当前笔颜色按色相增加 A（度），未连线默认 0',
  sockets: [{ key: 'a', dir: 'in', type: 'num', label: 'A' }],
  run: function (inputs, inst, p, st) {
    const a = (inputs.a === null || inputs.a === undefined) ? 0 : inputs.a;
    const c = st.penColor || window.penAPI.color();
    const rgb = penHexToRgb(c);
    const hsl = penRgbToHsl(rgb[0], rgb[1], rgb[2]);
    st.penColor = penHslToHex(hsl[0] + a, hsl[1], hsl[2]);
  },
});
registerNodeType('penWidthAdd', {
  name: '将笔的粗细增加B',
  category: '画笔',
  flowIn: true, flowOut: true,
  desc: '笔的粗细（像素）增加 B，未连线默认 0',
  sockets: [{ key: 'b', dir: 'in', type: 'num', label: 'B' }],
  run: function (inputs, inst, p, st) {
    const b = (inputs.b === null || inputs.b === undefined) ? 0 : inputs.b;
    const base = (st.penWidth === undefined || st.penWidth === null) ? window.penAPI.brushSize() : st.penWidth;
    st.penWidth = Math.max(1, base + b);
  },
});
registerNodeType('penWidthSet', {
  name: '将笔的粗细设置B',
  category: '画笔',
  flowIn: true, flowOut: true,
  desc: '把笔的粗细设置为 B 像素；不添加此节点时，笔的默认粗细 = 笔刷大小',
  sockets: [{ key: 'b', dir: 'in', type: 'num', label: 'B' }],
  run: function (inputs, inst, p, st) {
    st.penWidth = (inputs.b === null || inputs.b === undefined) ? window.penAPI.brushSize() : Math.max(1, inputs.b);
  },
});
registerNodeType('penEraseAll', {
  name: '全部擦除节点',
  category: '画笔',
  flowIn: true, flowOut: true,
  desc: '擦除该对象所有实例绘制过的像素（落笔期间画下的内容）',
  run: function (inputs, inst, p, st) {
    if (window.penAPI && window.penAPI.eraseObject) window.penAPI.eraseObject(inst.objectIdx);
  },
});
