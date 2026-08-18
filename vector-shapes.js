// ===================================================================
// vector-shapes.js —— 内嵌矢量绘图工具（自包含）
// 在「无限像素画布」里顺手画矢量标注/图形：矩形 / 椭圆 / 直线 + 选择 / 顶点编辑
//
// 形状数据存于每图层 L.shapes（工程导出 v2/v3/v5 已支持，无需改动）；
// 本文件不修改其他系统逻辑，仅通过以下钩子与 pixel-canvas.js 协作
// （pixel-canvas.js 中均为 typeof 检测调用，未加载本文件时零影响）：
//   window.__vshapeDown(e) / __vshapeMove(e) / __vshapeUp(e) / __vshapeKey(e)
//   window.__vshapeLayer(p, li) / __vshapeOverlay(p)
// 依赖 pixel-canvas.js 全局：state / ctx / screenToWorld / requestRender / cssW / cssH / dpr
// ===================================================================
'use strict';

const VS = {
  active: false,            // 矢量模式开关：false 时完全不接管画布（像素工具正常）
  tool: 'vselect',          // vselect | vrect | vtri | vellipse | vline | vvertex
  stroke: '#3b82f6',
  sw: 2,                    // 线宽（屏幕像素，缩放时恒定）
  fillOn: true,             // 填充开关
  fillColor: '#3b82f6',     // 填充颜色
  fillAlpha: 18,            // 填充透明度 0-100（默认 18% 浅色，标注不遮内容）
  snap: true,               // 网格+顶点吸附
  selected: new Set(),      // 选中的形状 id
  nextId: 1,
  undoStack: [], redoStack: [],
  MAX_HISTORY: 50,
  // 交互状态
  drawing: null,            // { type, x0, y0, x1, y1 } 绘制中（vpen 时为 { type:'vpen', pts:[] }）
  bezierPts: null,          // 贝塞尔绘制中的点集
  bezierLastT: 0,           // 上一次加点时间（双击检测）
  ellipseMode: 'free',      // 椭圆工具形式：'free' 自由椭圆（拖动）| 'circle' 正圆（拖动）| '2point' 两点画圆
  ellipsePts: null,         // 两点画圆：已点集（圆心 → 半径点）
  triMode: 'drag',          // 三角形工具形式：'drag' 拖动画三角 | '3point' 三点画三角
  triPts: null,             // 三点画三角：已点集
  previewPt: null,          // 点击式工具的鼠标预览点（世界坐标）
  drag: null,               // { ids, dx, dy } 拖动选中的形状
  vertexDrag: null,         // { id, vi } 拖顶点
  down: false,
};

// ---------------- 纯函数（移植自无限矢量画图） ----------------
function vsDistToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function vsShapePoints(sh) {
  if (sh.type === 'rect') return [[sh.x, sh.y], [sh.x + sh.w, sh.y], [sh.x + sh.w, sh.y + sh.h], [sh.x, sh.y + sh.h]];
  if (sh.type === 'triangle') return sh.pts.map(function (p) { return p.slice(); });
  if (sh.type === 'ellipse') return [[sh.cx - sh.rx, sh.cy], [sh.cx + sh.rx, sh.cy], [sh.cx, sh.cy - sh.ry], [sh.cx, sh.cy + sh.ry]];
  if (sh.type === 'circle') return [[sh.cx, sh.cy], [sh.cx - sh.r, sh.cy], [sh.cx + sh.r, sh.cy], [sh.cx, sh.cy - sh.r], [sh.cx, sh.cy + sh.r]];
  if (sh.type === 'line') return [[sh.x1, sh.y1], [sh.x2, sh.y2]];
  if (sh.type === 'polyline' || sh.type === 'bezier' || sh.type === 'triangle') return sh.pts.map(function (p) { return p.slice(); });
  return [];
}
function vsShapeBBox(sh) {
  if (sh.type === 'rect') return [sh.x, sh.y, sh.x + sh.w, sh.y + sh.h];
  if (sh.type === 'ellipse') return [sh.cx - sh.rx, sh.cy - sh.ry, sh.cx + sh.rx, sh.cy + sh.ry];
  if (sh.type === 'circle') return [sh.cx - sh.r, sh.cy - sh.r, sh.cx + sh.r, sh.cy + sh.r];
  if (sh.type === 'line') return [Math.min(sh.x1, sh.x2), Math.min(sh.y1, sh.y2), Math.max(sh.x1, sh.x2), Math.max(sh.y1, sh.y2)];
  const pts = sh.pts || [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [x0, y0, x1, y1];
}
function vsShapeEdges(sh) {
  if (sh.type === 'line') return [[[sh.x1, sh.y1], [sh.x2, sh.y2]]];
  if (sh.type === 'rect') return [
    [[sh.x, sh.y], [sh.x + sh.w, sh.y]], [[sh.x + sh.w, sh.y], [sh.x + sh.w, sh.y + sh.h]],
    [[sh.x + sh.w, sh.y + sh.h], [sh.x, sh.y + sh.h]], [[sh.x, sh.y + sh.h], [sh.x, sh.y]],
  ];
  if (sh.type === 'triangle' || sh.type === 'polyline' || sh.type === 'bezier') {
    const p = sh.pts, out = [];
    for (let i = 0; i < p.length - 1; i++) out.push([p[i], p[i + 1]]);
    if ((sh.closed || sh.type === 'triangle') && p.length > 2) out.push([p[p.length - 1], p[0]]);
    return out;
  }
  if (sh.type === 'circle') {
    const out = [];
    for (let i = 0; i < 32; i++) {
      const a0 = i / 32 * Math.PI * 2, a1 = (i + 1) / 32 * Math.PI * 2;
      out.push([[sh.cx + sh.r * Math.cos(a0), sh.cy + sh.r * Math.sin(a0)], [sh.cx + sh.r * Math.cos(a1), sh.cy + sh.r * Math.sin(a1)]]);
    }
    return out;
  }
  if (sh.type === 'ellipse') {
    const out = [];
    for (let i = 0; i < 32; i++) {
      const a0 = i / 32 * Math.PI * 2, a1 = (i + 1) / 32 * Math.PI * 2;
      out.push([[sh.cx + sh.rx * Math.cos(a0), sh.cy + sh.ry * Math.sin(a0)], [sh.cx + sh.rx * Math.cos(a1), sh.cy + sh.ry * Math.sin(a1)]]);
    }
    return out;
  }
  return [];
}
function vsSetPoint(sh, idx, x, y) {
  if (sh.type === 'rect') {
    const v = [[sh.x, sh.y], [sh.x + sh.w, sh.y], [sh.x + sh.w, sh.y + sh.h], [sh.x, sh.y + sh.h]];
    const diag = (idx + 2) % 4;
    v[idx] = [x, y];
    const d = v[diag];
    sh.x = Math.min(x, d[0]); sh.y = Math.min(y, d[1]);
    sh.w = Math.abs(x - d[0]); sh.h = Math.abs(y - d[1]);
  } else if (sh.type === 'triangle' || sh.type === 'polyline' || sh.type === 'bezier') {
    sh.pts[idx] = [x, y];
  } else if (sh.type === 'ellipse') {
    if (idx < 2) sh.rx = Math.max(0.5, Math.abs(x - sh.cx));
    else sh.ry = Math.max(0.5, Math.abs(y - sh.cy));
  } else if (sh.type === 'circle') {
    if (idx === 0) { sh.cx = x; sh.cy = y; }
    else sh.r = Math.max(0.5, Math.hypot(x - sh.cx, y - sh.cy));
  } else if (sh.type === 'line') {
    if (idx === 0) { sh.x1 = x; sh.y1 = y; } else { sh.x2 = x; sh.y2 = y; }
  }
}
function vsPointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function vsShapeContains(px, py, sh) {
  if (sh.type === 'rect') return px >= sh.x && px <= sh.x + sh.w && py >= sh.y && py <= sh.y + sh.h;
  if (sh.type === 'ellipse') return Math.pow((px - sh.cx) / sh.rx, 2) + Math.pow((py - sh.cy) / sh.ry, 2) <= 1;
  if (sh.type === 'circle') return Math.hypot(px - sh.cx, py - sh.cy) <= sh.r;
  if (sh.type === 'triangle') return vsPointInPoly(px, py, sh.pts);
  if (sh.type === 'polyline' && sh.closed) return vsPointInPoly(px, py, sh.pts);
  return false;
}
// 绘制形状到 ctx（世界坐标变换下；lwScale = 1/scale，线宽按屏幕像素恒定）
function vsDrawShape(ctx, sh, lwScale) {
  ctx.beginPath();
  if (sh.type === 'rect') ctx.rect(sh.x, sh.y, sh.w, sh.h);
  else if (sh.type === 'triangle' || sh.type === 'polyline') {
    const pts = sh.pts;
    const brk = sh.breaks || [];
    let bi = 1; // breaks[0] 恒为 0（首子路径起点已 moveTo），从第二个断点开始匹配
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      if (bi < brk.length && i === brk[bi]) { ctx.moveTo(pts[i][0], pts[i][1]); bi++; } // 子路径起点：断开连线
      else ctx.lineTo(pts[i][0], pts[i][1]);
    }
    if ((sh.closed || sh.type === 'triangle') && !sh.breaks) ctx.closePath(); // 多子路径不整体闭合（fill 自动闭合各子路径）
  } else if (sh.type === 'ellipse') ctx.ellipse(sh.cx, sh.cy, sh.rx, sh.ry, 0, 0, Math.PI * 2);
  else if (sh.type === 'circle') { ctx.moveTo(sh.cx + sh.r, sh.cy); ctx.arc(sh.cx, sh.cy, sh.r, 0, Math.PI * 2); }
  else if (sh.type === 'bezier') {
    // Catmull-Rom 平滑曲线（与无限矢量画图一致）
    const pts = sh.pts;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
  }
  else if (sh.type === 'line') { ctx.moveTo(sh.x1, sh.y1); ctx.lineTo(sh.x2, sh.y2); }
  if (sh.fill && sh.type !== 'line' && sh.type !== 'bezier' && (sh.type !== 'polyline' || sh.closed || sh.breaks)) {
    ctx.fillStyle = sh.fill;
    // evenodd 镂空 / nonzero（SVG 导出通常已保证内外环方向相反）
    if (sh.fillRule === 'evenodd') ctx.fill('evenodd');
    else ctx.fill();
  }
  // 描边（SVG 导入的形状可能无描边：stroke 为空 / none）
  if (sh.stroke && sh.stroke !== 'none') {
    ctx.strokeStyle = sh.stroke;
    ctx.lineWidth = Math.max(0.5, sh.sw / lwScale);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
  }
}
// 命中形状：内部优先（封闭形状），其次边缘距离（细线/开放形状）
function vsHitShape(wx, wy) {
  const li = state.activeLayer;
  const L = state.layers[li];
  if (!L) return null;
  const bd = 6 / state.scale; // 屏幕 6px
  for (let i = L.shapes.length - 1; i >= 0; i--) {
    const sh = L.shapes[i];
    if (vsShapeContains(wx, wy, sh)) return sh;
  }
  for (let i = L.shapes.length - 1; i >= 0; i--) {
    const sh = L.shapes[i];
    for (const e of vsShapeEdges(sh)) {
      if (vsDistToSeg(wx, wy, e[0][0], e[0][1], e[1][0], e[1][1]) < bd) return sh;
    }
  }
  return null;
}
// 命中顶点（仅活动图层，容差屏幕 10px）
function vsHitVertex(wx, wy) {
  const li = state.activeLayer;
  const L = state.layers[li];
  if (!L) return null;
  let best = null, bd = 10 / state.scale;
  for (let i = L.shapes.length - 1; i >= 0; i--) {
    const sh = L.shapes[i];
    const pts = vsShapePoints(sh);
    for (let vi = 0; vi < pts.length; vi++) {
      const d = Math.hypot(wx - pts[vi][0], wy - pts[vi][1]);
      if (d < bd) { bd = d; best = { sh: sh, vi: vi }; }
    }
  }
  return best;
}
// 吸附：顶点吸附 + 整数格吸附（像素画布格子 = 1）
function vsSnapPoint(x, y) {
  if (!VS.snap) return [x, y];
  const li = state.activeLayer;
  const L = state.layers[li];
  const bd = 8 / state.scale;
  if (L) {
    for (const sh of L.shapes) {
      for (const p of vsShapePoints(sh)) {
        if (Math.hypot(p[0] - x, p[1] - y) < bd) return [p[0], p[1]];
      }
    }
  }
  return [Math.round(x), Math.round(y)];
}

// ---------------- 工具 / 撤销 ----------------
function vsActiveLayer() { return state.layers[state.activeLayer]; }
function vsClone() {
  return state.layers.map(function (L) { return { li: state.layers.indexOf(L), shapes: L.shapes.map(function (s) { return JSON.parse(JSON.stringify(s)); }) }; });
}
function vsPushHistory() {
  window.__vsLastEdit = 'vector'; // 撤销分派：最近操作类型
  VS.undoStack.push(vsClone());
  if (VS.undoStack.length > VS.MAX_HISTORY) VS.undoStack.shift();
  VS.redoStack.length = 0;
}
function vsRestore(snap) {
  for (const rec of snap) {
    const L = state.layers[rec.li];
    if (!L) continue;
    L.shapes.length = 0;
    for (const s of rec.shapes) L.shapes.push(s);
  }
  VS.selected.clear();
  requestRender();
}
function vsUndo() {
  if (!VS.undoStack.length) return false;
  VS.redoStack.push(vsClone());
  vsRestore(VS.undoStack.pop());
  return true;
}
function vsRedo() {
  if (!VS.redoStack.length) return false;
  VS.undoStack.push(vsClone());
  vsRestore(VS.redoStack.pop());
  return true;
}
function vsSetTool(t) {
  VS.active = true; // 选择矢量工具 = 进入矢量模式
  VS.tool = t;
  VS.selected.clear();
  VS.drawing = null; VS.drag = null; VS.vertexDrag = null;
  VS.bezierPts = null; VS.ellipsePts = null; VS.triPts = null; VS.previewPt = null; // 切换工具时取消未完成的点击式绘制
  updateVsMenu();
  if (typeof syncToolUI === 'function') syncToolUI(); // 像素工具栏互斥：矢量绘制激活时像素工具不高亮
  requestRender();
}
// 矢量绘制工具是否激活（用于像素工具栏互斥显示）
window.__vshapeIsDrawActive = function () { return !!VS.tool; };
// 切到「移动工具」选择模式（保持矢量模式，用于选中/拖动/顶点编辑）
function vsUseMoveTool() {
  if (typeof state !== 'undefined' && state) state.tool = 'move';
  if (typeof syncToolUI === 'function') syncToolUI();
  VS.drawing = null; VS.drag = null; VS.vertexDrag = null; VS.bezierPts = null;
  requestRender();
}
// 像素工具被选中：退出矢量模式，完全放行像素逻辑
window.__vshapePixelTool = function () {
  VS.active = false;
  VS.tool = ''; // 清空矢量绘制工具（避免残留导致误拦截）
  VS.drawing = null; VS.drag = null; VS.vertexDrag = null; VS.bezierPts = null;
  VS.selected.clear();
  if (vsMenuEl) vsMenuEl.style.display = 'none';
  updateVsMenu();
  if (typeof syncToolUI === 'function') syncToolUI();
  requestRender();
};
// 切换到移动/框选等「形状友好」像素工具：清空矢量绘制工具但保持矢量模式（形状选择/框选仍可用）
window.__vshapeClearTool = function () {
  VS.tool = '';
  VS.drawing = null; VS.drag = null; VS.vertexDrag = null; VS.bezierPts = null;
  updateVsMenu();
  if (typeof syncToolUI === 'function') syncToolUI();
  requestRender();
};
function vsAddShapeRaw(sh) {
  const L = vsActiveLayer();
  if (!L) return;
  vsPushHistory();
  sh.id = vsNextShapeId();
  L.shapes.push(sh);
  VS.selected.clear();
  VS.selected.add(sh.id);
  requestRender(); // 保持当前绘制工具，方便连续绘制；编辑用移动工具 / V 键
}
function vsAddShape(type, x0, y0, x1, y1) {
  const L = vsActiveLayer();
  if (!L) return;
  vsPushHistory();
  const id = vsNextShapeId();
  let sh;
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  const fill = VS.fillOn ? vsFillStr() : '';
  if (type === 'vrect') sh = { id: id, type: 'rect', x: x, y: y, w: w, h: h, stroke: VS.stroke, sw: VS.sw, fill: fill };
  else if (type === 'vellipse') {
    if (VS.ellipseMode === 'circle') {
      // 正圆：直径 = 拖动距离，中心 = 中点
      const r = Math.max(0.5, Math.hypot(x1 - x0, y1 - y0) / 2);
      sh = { id: id, type: 'ellipse', cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: r, ry: r, stroke: VS.stroke, sw: VS.sw, fill: fill };
    } else {
      sh = { id: id, type: 'ellipse', cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: w / 2, ry: h / 2, stroke: VS.stroke, sw: VS.sw, fill: fill };
    }
  }
  else if (type === 'vtri') {
    // 正 / 倒三角形（与像素画布三角形工具一致）：顶点在拖动的另一端
    const midX = (x + x + w) / 2;
    const pts = (y1 >= y0) ? [[midX, y], [x, y + h], [x + w, y + h]] : [[midX, y + h], [x, y], [x + w, y]];
    sh = { id: id, type: 'triangle', pts: pts, stroke: VS.stroke, sw: VS.sw, fill: fill };
  }
  else if (type === 'vline') sh = { id: id, type: 'line', x1: x0, y1: y0, x2: x1, y2: y1, stroke: VS.stroke, sw: VS.sw, fill: '' };
  else return;
  L.shapes.push(sh);
  VS.selected.clear();
  VS.selected.add(id);
  requestRender(); // 保持当前绘制工具，方便连续绘制；编辑用移动工具 / V 键
}
function vsFillStr() {
  if (!VS.fillOn) return '';
  let h = VS.fillColor.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + (VS.fillAlpha / 100) + ')';
}
function vsDeleteSelected() {
  if (!VS.selected.size) return;
  const L = vsActiveLayer();
  if (!L) return;
  vsPushHistory();
  L.shapes = L.shapes.filter(function (s) { return !VS.selected.has(s.id); });
  VS.selected.clear();
  requestRender();
}
// 完成贝塞尔绘制：生成 bezier 形状并回到选择工具
function vsFinishBezier() {
  if (VS.bezierPts && VS.bezierPts.length >= 2) {
    vsAddShapeRaw({ type: 'bezier', pts: VS.bezierPts.slice(), stroke: VS.stroke, sw: VS.sw, fill: '' });
  }
  VS.bezierPts = null;
  requestRender();
}

// ---------------- SVG 矢量导入（移植自无限矢量画图） ----------------
// ---------------- SVG 矢量导入（增强版：transform / 相对路径 / viewBox / 居中） ----------------
// 平移一个形状（dx, dy 世界单位）
function vsTranslateShape(sh, dx, dy) {
  if (sh.type === 'rect') { sh.x += dx; sh.y += dy; }
  else if (sh.type === 'ellipse' || sh.type === 'circle') { sh.cx += dx; sh.cy += dy; }
  else if (sh.type === 'line') { sh.x1 += dx; sh.y1 += dy; sh.x2 += dx; sh.y2 += dy; }
  else if (sh.pts) { for (const p of sh.pts) { p[0] += dx; p[1] += dy; } }
}
// 应用 SVG transform 属性（translate / scale / matrix / rotate）
// SVG 语义：多个变换按「从右到左」应用（先应用列表最后的变换）
function vsTransformShape(sh, t) {
  if (!t) return;
  const re = /(translate|scale|matrix|rotate)\(([^)]*)\)/g;
  const funcs = [];
  let m;
  while ((m = re.exec(t)) !== null) funcs.push({ fn: m[1], args: m[2].split(/[\s,]+/).map(Number) });
  for (let fi = funcs.length - 1; fi >= 0; fi--) {
    const m2 = funcs[fi];
    const args = m2.args;
    if (m2.fn === 'translate') {
      vsTranslateShape(sh, args[0] || 0, args[1] || 0);
    } else if (m2.fn === 'scale') {
      const sx = args[0] || 1, sy = args.length > 1 ? args[1] : sx;
      if (sh.type === 'rect') { sh.x *= sx; sh.y *= sy; sh.w *= sx; sh.h *= sy; }
      else if (sh.type === 'ellipse' || sh.type === 'circle') { sh.cx *= sx; sh.cy *= sy; sh.rx *= sx; sh.ry *= sy; }
      else if (sh.type === 'line') { sh.x1 *= sx; sh.y1 *= sy; sh.x2 *= sx; sh.y2 *= sy; }
      else if (sh.pts) { for (const p of sh.pts) { p[0] *= sx; p[1] *= sy; } }
    } else if (m[1] === 'matrix') {
      const a = args[0] || 1, b = args[1] || 0, c = args[2] || 0, d = args[3] || 1, e = args[4] || 0, f = args[5] || 0;
      const tf = function (x, y) { return [a * x + c * y + e, b * x + d * y + f]; };
      if (sh.type === 'rect') {
        // 4 角变换后重算轴对齐包围盒（旋转近似）
        const pts = [[sh.x, sh.y], [sh.x + sh.w, sh.y], [sh.x + sh.w, sh.y + sh.h], [sh.x, sh.y + sh.h]].map(function (p) { return tf(p[0], p[1]); });
        const xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
        sh.x = Math.min.apply(null, xs); sh.y = Math.min.apply(null, ys);
        sh.w = Math.max.apply(null, xs) - sh.x; sh.h = Math.max.apply(null, ys) - sh.y;
      } else if (sh.type === 'ellipse' || sh.type === 'circle') {
        const c2 = tf(sh.cx, sh.cy);
        sh.cx = c2[0]; sh.cy = c2[1];
        const r2 = tf(sh.cx + (sh.rx || sh.r || 1), sh.cy);
        const s = Math.hypot(r2[0] - c2[0], r2[1] - c2[1]) / (sh.rx || sh.r || 1);
        sh.rx = (sh.rx || sh.r || 1) * s; sh.ry = (sh.ry || sh.rx || sh.r || 1) * s;
      } else if (sh.type === 'line') {
        const p1 = tf(sh.x1, sh.y1), p2 = tf(sh.x2, sh.y2);
        sh.x1 = p1[0]; sh.y1 = p1[1]; sh.x2 = p2[0]; sh.y2 = p2[1];
      } else if (sh.pts) {
        for (const p of sh.pts) { const q = tf(p[0], p[1]); p[0] = q[0]; p[1] = q[1]; }
      }
    } else if (m[1] === 'rotate') {
      const ang = (args[0] || 0) * Math.PI / 180;
      const ox = args[1] || 0, oy = args[2] || 0;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const tf = function (x, y) { const dx = x - ox, dy = y - oy; return [ox + dx * cos - dy * sin, oy + dx * sin + dy * cos]; };
      if (sh.type === 'rect') {
        const pts = [[sh.x, sh.y], [sh.x + sh.w, sh.y], [sh.x + sh.w, sh.y + sh.h], [sh.x, sh.y + sh.h]].map(function (p) { return tf(p[0], p[1]); });
        const xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
        sh.x = Math.min.apply(null, xs); sh.y = Math.min.apply(null, ys);
        sh.w = Math.max.apply(null, xs) - sh.x; sh.h = Math.max.apply(null, ys) - sh.y;
      } else if (sh.type === 'ellipse' || sh.type === 'circle') {
        const c2 = tf(sh.cx, sh.cy); sh.cx = c2[0]; sh.cy = c2[1];
      } else if (sh.type === 'line') {
        const p1 = tf(sh.x1, sh.y1), p2 = tf(sh.x2, sh.y2);
        sh.x1 = p1[0]; sh.y1 = p1[1]; sh.x2 = p2[0]; sh.y2 = p2[1];
      } else if (sh.pts) {
        for (const p of sh.pts) { const q = tf(p[0], p[1]); p[0] = q[0]; p[1] = q[1]; }
      }
    }
  }
}
// 贝塞尔采样点（三次）
function vsBezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
function vsBezierPoint2(p0, p1, p2, t) {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}
// 解析 path 的 d：支持 M/L/H/V/C/S/Q/T/A/Z（含小写相对命令，曲线采样 8 段，A 弧线近似直线）。
// 返回子路径数组 [{ pts, closed }]（每个 M... 一段，避免子路径之间错误连线）
function vsParsePathD(d) {
  const paths = [];
  let cur = null;
  const re = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
  const tokens = [];
  let m;
  while ((m = re.exec(d)) !== null) tokens.push(m[0]);
  let i = 0, cx = 0, cy = 0, startX = 0, startY = 0, cmd = '';
  const num = function () { return parseFloat(tokens[i++]); };
  const relCur = function (rel, v, cur) { return rel ? cur + v : v; };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(t)) {
      cmd = t; i++;
      if (cmd === 'Z' || cmd === 'z') { if (cur) cur.closed = true; cx = startX; cy = startY; continue; }
      if (cmd === 'M' || cmd === 'm') {
        // 新子路径：先收尾上一段
        if (cur && cur.pts.length) { paths.push(cur); }
        cur = { pts: [], closed: false };
        cx = relCur(cmd === 'm', num(), cx); cy = relCur(cmd === 'm', num(), cy);
        startX = cx; startY = cy;
        cur.pts.push([cx, cy]);
        continue;
      }
      continue;
    }
    const C = cmd.toUpperCase();
    const rel = cmd !== C;
    if (!cur) { cur = { pts: [], closed: false }; }
    if (C === 'L') {
      cx = relCur(rel, num(), cx); cy = relCur(rel, num(), cy);
      cur.pts.push([cx, cy]);
    } else if (C === 'H') {
      cx = relCur(rel, num(), cx);
      cur.pts.push([cx, cy]);
    } else if (C === 'V') {
      cy = relCur(rel, num(), cy);
      cur.pts.push([cx, cy]);
    } else if (C === 'C' || C === 'S') {
      const sx = cx, sy = cy;
      const x1 = relCur(rel, num(), cx), y1 = relCur(rel, num(), cy);
      const x2 = relCur(rel, num(), cx), y2 = relCur(rel, num(), cy);
      cx = relCur(rel, num(), cx); cy = relCur(rel, num(), cy);
      for (let k = 1; k <= 8; k++) {
        const tt = k / 8;
        cur.pts.push([vsBezierPoint(sx, x1, x2, cx, tt), vsBezierPoint(sy, y1, y2, cy, tt)]);
      }
    } else if (C === 'Q' || C === 'T') {
      const sx = cx, sy = cy;
      const x1 = relCur(rel, num(), cx), y1 = relCur(rel, num(), cy);
      cx = relCur(rel, num(), cx); cy = relCur(rel, num(), cy);
      for (let k = 1; k <= 8; k++) {
        const tt = k / 8;
        cur.pts.push([vsBezierPoint2(sx, x1, cx, tt), vsBezierPoint2(sy, y1, cy, tt)]);
      }
    } else if (C === 'A') {
      // 弧线：跳过 rx ry 旋转 大弧 扫掠 5 个参数，终点推进（近似为直线段）
      num(); num(); num(); num(); num();
      cx = relCur(rel, num(), cx); cy = relCur(rel, num(), cy);
      cur.pts.push([cx, cy]);
    }
  }
  if (cur && cur.pts.length) paths.push(cur);
  return paths;
}// 均匀缩放一个形状（尺寸适配：SVG width 相对 viewBox）
function vsScaleShape(sh, s) {
  if (s === 1 || !isFinite(s) || s <= 0) return;
  if (sh.type === 'rect') { sh.x *= s; sh.y *= s; sh.w *= s; sh.h *= s; }
  else if (sh.type === 'ellipse' || sh.type === 'circle') { sh.cx *= s; sh.cy *= s; sh.rx *= s; sh.ry *= s; }
  else if (sh.type === 'line') { sh.x1 *= s; sh.y1 *= s; sh.x2 *= s; sh.y2 *= s; }
  else if (sh.pts) { for (const p of sh.pts) { p[0] *= s; p[1] *= s; } }
}
function vsParseSVGElements(doc) {
  const out = [];
  // 尺寸缩放：SVG 声明的 width（数字）相对 viewBox 宽度 → 让导入尺寸与文件视觉大小一致
  let scale = 1, vbx = 0, vby = 0;
  const root = doc.querySelector('svg');
  if (root) {
    const vb = root.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && isFinite(parts[2]) && parts[2] > 0) {
        vbx = parts[0] || 0; vby = parts[1] || 0;
        const wAttr = parseFloat(root.getAttribute('width'));
        if (isFinite(wAttr) && wAttr > 0) scale = wAttr / parts[2];
      }
    }
  }
  const nodes = doc.querySelectorAll('rect, circle, ellipse, polygon, polyline, line, path');
  nodes.forEach(function (n) {
    // 祖先 transform 链（从根到元素；SVG 嵌套语义 = 元素自身先应用，即数组逆序）
    const transforms = [];
    let cur = n;
    while (cur && cur.getAttribute) {
      const t = cur.getAttribute('transform');
      if (t) transforms.push(t);
      cur = cur.parentNode;
    }
    // 描边：SVG 默认无描边（stroke 缺失 / none → 不描边）
    let stroke = n.getAttribute('stroke');
    if (!stroke || stroke === 'none' || stroke === 'currentColor' || stroke === 'inherit') stroke = '';
    const sw = parseFloat(n.getAttribute('stroke-width')) || 2;
    // 填充：SVG 默认黑色；none → 无填充
    let fill = n.getAttribute('fill');
    if (fill === 'currentColor' || fill === 'inherit') fill = stroke || '#000000';
    if (!fill) fill = '#000000';
    const f = (fill === 'none') ? '' : fill;
    const tag = n.tagName.toLowerCase();
    // 填充规则（evenodd = 镂空）
    const fillRule = n.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : '';
    // 解析出形状（path 的子路径合并为一个形状并标记断点，保持镂空）
    let shapes = [];
    if (tag === 'rect') {
      shapes = [{ type: 'rect', x: +n.getAttribute('x') || 0, y: +n.getAttribute('y') || 0, w: +n.getAttribute('width') || 10, h: +n.getAttribute('height') || 10, stroke: stroke, sw: sw, fill: f, fillRule: fillRule }];
    } else if (tag === 'circle') {
      const r = +n.getAttribute('r') || 10;
      shapes = [{ type: 'ellipse', cx: +n.getAttribute('cx') || 0, cy: +n.getAttribute('cy') || 0, rx: r, ry: r, stroke: stroke, sw: sw, fill: f, fillRule: fillRule }];
    } else if (tag === 'ellipse') {
      shapes = [{ type: 'ellipse', cx: +n.getAttribute('cx') || 0, cy: +n.getAttribute('cy') || 0, rx: +n.getAttribute('rx') || 10, ry: +n.getAttribute('ry') || 10, stroke: stroke, sw: sw, fill: f, fillRule: fillRule }];
    } else if (tag === 'line') {
      shapes = [{ type: 'line', x1: +n.getAttribute('x1') || 0, y1: +n.getAttribute('y1') || 0, x2: +n.getAttribute('x2') || 10, y2: +n.getAttribute('y2') || 10, stroke: stroke, sw: sw, fill: f, fillRule: fillRule }];
    } else if (tag === 'polygon' || tag === 'polyline') {
      const pts = (n.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      const arr = [];
      for (let i = 0; i + 1 < pts.length; i += 2) arr.push([pts[i], pts[i + 1]]);
      if (arr.length >= 2) shapes = [{ type: 'polyline', pts: arr, closed: tag === 'polygon', stroke: stroke, sw: sw, fill: f, fillRule: fillRule }];
    } else if (tag === 'path') {
      const subs = vsParsePathD(n.getAttribute('d') || '');
      if (subs.length) {
        if (subs.length === 1 && subs[0].pts.length >= 2) {
          shapes = [{ type: 'polyline', pts: subs[0].pts, closed: subs[0].closed, stroke: stroke, sw: sw, fill: f, fillRule: fillRule }];
        } else if (subs.length > 1) {
          // 多子路径：合并为一个形状（breaks 标记子路径起点），fill 按方向/evenodd 规则镂空
          const pts = [];
          const breaks = [];
          for (const sub of subs) {
            if (sub.pts.length < 2) continue;
            breaks.push(pts.length);
            for (const p of sub.pts) pts.push([p[0], p[1]]);
          }
          if (pts.length >= 2) shapes = [{ type: 'polyline', pts: pts, closed: false, breaks: breaks, stroke: stroke, sw: sw, fill: f, fillRule: fillRule }];
        }
      }
    }
    for (const sh of shapes) {
      sh.id = vsNextShapeId();
      // 祖先 + 元素自身 transform（viewBox 坐标系内）：SVG 嵌套语义 = 最内层先应用
      // transforms 收集顺序为 [元素, 父级, ..., 根]，正序遍历即从内到外
      for (let ti = 0; ti < transforms.length; ti++) vsTransformShape(sh, transforms[ti]);
      // viewBox 偏移 → 尺寸缩放（对应文件显示尺寸）
      if (vbx || vby) vsTranslateShape(sh, -vbx, -vby);
      vsScaleShape(sh, scale);
      out.push(sh);
    }
  });
  return out;
}
// 生成唯一形状 id（与所有图层已存在的形状 id 不冲突）
function vsNextShapeId() {
  let id = VS.nextId;
  for (const L of state.layers) {
    while ((L.shapes || []).some(function (s) { return s.id === id; })) id++;
  }
  VS.nextId = id + 1;
  return id;
}
// SVG 文件 → 矢量形状（pixel-canvas.js 的导入图片检测 .svg 时调用）
window.__vshapeImportSVG = function (file) {
  const fr = new FileReader();
  fr.onload = function () {
    try {
      const doc = new DOMParser().parseFromString(fr.result, 'image/svg+xml');
      const parsed = vsParseSVGElements(doc);
      if (!parsed.length) { alert('SVG 中没有可识别的图形元素（rect / circle / ellipse / polygon / polyline / line / path）。'); return; }
      // 整体平移到屏幕中心（与位图导入行为一致）
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const sh of parsed) {
        const b = vsShapeBBox(sh);
        if (b && isFinite(b[0])) {
          if (b[0] < minX) minX = b[0]; if (b[2] > maxX) maxX = b[2];
          if (b[1] < minY) minY = b[1]; if (b[3] > maxY) maxY = b[3];
        }
      }
      if (isFinite(minX) && isFinite(maxX)) {
        const [wx, wy] = screenToWorld(cssW() / 2, cssH() / 2);
        const dx = Math.floor(wx - (minX + maxX) / 2), dy = Math.floor(wy - (minY + maxY) / 2);
        for (const sh of parsed) vsTranslateShape(sh, dx, dy);
      }
      vsPushHistory();
      const L = vsActiveLayer();
      for (const sh of parsed) L.shapes.push(sh);
      VS.active = true; // 导入后进入矢量模式，方便查看 / 编辑
      vsUseMoveTool(); // 切到移动工具（选择模式，不显示顶点句柄，避免复杂图形被句柄盖花）
      VS.selected.clear();
      VS.selected.add(parsed[0].id);
      updateVsMenu();
      requestRender();
      alert('已导入 ' + parsed.length + ' 个矢量对象（已置于屏幕中心）。');
    } catch (e) { alert('SVG 解析失败：' + (e && e.message ? e.message : '未知原因')); }
  };
  fr.readAsText(file);
};

// 像素「框选」工具（▢）完成后：把框选区域内的矢量形状加入选中（不依赖矢量模式激活）
window.__vshapeSelDone = function () {
  const L = vsActiveLayer();
  if (!L || !L.shapes || !L.shapes.length) return;
  if (typeof selMoveStart === 'undefined' || !selMoveStart || !selMoveEnd) return;
  const x0 = Math.min(selMoveStart.x, selMoveEnd.x), x1 = Math.max(selMoveStart.x, selMoveEnd.x);
  const y0 = Math.min(selMoveStart.y, selMoveEnd.y), y1 = Math.max(selMoveStart.y, selMoveEnd.y);
  const hit = L.shapes.filter(function (sh) {
    const b = vsShapeBBox(sh);
    return b && isFinite(b[0]) && b[2] >= x0 && b[0] <= x1 && b[3] >= y0 && b[1] <= y1;
  });
  if (hit.length) {
    VS.selected.clear();
    for (const sh of hit) VS.selected.add(sh.id);
    vsUseMoveTool(); // 自动切到移动工具：框选完可直接拖动选中的形状
    requestRender();
  }
};

// ---------------- 交互（钩子，返回 true = 拦截像素逻辑） ----------------
function vsWorld(e) {
  return screenToWorld(e.clientX, e.clientY);
}
window.__vshapeDown = function (e) {
  // 非左键：右键在贝塞尔绘制中 = 完成；其余放行（右键平移等仍走像素逻辑）
  if (e.pointerType === 'mouse' && e.button !== 0) {
    if (VS.tool === 'vbezier' && VS.bezierPts && VS.bezierPts.length >= 2) { vsFinishBezier(); return true; }
    return false;
  }
  if (state.uiHidden || els.modalMask.classList.contains('open') || els.settingsMask.classList.contains('open')) return false;
  const w = vsWorld(e);
  // 移动工具（右侧 ✋）：矢量选择 —— 不依赖矢量模式激活，画布上有形状即生效；
  // 点击形状选中/拖动（多选一起移动），未命中放行像素逻辑（像素框选区域拖动 / 实例拖动等）
  if (state.tool === 'move') {
    VS.down = true;
    const hit = vsHitShape(w[0], w[1]);
    if (hit) {
      if (!e.shiftKey && !VS.selected.has(hit.id)) { VS.selected.clear(); VS.selected.add(hit.id); }
      else if (e.shiftKey) { if (VS.selected.has(hit.id)) VS.selected.delete(hit.id); else VS.selected.add(hit.id); }
      if (!VS.selected.has(hit.id)) { requestRender(); return true; } // Shift 取消选中后不进入拖动
      vsPushHistory(); // 拖动开始记录一次撤销快照
      // 拖动全部选中的形状（多选一起移动）
      VS.drag = { ids: Array.from(VS.selected), dx: w[0], dy: w[1] };
      requestRender();
      return true;
    }
    // 未命中形状：取消选择，放行像素移动逻辑
    if (!e.shiftKey) VS.selected.clear();
    requestRender();
    return false;
  }
  // 顶点编辑工具（矢量菜单 ✦ 顶点编辑）：点击顶点拖改形，点击形状选中，空白取消
  if (VS.tool === 'vvertex') {
    VS.down = true;
    const hv = vsHitVertex(w[0], w[1]);
    if (hv) {
      vsPushHistory();
      VS.vertexDrag = { sh: hv.sh, vi: hv.vi };
      vsSetPoint(hv.sh, hv.vi, w[0], w[1]);
      VS.selected.clear(); VS.selected.add(hv.sh.id);
      requestRender();
      return true;
    }
    const hit2 = vsHitShape(w[0], w[1]);
    if (hit2) {
      if (!e.shiftKey && !VS.selected.has(hit2.id)) { VS.selected.clear(); VS.selected.add(hit2.id); }
      else if (e.shiftKey) { if (VS.selected.has(hit2.id)) VS.selected.delete(hit2.id); else VS.selected.add(hit2.id); }
      requestRender();
      return true;
    }
    if (!e.shiftKey) VS.selected.clear();
    requestRender();
    return true;
  }
  // 矢量绘制 / 矢量框选工具拦截：仅当 VS.tool 明确设置时（✎ 菜单 / 左键选择后）；
  // 切换到像素工具（框选/画笔等）会清空 VS.tool，不会再误拦截
  const isDraw = VS.tool === 'vbezier' || VS.tool === 'vpen' || VS.tool === 'vbox' || VS.tool === 'vrect' || VS.tool === 'vellipse' || VS.tool === 'vline' || VS.tool === 'vtri';
  if (!isDraw) return false;
  VS.down = true;
  // 两点画圆（椭圆工具形式）：点击圆心 → 移动预览 → 点击确定半径
  if (VS.tool === 'vellipse' && VS.ellipseMode === '2point') {
    if (!VS.ellipsePts) VS.ellipsePts = [];
    VS.ellipsePts.push([w[0], w[1]]);
    if (VS.ellipsePts.length >= 2) {
      const c = VS.ellipsePts[0], rp = VS.ellipsePts[1];
      const r = Math.max(0.5, Math.hypot(rp[0] - c[0], rp[1] - c[1]));
      vsAddShapeRaw({ type: 'ellipse', cx: c[0], cy: c[1], rx: r, ry: r, stroke: VS.stroke, sw: VS.sw, fill: vsFillStr() });
      VS.ellipsePts = null;
    }
    requestRender();
    return true;
  }
  // 三点画三角（三角形工具形式）：点击三点生成
  if (VS.tool === 'vtri' && VS.triMode === '3point') {
    if (!VS.triPts) VS.triPts = [];
    VS.triPts.push(vsSnapPoint(w[0], w[1]));
    if (VS.triPts.length >= 3) {
      vsAddShapeRaw({ type: 'triangle', pts: VS.triPts.slice(), stroke: VS.stroke, sw: VS.sw, fill: vsFillStr() });
      VS.triPts = null;
    }
    requestRender();
    return true;
  }
  // 贝塞尔：点击加点，双击（350ms 内第二击）完成
  if (VS.tool === 'vbezier') {
    const now = Date.now();
    if (VS.bezierPts && VS.bezierPts.length >= 2 && now - VS.bezierLastT < 350) vsFinishBezier();
    else {
      if (!VS.bezierPts) VS.bezierPts = [];
      VS.bezierPts.push([w[0], w[1]]);
      VS.bezierLastT = now;
    }
    requestRender();
    return true;
  }
  // 自由画笔：拖动记录轨迹点
  if (VS.tool === 'vpen') {
    VS.drawing = { type: 'vpen', pts: [[w[0], w[1]]] };
    requestRender();
    return true;
  }
  // 图形绘制
  VS.drawing = { type: VS.tool, x0: w[0], y0: w[1], x1: w[0], y1: w[1] };
  requestRender();
  return true;
};
window.__vshapeMove = function (e) {
  if (e.pointerType === 'mouse' && e.button !== 0 && !VS.drag && !VS.vertexDrag && !VS.drawing) return false;
  const w = vsWorld(e);
  // 点击式工具（两点画圆 / 三点画三角）：更新鼠标预览点
  if ((VS.ellipsePts && VS.ellipsePts.length >= 1) || (VS.triPts && VS.triPts.length >= 1)) {
    VS.previewPt = vsSnapPoint(w[0], w[1]);
    requestRender();
    return true;
  }
  if (VS.drag) {
    const L = vsActiveLayer();
    if (L) {
      const dx = w[0] - VS.drag.dx, dy = w[1] - VS.drag.dy;
      // 同时移动所有选中的形状
      for (const id of VS.drag.ids) {
        const sh = L.shapes.find(function (s) { return s.id === id; });
        if (!sh) continue;
        if (sh.type === 'rect') { sh.x += dx; sh.y += dy; }
        else if (sh.type === 'line') { sh.x1 += dx; sh.y1 += dy; sh.x2 += dx; sh.y2 += dy; }
        else if (sh.type === 'ellipse' || sh.type === 'circle') { sh.cx += dx; sh.cy += dy; }
        else if (sh.pts) { for (const p of sh.pts) { p[0] += dx; p[1] += dy; } }
      }
      VS.drag.dx = w[0]; VS.drag.dy = w[1];
      requestRender();
    }
    return true;
  }
  if (VS.vertexDrag) {
    const sp = vsSnapPoint(w[0], w[1]);
    vsSetPoint(VS.vertexDrag.sh, VS.vertexDrag.vi, sp[0], sp[1]);
    requestRender();
    return true;
  }
  if (VS.drawing && VS.drawing.type === 'vpen') {
    // 自由画笔：轨迹点（移动超过阈值才加点，避免点过密）
    const last = VS.drawing.pts[VS.drawing.pts.length - 1];
    if (Math.hypot(w[0] - last[0], w[1] - last[1]) >= 1.5 / state.scale) VS.drawing.pts.push([w[0], w[1]]);
    requestRender();
    return true;
  }
  if (VS.drawing) {
    const sp = vsSnapPoint(w[0], w[1]);
    VS.drawing.x1 = sp[0]; VS.drawing.y1 = sp[1];
    requestRender();
    return true;
  }
  return false;
};
window.__vshapeUp = function (e) {
  if (!VS.down) return false;
  VS.down = false;
  if (VS.drawing) {
    const d = VS.drawing;
    VS.drawing = null;
    // 矢量框选：松手选中框内所有形状，自动切移动工具可直接拖动
    if (d.type === 'vbox') {
      const min = Math.max(0.5, 2 / state.scale);
      if (Math.abs(d.x1 - d.x0) >= min || Math.abs(d.y1 - d.y0) >= min) {
        const L = vsActiveLayer();
        if (L && L.shapes && L.shapes.length) {
          const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
          const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
          const hit = L.shapes.filter(function (sh) {
            const b = vsShapeBBox(sh);
            return b && isFinite(b[0]) && b[2] >= x0 && b[0] <= x1 && b[3] >= y0 && b[1] <= y1;
          });
          VS.selected.clear();
          for (const sh of hit) VS.selected.add(sh.id);
        }
        vsUseMoveTool(); // 自动切移动工具：框选完可直接拖动
      } else {
        VS.selected.clear();
      }
      requestRender();
      return true;
    }
    if (d.type === 'vpen') {
      // 自由画笔 → 折线形状
      if (d.pts.length >= 2) vsAddShapeRaw({ type: 'polyline', pts: d.pts, stroke: VS.stroke, sw: VS.sw, fill: '' });
      requestRender();
      return true;
    }
    const min = Math.max(0.5, 2 / state.scale); // 至少 2px 才算有效形状
    if (Math.abs(d.x1 - d.x0) >= min || Math.abs(d.y1 - d.y0) >= min) vsAddShape(d.type, d.x0, d.y0, d.x1, d.y1);
    requestRender();
    return true;
  }
  if (VS.drag) { VS.drag = null; requestRender(); return true; }
  if (VS.vertexDrag) { VS.vertexDrag = null; requestRender(); return true; }
  return false;
};
// 统一撤销 / 重做分派：按「最近一次操作类型」决定先撤像素还是矢量，栈空自动切换到另一个
function vsDispatchUndo() {
  const t = window.__vsLastEdit;
  if (t === 'vector') {
    if (vsUndo()) return true;
    if (typeof undo === 'function') { undo(); return true; } // 矢量栈空 → 像素栈
    return false;
  }
  // pixel（默认）
  if (typeof undo === 'function') {
    const st = (typeof undoStack !== 'undefined' && undoStack) ? undoStack : null;
    const before = st ? st.length : 0;
    undo();
    if (st && st.length !== before) return true; // 像素栈真的撤了
    if (vsUndo()) return true; // 像素栈空 → 矢量栈
    return false;
  }
  return false;
}
function vsDispatchRedo() {
  const t = window.__vsLastEdit;
  if (t === 'vector') {
    if (vsRedo()) return true;
    if (typeof redo === 'function') { redo(); return true; }
    return false;
  }
  if (typeof redo === 'function') {
    const st = (typeof redoStack !== 'undefined' && redoStack) ? redoStack : null;
    const before = st ? st.length : 0;
    redo();
    if (st && st.length !== before) return true;
    if (vsRedo()) return true;
    return false;
  }
  return false;
}
window.__vshapeKey = function (e) {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return false;
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y：统一分派（像素与矢量按最近操作顺序撤回）
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
    if (e.shiftKey) { vsDispatchRedo(); e.preventDefault(); return true; }
    vsDispatchUndo();
    e.preventDefault();
    return true;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y') {
    vsDispatchRedo();
    e.preventDefault();
    return true;
  }
  // Delete / Backspace：删除选中形状
  if ((e.key === 'Delete' || e.key === 'Backspace') && VS.selected.size) {
    vsDeleteSelected();
    e.preventDefault();
    return true;
  }
  // Enter：完成贝塞尔绘制
  if (e.key === 'Enter' && VS.tool === 'vbezier' && VS.bezierPts && VS.bezierPts.length >= 2) {
    vsFinishBezier();
    e.preventDefault();
    return true;
  }
  // Escape：取消进行中的点击式绘制（贝塞尔 / 两点画圆 / 三点画三角）
  if (e.key === 'Escape') {
    if (VS.bezierPts || VS.ellipsePts || VS.triPts) {
      VS.bezierPts = null; VS.ellipsePts = null; VS.triPts = null; VS.previewPt = null;
      requestRender();
      e.preventDefault();
      return true;
    }
  }
  return false;
};

// ---------------- 渲染（钩子） ----------------
// 画图层 shapes（在世界坐标变换下调用，p 为 dpr 未用，li 为图层索引）
window.__vshapeLayer = function (p, li) {
  const L = state.layers[li];
  if (!L || !L.shapes || !L.shapes.length) return;
  const s = state.scale;
  const showHandles = (state.tool === 'move' || VS.tool === 'vvertex') && VS.selected.size === 1; // 移动/顶点工具选择模式下显示顶点句柄
  for (const sh of L.shapes) {
    vsDrawShape(ctx, sh, s);
    if (VS.selected.has(sh.id)) {
      // 选中高亮（虚线框）
      const b = vsShapeBBox(sh);
      if (isFinite(b[0])) {
        ctx.strokeStyle = 'rgba(30,160,255,.9)';
        ctx.lineWidth = 1 / s;
        ctx.setLineDash([4 / s, 3 / s]);
        ctx.strokeRect(b[0] - 3 / s, b[1] - 3 / s, b[2] - b[0] + 6 / s, b[3] - b[1] + 6 / s);
        ctx.setLineDash([]);
      }
    }
    if (showHandles && VS.selected.has(sh.id)) {
      // 顶点句柄（点过多的复杂形状不画句柄，避免几千个圆点盖住图案）
      const pts = vsShapePoints(sh);
      const r = 3 / s;
      if (pts.length <= 60) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(30,160,255,.95)';
        ctx.lineWidth = 1.5 / s;
        for (const pt of pts) {
          ctx.beginPath();
          ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }
};
// 绘制中的预览（p 为 dpr）
window.__vshapeOverlay = function (p) {
  const s = state.scale;
  ctx.setTransform(p * s, 0, 0, p * s, p * state.offsetX, p * state.offsetY);
  // 两点画圆预览：圆心 + 鼠标半径圆
  if (VS.ellipsePts && VS.ellipsePts.length >= 1) {
    ctx.setTransform(p * s, 0, 0, p * s, p * state.offsetX, p * state.offsetY);
    const c = VS.ellipsePts[0];
    const pp = VS.previewPt || [state.mouseGridX, state.mouseGridY];
    const r = Math.max(0.5, Math.hypot(pp[0] - c[0], pp[1] - c[1]));
    ctx.beginPath();
    ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(30,160,255,.9)';
    ctx.lineWidth = Math.max(0.5, VS.sw / s);
    ctx.stroke();
    ctx.fillStyle = 'rgba(30,160,255,.8)';
    ctx.beginPath(); ctx.arc(c[0], c[1], 2.5 / s, 0, Math.PI * 2); ctx.fill();
    return;
  }
  // 三点画三角预览：已加点 + 鼠标点连线
  if (VS.triPts && VS.triPts.length >= 1) {
    ctx.setTransform(p * s, 0, 0, p * s, p * state.offsetX, p * state.offsetY);
    const pts = VS.triPts.slice();
    const pp = VS.previewPt || [state.mouseGridX, state.mouseGridY];
    pts.push([pp[0], pp[1]]);
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.strokeStyle = 'rgba(30,160,255,.9)';
      ctx.lineWidth = Math.max(0.5, VS.sw / s);
      ctx.setLineDash([5 / s, 4 / s]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = 'rgba(30,160,255,.8)';
    for (const pt of pts) { ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.5 / s, 0, Math.PI * 2); ctx.fill(); }
    return;
  }
  // 矢量框选：蓝色虚线框预览
  if (VS.drawing && VS.drawing.type === 'vbox') {
    const d = VS.drawing;
    ctx.setTransform(p * s, 0, 0, p * s, p * state.offsetX, p * state.offsetY);
    ctx.strokeStyle = 'rgba(30,160,255,.95)';
    ctx.lineWidth = 1.5 / s;
    ctx.setLineDash([6 / s, 4 / s]);
    ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(30,160,255,.08)';
    ctx.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    return;
  }
  // 自由画笔：轨迹折线预览
  if (VS.drawing && VS.drawing.type === 'vpen') {
    const pts = VS.drawing.pts;
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.strokeStyle = VS.stroke;
      ctx.lineWidth = Math.max(0.5, VS.sw / s);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.stroke();
    }
    return;
  }
  // 贝塞尔：已加点集 + 当前鼠标位置的平滑曲线预览
  if (VS.bezierPts && VS.bezierPts.length) {
    const pts = VS.bezierPts.concat([[state.mouseGridX, state.mouseGridY]]);
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
          p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
      }
      ctx.strokeStyle = 'rgba(30,160,255,.9)';
      ctx.lineWidth = Math.max(0.5, VS.sw / s);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.stroke();
      // 已有点标记
      ctx.fillStyle = 'rgba(30,160,255,.8)';
      for (const pt of VS.bezierPts) { ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.5 / s, 0, Math.PI * 2); ctx.fill(); }
    }
    return;
  }
  if (VS.drawing) {
    const d = VS.drawing;
    const s = state.scale;
    ctx.setTransform(p * s, 0, 0, p * s, p * state.offsetX, p * state.offsetY);
    const sh = { type: d.type === 'vrect' ? 'rect' : d.type === 'vellipse' ? 'ellipse' : d.type === 'vtri' ? 'triangle' : 'line', stroke: VS.stroke, sw: VS.sw, fill: d.type === 'vline' ? '' : vsFillStr() };
    if (sh.type === 'rect') { sh.x = Math.min(d.x0, d.x1); sh.y = Math.min(d.y0, d.y1); sh.w = Math.abs(d.x1 - d.x0); sh.h = Math.abs(d.y1 - d.y0); }
    else if (sh.type === 'ellipse') { sh.cx = (d.x0 + d.x1) / 2; sh.cy = (d.y0 + d.y1) / 2; sh.rx = Math.abs(d.x1 - d.x0) / 2; sh.ry = Math.abs(d.y1 - d.y0) / 2; }
    else if (sh.type === 'triangle') {
      const minX = Math.min(d.x0, d.x1), maxX = Math.max(d.x0, d.x1);
      const minY = Math.min(d.y0, d.y1), maxY = Math.max(d.y0, d.y1);
      const midX = (minX + maxX) / 2;
      sh.pts = (d.y1 >= d.y0) ? [[midX, minY], [minX, maxY], [maxX, maxY]] : [[midX, maxY], [minX, minY], [maxX, minY]];
    }
    else { sh.x1 = d.x0; sh.y1 = d.y0; sh.x2 = d.x1; sh.y2 = d.y1; }
    vsDrawShape(ctx, sh, s);
    // 起点小标记
    ctx.fillStyle = 'rgba(30,160,255,.8)';
    ctx.beginPath(); ctx.arc(d.x0, d.y0, 2.5 / s, 0, Math.PI * 2); ctx.fill();
  }
};

// ---------------- 工具栏 UI（动态注入，不修改 index.html） ----------------
function vsEl(name, attrs, text) {
  const el = document.createElement(name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (text !== undefined) el.textContent = text;
  return el;
}
let vsMenuEl = null;
let vsSettingsEl = null;
const VS_TOOLS = [
  { v: 'vpen', t: '🖌 矢量画笔', d: '自由手绘（拖动记录轨迹，松手生成折线形状）' },
  { v: 'vbezier', t: '〰 贝塞尔', d: '点击加点，双击 / 右键 / Enter 完成（平滑曲线）' },
  { v: 'vbox', t: '🔲 矢量框选', d: '拉框选中多个矢量形状（松手自动切移动工具可拖动）' },
  { v: 'vvertex', t: '✦ 顶点编辑', d: '点击顶点拖动改形，点击形状选中' },
  { v: 'vrect', t: '▭ 矩形', d: '画矩形' },
  { v: 'vellipse', t: '◯ 椭圆', d: '画椭圆' },
  { v: 'vline', t: '╱ 直线', d: '画直线' },
  { v: 'vtri', t: '△ 三角形', d: '画三角形（拖动方向决定正/倒）' },
];
function updateVsMenu() {
  if (!vsMenuEl) return;
  const items = vsMenuEl.querySelectorAll('[data-vs-tool]');
  for (const it of items) it.classList.toggle('active', it.dataset.vsTool === VS.tool);
  const btn = document.getElementById('vsToggleBtn');
  if (btn) btn.classList.toggle('active', VS.active);
}

// ---------------- 矢量设置（面板 + 持久化） ----------------
const VS_SETTINGS_KEY = 'vs-settings';
function vsSaveSettings() {
  try {
    localStorage.setItem(VS_SETTINGS_KEY, JSON.stringify({
      sw: VS.sw, stroke: VS.stroke, fillOn: VS.fillOn, fillColor: VS.fillColor, fillAlpha: VS.fillAlpha, snap: VS.snap,
    }));
  } catch (e) { /* localStorage 不可用时忽略 */ }
  vsFlash('💾 矢量设置已保存');
}
function vsLoadSettings() {
  try {
    const d = JSON.parse(localStorage.getItem(VS_SETTINGS_KEY) || 'null');
    if (!d) return;
    if (typeof d.sw === 'number') VS.sw = d.sw;
    if (typeof d.stroke === 'string') VS.stroke = d.stroke;
    if (typeof d.fillOn === 'boolean') VS.fillOn = d.fillOn;
    if (typeof d.fillColor === 'string') VS.fillColor = d.fillColor;
    if (typeof d.fillAlpha === 'number') VS.fillAlpha = d.fillAlpha;
    if (typeof d.snap === 'boolean') VS.snap = d.snap;
  } catch (e) { /* 忽略损坏数据 */ }
}
function vsFlash(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  d.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);background:#1e3a5f;border:1px solid #3b82f6;color:#dbe2ea;padding:8px 18px;border-radius:8px;z-index:300;font-size:13px';
  document.body.appendChild(d);
  setTimeout(function () { d.remove(); }, 2000);
}
// 构建一组矢量设置控件（可挂到任意容器，值由 vsSyncSettingsUI 统一刷新）
function vsBuildSettingsControls(root) {
  const mk = function (label, ctrl) {
    const row = vsEl('div', { style: 'display:flex;align-items:center;gap:6px' });
    row.appendChild(document.createTextNode(label));
    row.appendChild(ctrl);
    return row;
  };
  // 线宽
  const lwIn = vsEl('input', { type: 'range', min: '1', max: '16', step: '1', 'data-vs-ctrl': 'sw', style: 'width:80px' });
  lwIn.addEventListener('input', function () { VS.sw = +this.value; vsSyncSettingsUI(); });
  root.appendChild(mk('线宽', lwIn));
  root.appendChild(vsEl('span', { 'data-vs-ctrl': 'swVal', style: 'color:#7a8494;margin:-4px 0 4px 30px' }, ''));
  // 描边
  const c1In = vsEl('input', { type: 'color', 'data-vs-ctrl': 'stroke', style: 'width:28px;height:22px;border:none;background:none;cursor:pointer' });
  c1In.addEventListener('input', function () { VS.stroke = this.value; });
  root.appendChild(mk('描边', c1In));
  // 填充（开关 + 颜色 + 透明度）
  const c2On = vsEl('input', { type: 'checkbox', 'data-vs-ctrl': 'fillOn', title: '填充开关' });
  c2On.addEventListener('change', function () { VS.fillOn = this.checked; });
  const c2In = vsEl('input', { type: 'color', 'data-vs-ctrl': 'fillColor', style: 'width:28px;height:22px;border:none;background:none;cursor:pointer' });
  c2In.addEventListener('input', function () { VS.fillColor = this.value; });
  const faIn = vsEl('input', { type: 'range', min: '0', max: '100', step: '1', 'data-vs-ctrl': 'fillAlpha', title: '填充透明度', style: 'width:70px' });
  faIn.addEventListener('input', function () { VS.fillAlpha = +this.value; vsSyncSettingsUI(); });
  const fRow = vsEl('div', { style: 'display:flex;align-items:center;gap:6px' });
  fRow.appendChild(c2On);
  fRow.appendChild(document.createTextNode('填充'));
  fRow.appendChild(c2In);
  fRow.appendChild(faIn);
  fRow.appendChild(vsEl('span', { 'data-vs-ctrl': 'fillAlphaVal', style: 'color:#7a8494' }, ''));
  root.appendChild(fRow);
  // 吸附
  const snIn = vsEl('input', { type: 'checkbox', 'data-vs-ctrl': 'snap' });
  snIn.addEventListener('change', function () { VS.snap = this.checked; });
  const sn = vsEl('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer' });
  sn.appendChild(snIn);
  sn.appendChild(document.createTextNode('吸附网格/顶点'));
  root.appendChild(sn);
}
// 刷新所有设置控件值（两处面板同步）
function vsSyncSettingsUI() {
  const ctrls = document.querySelectorAll('[data-vs-ctrl]');
  for (const c of ctrls) {
    const k = c.getAttribute('data-vs-ctrl');
    if (k === 'sw') c.value = String(VS.sw);
    else if (k === 'swVal') c.textContent = VS.sw + 'px';
    else if (k === 'stroke') c.value = VS.stroke;
    else if (k === 'fillOn') c.checked = VS.fillOn;
    else if (k === 'fillColor') c.value = VS.fillColor;
    else if (k === 'fillAlpha') c.value = String(VS.fillAlpha);
    else if (k === 'fillAlphaVal') c.textContent = VS.fillAlpha + '%';
    else if (k === 'snap') c.checked = VS.snap;
  }
}
// 独立矢量设置面板（右键工具 / 菜单「⚙ 设置」打开）
function buildVsSettingsPanel() {
  vsSettingsEl = vsEl('div', {
    id: 'vsSettings',
    style: 'display:none;position:fixed;right:60px;top:50%;transform:translateY(-50%);z-index:132;background:rgba(28,30,36,.98);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px 12px;box-shadow:0 6px 20px rgba(0,0,0,.45);font-size:12px;color:#cfd3dc;min-width:220px;flex-direction:column;gap:6px',
  });
  const head = vsEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;font-weight:700;margin-bottom:2px' });
  head.appendChild(document.createTextNode('✎ 矢量绘制设置'));
  const close = vsEl('span', { style: 'cursor:pointer;color:#9aa0ab;font-size:16px;padding:0 4px' }, '×');
  close.addEventListener('click', function () { vsSettingsEl.style.display = 'none'; });
  head.appendChild(close);
  vsSettingsEl.appendChild(head);
  vsBuildSettingsControls(vsSettingsEl);
  const foot = vsEl('div', { style: 'display:flex;justify-content:flex-end;gap:6px;margin-top:6px;border-top:1px solid rgba(255,255,255,.12);padding-top:8px' });
  const save = vsEl('button', { style: 'background:#3b82f6;color:#fff;border:none;border-radius:7px;padding:5px 14px;cursor:pointer;font-size:12px' }, '💾 保存设置');
  save.addEventListener('click', vsSaveSettings);
  foot.appendChild(save);
  vsSettingsEl.appendChild(foot);
  document.body.appendChild(vsSettingsEl);
}
function openVsSettings() {
  vsSyncSettingsUI();
  vsSettingsEl.style.display = 'flex';
  if (vsMenuEl) vsMenuEl.style.display = 'none';
}
// 工具形式子菜单（椭圆 / 三角形右键）：选择绘制形式
let vsModeMenuEl = null;
function buildVsModeMenu() {
  vsModeMenuEl = vsEl('div', {
    id: 'vsModeMenu',
    style: 'display:none;position:fixed;z-index:133;background:rgba(28,30,36,.98);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:6px;box-shadow:0 6px 20px rgba(0,0,0,.45);flex-direction:column;gap:2px;min-width:170px',
  });
  document.body.appendChild(vsModeMenuEl);
  document.addEventListener('pointerdown', function (e) {
    if (vsModeMenuEl.style.display === 'flex' && !vsModeMenuEl.contains(e.target)) vsModeMenuEl.style.display = 'none';
  });
}
function openVsModeMenu(x, y, tool) {
  if (!vsModeMenuEl) return;
  vsModeMenuEl.innerHTML = '';
  const opts = tool === 'vellipse' ? [
    { v: 'free', t: '◯ 自由椭圆（拖动）' },
    { v: 'circle', t: '⭕ 正圆（拖动）' },
    { v: '2point', t: '⭕ 两点画圆（圆心+半径）' },
  ] : [
    { v: 'drag', t: '△ 拖动画三角' },
    { v: '3point', t: '△ 三点画三角（点击三点）' },
  ];
  const cur = tool === 'vellipse' ? VS.ellipseMode : VS.triMode;
  for (const o of opts) {
    const it = vsEl('div', { style: 'display:flex;align-items:center;gap:6px;white-space:nowrap;padding:6px 10px;border-radius:7px;cursor:pointer;color:' + (o.v === cur ? '#7aa2ff' : '#cfd3dc') + ';font-size:13px' }, (o.v === cur ? '✓ ' : '') + o.t);
    it.addEventListener('mouseenter', function () { it.style.background = 'rgba(255,255,255,.1)'; });
    it.addEventListener('mouseleave', function () { it.style.background = 'transparent'; });
    it.addEventListener('click', function () {
      if (tool === 'vellipse') VS.ellipseMode = o.v;
      else VS.triMode = o.v;
      vsModeMenuEl.style.display = 'none';
    });
    vsModeMenuEl.appendChild(it);
  }
  vsModeMenuEl.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  vsModeMenuEl.style.top = Math.min(y, window.innerHeight - 140) + 'px';
  vsModeMenuEl.style.display = 'flex';
}
// ⚙ 上方设置面板：注入矢量设置行（插到「保存设置」按钮之前，保存按钮保持在面板最底部）
function injectVsSettingsIntoPixelPanel() {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;
  const row = vsEl('div', {
    class: 's-row',
    style: 'flex-direction:column;align-items:stretch;gap:6px;border-top:1px solid rgba(255,255,255,.12);margin-top:8px;padding-top:8px',
  });
  const title = vsEl('div', { style: 'font-size:12px;font-weight:700;color:#cfd3dc' }, '✎ 矢量工具');
  row.appendChild(title);
  vsBuildSettingsControls(row);
  // 插到「保存设置」按钮行之前（保存按钮保持在面板最下方）
  const saveBtn = document.getElementById('btnSaveSettings');
  if (saveBtn && saveBtn.parentElement) panel.insertBefore(row, saveBtn.parentElement);
  else panel.appendChild(row);
  // 复用上方设置面板的「保存设置」按钮：同时保存矢量设置
  if (saveBtn) saveBtn.addEventListener('click', function () {
    try {
      localStorage.setItem(VS_SETTINGS_KEY, JSON.stringify({
        sw: VS.sw, stroke: VS.stroke, fillOn: VS.fillOn, fillColor: VS.fillColor, fillAlpha: VS.fillAlpha, snap: VS.snap,
      }));
    } catch (e) { /* 忽略 */ }
  });
}
function buildVsUI() {
  const side = document.getElementById('sideToolbar');
  if (!side) return;
  // 分隔线 + 矢量按钮
  const sep = vsEl('div', { class: 'sep', style: 'width:24px;height:1px;background:rgba(255,255,255,.18);margin:4px 0' });
  const btn = vsEl('button', { id: 'vsToggleBtn', class: 'tool-btn', title: '矢量工具：左键 = 矢量画笔，右键 = 工具选择栏（快捷键 V）' }, '✎');
  btn.style.cssText = 'width:38px;height:38px;display:flex;align-items:center;justify-content:center;padding:0;font-size:17px;z-index:130'; // z-index 高于节点编辑器面板，避免被遮挡无法点击
  side.appendChild(sep);
  side.appendChild(btn);
  // 弹出菜单（右键打开）
  vsMenuEl = vsEl('div', {
    id: 'vsMenu',
    style: 'display:none;position:fixed;right:60px;top:50%;transform:translateY(-50%);z-index:131;background:rgba(28,30,36,.97);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:6px;box-shadow:0 6px 20px rgba(0,0,0,.4);flex-direction:column;gap:2px;min-width:160px',
  });
  for (const t of VS_TOOLS) {
    const it = vsEl('div', { 'data-vs-tool': t.v, title: t.d, style: 'display:flex;align-items:center;gap:6px;white-space:nowrap;padding:6px 10px;border-radius:7px;cursor:pointer;color:#cfd3dc;font-size:13px' }, t.t);
    it.addEventListener('mouseenter', function () { it.style.background = 'rgba(255,255,255,.1)'; });
    it.addEventListener('mouseleave', function () { it.style.background = 'transparent'; });
    // 左键：切换工具；右键：椭圆/三角形 → 工具形式菜单，其他工具 → 矢量绘制设置面板
    it.addEventListener('click', function () { vsSetTool(t.v); vsMenuEl.style.display = 'none'; });
    it.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      vsSetTool(t.v);
      if (t.v === 'vellipse' || t.v === 'vtri') openVsModeMenu(e.clientX, e.clientY, t.v);
      else openVsSettings();
    });
    vsMenuEl.appendChild(it);
  }
  // 底部：退出矢量模式（设置入口已移除：改由工具项右键 / 上方 ⚙ 设置面板修改）
  const foot = vsEl('div', { style: 'display:flex;flex-direction:column;gap:2px;border-top:1px solid rgba(255,255,255,.12);margin-top:4px;padding-top:4px' });
  const exit = vsEl('div', { style: 'display:flex;align-items:center;gap:6px;white-space:nowrap;padding:6px 10px;border-radius:7px;cursor:pointer;color:#f87171;font-size:13px' }, '⬛ 退出矢量工具');
  exit.addEventListener('mouseenter', function () { exit.style.background = 'rgba(248,113,113,.12)'; });
  exit.addEventListener('mouseleave', function () { exit.style.background = 'transparent'; });
  exit.addEventListener('click', function () { window.__vshapePixelTool(); });
  foot.appendChild(exit);
  vsMenuEl.appendChild(foot);
  document.body.appendChild(vsMenuEl);
  // 左键点击 ✎：切换为矢量画笔（默认工具）；右键：打开工具选择栏
  btn.addEventListener('click', function () { vsSetTool('vpen'); vsMenuEl.style.display = 'none'; });
  btn.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (!VS.active) { VS.active = true; updateVsMenu(); }
    vsMenuEl.style.display = vsMenuEl.style.display === 'flex' ? 'none' : 'flex';
  });
  // 关闭菜单：点击外部
  document.addEventListener('pointerdown', function (e) {
    if (vsMenuEl.style.display === 'flex' && !vsMenuEl.contains(e.target) && e.target !== btn) vsMenuEl.style.display = 'none';
  });
}
// ---------------- 初始化 ----------------
(function () {
  vsLoadSettings();
  buildVsUI();
  buildVsSettingsPanel();
  buildVsModeMenu();
  injectVsSettingsIntoPixelPanel();
  vsSyncSettingsUI();
  // 快捷键 V：进入矢量模式（默认画笔）/ 打开菜单 / 切回移动工具选择
  const origKey = window.__vshapeKey;
  window.__vshapeKey = function (e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && e.key.toLowerCase() === 'v') {
      if (!VS.active) {
        vsSetTool('vpen'); // 进入矢量模式：默认矢量画笔
      } else if (state.tool === 'move') {
        vsMenuEl.style.display = vsMenuEl.style.display === 'flex' ? 'none' : 'flex';
      } else {
        vsUseMoveTool(); // 切回移动工具（选择/顶点编辑），保持矢量模式
      }
      e.preventDefault();
      return true;
    }
    return origKey(e);
  };
})();
