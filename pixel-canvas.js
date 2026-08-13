  'use strict';

  // ---------- 状态 ----------
  // 世界坐标以像素(格子)为单位：格子 (x,y) 占据 [x, x+1) × [y, y+1)
  const state = {
    scale: 8,              // 视图缩放（每像素对应的屏幕 px）
    offsetX: 0,            // 世界原点在屏幕上的位置
    offsetY: 0,
    pixels: new Map(),     // 活动图层的像素（快捷引用，见 syncActiveLayerRefs）
    tool: 'brush',         // 'brush' | 'eraser'
    mouseGridX: 0,         // 鼠标在画布上的世界格子坐标（侦测类【鼠标的X坐标】）
    mouseGridY: 0,         // 鼠标在画布上的世界格子坐标（侦测类【鼠标的Y坐标】）
    brushMode: 'square',   // 'square' | 'custom'
    eraserMode: 'square',  // 'square' | 'custom'
    brushSize: 4,          // 方块笔刷大小（px）
    eraserSize: 4,         // 方块橡皮大小（px）
    color: '#3b82f6',
    showColorInfo: false,
    uiHidden: false,           // 手动隐藏工具栏与提示（沉浸模式）
    showGrid: true,            // 显示网格线
    gridStep: 'auto',          // 网格线间距：'auto'（随缩放自适应）或数字（像素）
    showAxis: true,            // 显示原点坐标轴（独立于网格线）
    showAxisLabels: false,     // 数轴上显示刻度数字（数学方程面板开关）
    axisLabelSize: 13,         // 刻度数字字号（屏幕 px，手动覆盖值）
    axisLabelAuto: true,       // 字号是否随「显示大小」自动调整
    compressLevel: 6,          // 工程压缩等级 0~10
    exportFormat: 'v3',        // 工程导出格式：'v3'（紧凑，类似 pig2.json）| 'v2'（旧版兼容，类似 pig.json）
    maxUndoSteps: 16,          // 撤销 / 重做步数（1~256）
    stats: null,               // 最近一次统计结果
    mouseOnCanvas: false,
    mouseX: 0, mouseY: 0,  // 最近一次鼠标在画布上的位置（CSS px）
    vectorShapes: [],          // 活动图层的矢量对象（快捷引用，见 syncActiveLayerRefs）
    layers: [                 // 图层列表（自底向上）：{ name, visible, pixels, shapes }
      { name: '图层 1', visible: true, pixels: new Map(), shapes: [] },
    ],
    extra: {},                 // 导入工程时保留的扩展字段（如思维导图 labels），导出时原样带出
    activeLayer: 0,            // 当前活动图层索引
    layersPanelVisible: true,  // 图层面板是否显示
    // ---- 节点系统（node-system.js）----
    objects: [],               // 对象模板：{id,name,kind:'selection'|'layer',srcLayer,w,h,srcX,srcY,pixels:Map<"dx,dy",color>,nodes:[]}
    instances: [],             // 实例：{id,objectIdx,x,y,st:{}}（x,y = 对象左上角格子坐标）
    nodesRunning: false,       // 节点默认停止，需在节点编辑器点击「▶ 运行全部」才执行
  };

  // 自定义笔刷 / 橡皮：{ name, w, h, pixels: Map<"dx,dy", color> }
  // 橡皮的像素颜色仅作为“形状标记”，有颜色的格子会被擦除
  let customBrush = null;
  let customEraser = null;
  let modalEditing = 'brush';      // 画板当前编辑目标：'brush' | 'eraser'

  const MIN_SCALE = 0.05;
  const MAX_SCALE = 32;
  const GRID_COLOR = '#d4d7de';
  const AXIS_COLOR = '#8a8f9a';
  const BG_COLOR = '#ffffff';

  // ---------- DOM ----------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const $ = function (id) { return document.getElementById(id); };
  const els = {
    rToolBrush: $('rToolBrush'), brushMenu: $('brushMenu'),
    btnUndo: $('btnUndo'), btnRedo: $('btnRedo'),
    btnSettings: $('btnSettings'), btnHideUI: $('btnHideUI'), btnRestoreUI: $('btnRestoreUI'),
    bpBrushMode: $('bpBrushMode'), bpBrushSize: $('bpBrushSize'), bpBrushSizeVal: $('bpBrushSizeVal'),
    bpEraserMode: $('bpEraserMode'), bpEraserSize: $('bpEraserSize'), bpEraserSizeVal: $('bpEraserSizeVal'),
    bpColor: $('bpColor'), brushPanel: $('brushPanel'),
    zoomVal: $('zoomVal'), btnReset: $('btnReset'),
    btnImportImage: $('btnImportImage'), btnExportPng: $('btnExportPng'),
    btnExportJson: $('btnExportJson'), btnImportJson: $('btnImportJson'), btnClear: $('btnClear'),
    fileInput: $('fileInput'), imageInput: $('imageInput'),
    toolbarEl: $('toolbar'), hintEl: $('hint'), sideToolbar: $('sideToolbar'),
    colorInfo: $('colorInfo'),
    importStatus: $('importStatus'),
    modalMask: $('modalMask'), modal: $('modal'), modalTitle: $('modalTitle'),
    btnCloseModal: $('btnCloseModal'), modalSizeSelect: $('modalSizeSelect'),
    modalCanvas: $('modalCanvas'), modalBtnPaint: $('modalBtnPaint'), modalBtnErase: $('modalBtnErase'),
    modalUndoBtn: $('modalUndoBtn'), modalRedoBtn: $('modalRedoBtn'),
    modalSideTools: $('modalSideTools'), modalHideTools: $('modalHideTools'),
    modalToolLine: $('modalToolLine'), modalToolRect: $('modalToolRect'),
    modalToolCircle: $('modalToolCircle'), modalToolTriangle: $('modalToolTriangle'),
    modalColor: $('modalColor'), modalBtnClear: $('modalBtnClear'),
    modalBtnImport: $('modalBtnImport'), modalBtnExport: $('modalBtnExport'), modalBtnSave: $('modalBtnSave'),
    modalBtnLibrary: $('modalBtnLibrary'), brushLibrary: $('brushLibrary'), brushLibraryList: $('brushLibraryList'),
    modalFileInput: $('modalFileInput'),
    settingsMask: $('settingsMask'), btnCloseSettings: $('btnCloseSettings'), settingsHideUI: $('settingsHideUI'),
    settingsTool: $('settingsTool'), settingsUndo: $('settingsUndo'), settingsRedo: $('settingsRedo'),
    settingsUndoSteps: $('settingsUndoSteps'), settingsUndoStepsVal: $('settingsUndoStepsVal'),
    settingsBrushMode: $('settingsBrushMode'), settingsBrushSize: $('settingsBrushSize'),
    settingsBrushSizeVal: $('settingsBrushSizeVal'), settingsEditBrush: $('settingsEditBrush'),
    settingsEraserMode: $('settingsEraserMode'), settingsEraserSize: $('settingsEraserSize'),
    settingsEraserSizeVal: $('settingsEraserSizeVal'), settingsEditEraser: $('settingsEditEraser'),
    settingsColor: $('settingsColor'), settingsColorInfo: $('settingsColorInfo'),
    settingsGrid: $('settingsGrid'), settingsGridStep: $('settingsGridStep'), settingsAxis: $('settingsAxis'),
    settingsCompressLevel: $('settingsCompressLevel'), settingsCompressLevelVal: $('settingsCompressLevelVal'),
    compressField: $('compressField'),
    settingsExportFormat: $('settingsExportFormat'),
    rToolShape: $('rToolShape'), shapeMenu: $('shapeMenu'),
    rToolMove: $('rToolMove'), rToolSelect: $('rToolSelect'),
    rToolMore: $('rToolMore'), moreMenu: $('moreMenu'), btnOpenPicker: $('btnOpenPicker'), btnOpenNoise: $('btnOpenNoise'), btnOpenMath: $('btnOpenMath'),
    layersToggle: $('layersToggle'), layersPanel: $('layersPanel'), layersList: $('layersList'),
    btnLayerAdd: $('btnLayerAdd'), btnLayerDup: $('btnLayerDup'), btnLayerDel: $('btnLayerDel'),
    noisePanel: $('noisePanel'), btnCloseNoise: $('btnCloseNoise'),
    noiseType: $('noiseType'), noiseW: $('noiseW'), noiseH: $('noiseH'),
    noiseOffX: $('noiseOffX'), noiseOffY: $('noiseOffY'),
    noiseScale: $('noiseScale'), noiseSeed: $('noiseSeed'), btnRandomSeed: $('btnRandomSeed'),
    noiseOctaves: $('noiseOctaves'), noiseMode: $('noiseMode'),
    noiseThField: $('noiseThField'), noiseThreshold: $('noiseThreshold'),
    btnGenNoise: $('btnGenNoise'),
    mathPanel: $('mathPanel'), btnCloseMath: $('btnCloseMath'),
    mathExpr: $('mathExpr'), mathXMin: $('mathXMin'), mathXMax: $('mathXMax'),
    mathYMin: $('mathYMin'), mathYMax: $('mathYMax'),
    mathStep: $('mathStep'), mathScale: $('mathScale'), btnGenMath: $('btnGenMath'),
    mathAxisLabels: $('mathAxisLabels'), mathLabelSize: $('mathLabelSize'),
    mathLabelSizeVal: $('mathLabelSizeVal'), mathLabelSizeRow: $('mathLabelSizeRow'),
    mathLabelAuto: $('mathLabelAuto'),
    statsBody: $('statsBody'),
    btnCloseSelect: $('btnCloseSelect'), btnStatsCsv: $('btnStatsCsv'), btnStatsPngCsv: $('btnStatsPngCsv'),
    btnSelClear: $('btnSelClear'), btnSelScale: $('btnSelScale'), btnSelRotate: $('btnSelRotate'), btnSelStats: $('btnSelStats'),
    selW: $('selW'), selH: $('selH'), selAngle: $('selAngle'), selInfo: $('selInfo'), selStats: $('selStats'), selExportRow: $('selExportRow'), selectPanel: $('selectPanel'),
    btnNodeSelect: null, btnOpenNodeEditor: $('btnOpenNodeEditor'),
    nodePanel: $('nodePanel'), btnCloseNode: $('btnCloseNode'),
    nodeObjList: $('nodeObjList'), btnNodeInstance: $('btnNodeInstance'),
    nodeNameInput: $('nodeNameInput'),
    nodeInstList: $('nodeInstList'), btnInstDel: $('btnInstDel'), btnNodeAddObj: $('btnNodeAddObj'),
    nodeCanvas: $('nodeCanvas'), nodeCatSelect: $('nodeCatSelect'),
    nodeTypeSelect: $('nodeTypeSelect'), btnNodeAdd: $('btnNodeAdd'), btnNodeHint: $('btnNodeHint'),
    btnNodeRun: $('btnNodeRun'), nodeRunHint: $('nodeRunHint'),
    btnZoomIn: $('btnZoomIn'), btnZoomOut: $('btnZoomOut'), btnZoomReset: $('btnZoomReset'),
    btnPackGroup: $('btnPackGroup'), btnExportGroups: $('btnExportGroups'), btnImportGroups: $('btnImportGroups'),
    importGroupsFile: $('importGroupsFile'), groupEditRow: $('groupEditRow'), groupEditName: $('groupEditName'),
    btnGroupDone: $('btnGroupDone'),
    varNameInput: $('varNameInput'), btnVarAdd: $('btnVarAdd'), varHint: $('varHint'),
    btnScratchMax: $('btnScratchMax'), scratchOverlay: $('scratchOverlay'),
    btnScratchBack: $('btnScratchBack'), btnScratchRun: $('btnScratchRun'),
    scratchBtnPack: $('scratchBtnPack'), scratchBtnExport: $('scratchBtnExport'), scratchBtnImport: $('scratchBtnImport'),
    scratchGroupDone: $('scratchGroupDone'), scratchGroupTools: $('scratchGroupTools'),
    scratchCats: $('scratchCats'), scratchPalette: $('scratchPalette'), scratchCanvas: $('scratchCanvas'), scratchPluginFile: $('scratchPluginFile'), scratchSearch: $('scratchSearch'),
    scratchLib: $('scratchLib'),
    stageCanvas: $('stageCanvas'), stageBox: $('stageBox'), stageSize: $('stageSize'), stageSizeVal: $('stageSizeVal'), scratchRight: $('scratchRight'),
    stageGrid: $('stageGrid'), stageGridVal: $('stageGridVal'), instInfo: $('instInfo'),
    scratchObjSel: $('scratchObjSel'), scratchInstList: $('scratchInstList'),
    scratchBtnInst: $('scratchBtnInst'), scratchBtnDelInst: $('scratchBtnDelInst'),
    scratchVarNameInput: $('scratchVarNameInput'), scratchVarBtn: $('scratchVarBtn'), scratchVarHint: $('scratchVarHint'),
    scratchVarRow: $('scratchVarRow'), scratchVarList: $('scratchVarList'),
    scratchBtnDelObj: $('scratchBtnDelObj'),
  };
  const mctx = els.modalCanvas.getContext('2d');

  function dpr() { return window.devicePixelRatio || 1; }
  function cssW() { return window.innerWidth || document.documentElement.clientWidth || 0; }
  function cssH() { return window.innerHeight || document.documentElement.clientHeight || 0; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---------- 坐标 ----------
  function screenToWorld(sx, sy) {
    return [(sx - state.offsetX) / state.scale, (sy - state.offsetY) / state.scale];
  }
  function screenToGrid(sx, sy) {
    const [wx, wy] = screenToWorld(sx, sy);
    return [Math.floor(wx), Math.floor(wy)];
  }

  // ---------- 当前笔刷的覆盖范围 ----------
  function currentStamp() {
    if (state.tool === 'eraser') {
      return state.eraserMode === 'custom'
        ? { mode: 'custom', data: customEraser }
        : { mode: 'square', size: state.eraserSize };
    }
    return state.brushMode === 'custom'
      ? { mode: 'custom', data: customBrush }
      : { mode: 'square', size: state.brushSize };
  }
  function stampBounds(gx, gy, t) {
    if (t.mode === 'square') {
      const r = Math.floor(t.size / 2);
      return { x0: gx - r, y0: gy - r, x1: gx - r + t.size - 1, y1: gy - r + t.size - 1 };
    }
    const b = t.data;
    const ox = gx - Math.floor(b.w / 2), oy = gy - Math.floor(b.h / 2);
    return { x0: ox, y0: oy, x1: ox + b.w - 1, y1: oy + b.h - 1 };
  }

  // ---------- 撤销 / 重做 ----------
  const undoStack = [];
  const redoStack = [];
  let currentStroke = null; // 当前一次操作的修改记录：Map<key, [layerIdx, key, 旧值, 新值]>

  function beginStroke() { currentStroke = new Map(); }
  function recordCell(key, oldVal, newVal, layerIdx) {
    if (!currentStroke) return;
    const rec = currentStroke.get(key);
    if (rec) rec[3] = newVal;               // 同一格多次修改，只保留最终值
    else currentStroke.set(key, [layerIdx === undefined ? state.activeLayer : layerIdx, key, oldVal, newVal]);
  }
  function endStroke() {
    if (currentStroke && currentStroke.size > 0) {
      undoStack.push(Array.from(currentStroke.values()));
      if (undoStack.length > state.maxUndoSteps) undoStack.shift();
      redoStack.length = 0;
      updateUndoUI();
    }
    currentStroke = null;
  }
  function applyDiff(diff, useNew) {
    for (const rec of diff) {
      // rec = [layerIdx, key, old, new]（新）或 [key, old, new]（旧格式兼容）
      const li = rec.length === 4 ? rec[0] : state.activeLayer;
      const key = rec.length === 4 ? rec[1] : rec[0];
      const v = useNew ? (rec.length === 4 ? rec[3] : rec[2]) : (rec.length === 4 ? rec[2] : rec[1]);
      const L = state.layers[li];
      if (!L) continue; // 图层已被删除，跳过
      if (v === null || v === undefined) L.pixels.delete(key);
      else L.pixels.set(key, v);
      markDirtyKey(key, li);
    }
    requestRender();
  }
  function undo() {
    const rec = undoStack.pop();
    if (!rec) return;
    applyDiff(rec, false);
    redoStack.push(rec);
    updateUndoUI();
    requestRender();
  }
  function redo() {
    const rec = redoStack.pop();
    if (!rec) return;
    applyDiff(rec, true);
    undoStack.push(rec);
    if (undoStack.length > state.maxUndoSteps) undoStack.shift();
    updateUndoUI();
    requestRender();
  }
  function clearHistory() {
    undoStack.length = 0;
    redoStack.length = 0;
    currentStroke = null;
    updateUndoUI();
  }
  function updateUndoUI() {
    const canU = undoStack.length > 0, canR = redoStack.length > 0;
    els.btnUndo.classList.toggle('disabled', !canU);
    els.btnRedo.classList.toggle('disabled', !canR);
    els.settingsUndo.classList.toggle('disabled', !canU);
    els.settingsRedo.classList.toggle('disabled', !canR);
  }
  function markDirtyKey(key, layerIdx) {
    const i = key.indexOf(',');
    layerCache(layerIdx === undefined ? state.activeLayer : layerIdx)
      .dirty.add((+key.slice(0, i) >> 5) + ',' + (+key.slice(i + 1) >> 5));
  }

  // 所有像素修改的唯一入口：记录撤销信息并写数据（默认写入活动图层，可指定 layerIdx）
  function paintCellRaw(key, newVal, layerIdx) {
    const li = layerIdx === undefined ? state.activeLayer : layerIdx;
    const map = state.layers[li].pixels;
    const old = map.get(key);
    if (old === newVal) return;
    recordCell(key, old, newVal, li);
    if (newVal === null || newVal === undefined) map.delete(key);
    else map.set(key, newVal);
    markDirtyKey(key, li); // 标记所在渲染块为脏，否则块缓存不会重建（填充等会不显示）
  }

  // ---------- 绘制 ----------
  function paintStampAt(gx, gy, t) {
    const b = stampBounds(gx, gy, t);
    if (state.tool === 'eraser') {
      if (t.mode === 'square') {
        for (let y = b.y0; y <= b.y1; y++)
          for (let x = b.x0; x <= b.x1; x++) paintCellRaw(x + ',' + y, null);
      } else {
        for (const key of t.data.pixels.keys()) {
          const i = key.indexOf(',');
          paintCellRaw((b.x0 + +key.slice(0, i)) + ',' + (b.y0 + +key.slice(i + 1)), null);
        }
      }
    } else if (t.mode === 'square') {
      for (let y = b.y0; y <= b.y1; y++)
        for (let x = b.x0; x <= b.x1; x++) paintCellRaw(x + ',' + y, state.color);
    } else {
      // 自定义笔刷：图案中的颜色仅作为“形状标记”，盖印统一使用当前画笔颜色，
      // 这样修改画笔颜色对自定义笔刷立即生效
      for (const key of t.data.pixels.keys()) {
        const i = key.indexOf(',');
        paintCellRaw((b.x0 + +key.slice(0, i)) + ',' + (b.y0 + +key.slice(i + 1)), state.color);
      }
    }
    markDirtyRect(b.x0, b.y0, b.x1, b.y1);
  }

  // Bresenham 直线插值，防止快速拖动断线
  function linePaint(x0, y0, x1, y1, t) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      paintStampAt(x, y, t);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  // ---------- 渲染 ----------
  let rafPending = false;
  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; render(); });
  }

  // 沉浸模式：绘图（左键按下拖动）时自动隐藏工具栏、提示等 UI，画面更干净；
  // 也可通过 🙈 按钮 / 设置面板 / H 键手动切换
  let fastMode = false;
  function updateUI() {
    const hidden = fastMode || state.uiHidden;
    // 尊重用户通过 ⤒/⤍ 开关做的「单独隐藏」（dataset.userHidden），沉浸模式也不强制显示
    els.toolbarEl.style.display = (hidden || els.toolbarEl.dataset.userHidden === '1') ? 'none' : '';
    els.hintEl.style.display = (hidden || els.hintEl.dataset.userHidden === '1') ? 'none' : '';
    els.sideToolbar.style.display = (hidden || els.sideToolbar.dataset.userHidden === '1') ? 'none' : '';
    els.layersPanel.style.display = hidden ? 'none' : '';
    els.layersToggle.style.display = hidden ? 'none' : '';
    els.btnHideUI.classList.toggle('active', state.uiHidden);
    els.settingsHideUI.classList.toggle('active', state.uiHidden);
    if (hidden) els.moreMenu.classList.remove('open'); // 沉浸模式收起更多菜单
    if (hidden) els.shapeMenu.classList.remove('open'); // 沉浸模式收起封闭图形菜单
    // 手动隐藏时显示右下角“显示”按钮，方便恢复（绘图自动隐藏时不显示）
    els.btnRestoreUI.style.display = state.uiHidden ? 'block' : 'none';
  }
  function toggleHideUI() {
    state.uiHidden = !state.uiHidden;
    updateUI();
  }

  // 分块缓存渲染：像素按 32×32 分块，每块缓存成一张小 canvas。
  // 照片类大图几乎每像素颜色不同，逐像素 fillRect 必然卡死；
  // 块缓存把每帧的绘制次数从“像素数”降为“可见块数”，
  // 并且缩小时画布只是对小块做 drawImage 缩放，非常快。
  // 每个图层拥有独立的块缓存与脏标记。
  const CHUNK = 32;
  const CHUNK_BUDGET_MS = 12;          // 每帧重建块的预算，超出的留到下帧（渐进渲染）
  const layerChunks = [];              // layerChunks[i] = { map: Map, dirty: Set }
  function layerCache(i) {
    if (!layerChunks[i]) layerChunks[i] = { map: new Map(), dirty: new Set() };
    return layerChunks[i];
  }

  function markDirtyRect(x0, y0, x1, y1, layerIdx) {
    const c = layerCache(layerIdx === undefined ? state.activeLayer : layerIdx);
    const cx0 = x0 >> 5, cx1 = x1 >> 5, cy0 = y0 >> 5, cy1 = y1 >> 5;
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) c.dirty.add(cx + ',' + cy);
  }

  function buildChunk(cx, cy, layerIdx) {
    const li = layerIdx === undefined ? state.activeLayer : layerIdx;
    const c = layerCache(li);
    if (c.map.size > 40000) c.map.clear(); // 内存保护：缓存块过多时整体重建
    let chunk = c.map.get(cx + ',' + cy);
    if (!chunk) {
      chunk = document.createElement('canvas');
      chunk.width = CHUNK; chunk.height = CHUNK;
      c.map.set(cx + ',' + cy, chunk);
    }
    const cc = chunk.getContext('2d');
    cc.clearRect(0, 0, CHUNK, CHUNK);
    const x0 = cx * CHUNK, y0 = cy * CHUNK, map = state.layers[li].pixels;
    for (let y = 0; y < CHUNK; y++) {
      const gy = y0 + y;
      for (let x = 0; x < CHUNK; x++) {
        const col = map.get((x0 + x) + ',' + gy);
        if (col !== undefined) {
          if (cc.fillStyle !== col) cc.fillStyle = col;
          cc.fillRect(x, y, 1, 1);
        }
      }
    }
  }

  function render() {
    const w = cssW(), h = cssH(), p = dpr();
    if (w === 0 || h === 0) return;

    ctx.setTransform(p, 0, 0, p, 0, 0);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    // 可见范围（像素坐标）
    const gx0 = Math.floor((0 - state.offsetX) / state.scale);
    const gx1 = Math.floor((w - state.offsetX) / state.scale);
    const gy0 = Math.floor((0 - state.offsetY) / state.scale);
    const gy1 = Math.floor((h - state.offsetY) / state.scale);

    drawGridLines(w, h, gx0, gx1, gy0, gy1, p);

    drawChunks(gx0, gx1, gy0, gy1, p);
    drawStampPreview(p);
    drawSelectionGrid(p);
    drawShapePreview(p);
    // 实例已并入 drawChunks 的图层循环（每层像素后画该层实例，上层覆盖下层）
    drawStatsPreview(p);
    drawNodeSelPreview(p);
    drawSelMovePreview(p);
    drawVarMonitors(p); // 变量监控（node-system.js：「显示变量A」在画布/舞台上可视化变量）
  }

  function drawChunks(gx0, gx1, gy0, gy1, p) {
    const cx0 = gx0 >> 5, cx1 = gx1 >> 5, cy0 = gy0 >> 5, cy1 = gy1 >> 5;
    const t0 = performance.now();
    // 收集需要重建的块：活动图层优先，其次其他可见图层
    const collect = function (li) {
      const out = [];
      const c = layerCache(li);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cx + ',' + cy;
          if (c.dirty.has(key) || !c.map.has(key)) out.push({ cx: cx, cy: cy, key: key });
        }
      return out;
    };
    const todo = [];
    let anyPending = false;
    if (state.layers[state.activeLayer] && state.layers[state.activeLayer].visible) {
      todo.push.apply(todo, collect(state.activeLayer).map(function (r) { r.li = state.activeLayer; return r; }));
    }
    for (let li = 0; li < state.layers.length; li++) {
      if (li === state.activeLayer || !state.layers[li].visible) continue;
      todo.push.apply(todo, collect(li).map(function (r) { r.li = li; return r; }));
    }
    // 按帧预算渐进重建
    for (let k = 0; k < todo.length; k++) {
      if (performance.now() - t0 > CHUNK_BUDGET_MS) { anyPending = true; break; }
      buildChunk(todo[k].cx, todo[k].cy, todo[k].li);
      layerCache(todo[k].li).dirty.delete(todo[k].key);
    }
    // 按图层顺序（底→顶）绘制所有可见块的缓存，并紧随其后绘制该图层的实例：
    // 上层图层的像素与实例都覆盖下层图层（实例不再盖在所有像素之上）
    ctx.setTransform(p * state.scale, 0, 0, p * state.scale,
                     p * state.offsetX, p * state.offsetY);
    ctx.imageSmoothingEnabled = state.scale < 1; // 放大时最近邻（像素清晰），缩小时平滑
    for (let li = 0; li < state.layers.length; li++) {
      if (!state.layers[li].visible) continue;
      const c = layerCache(li);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const chunk = c.map.get(cx + ',' + cy);
          if (chunk) ctx.drawImage(chunk, cx * CHUNK, cy * CHUNK);
        }
      drawInstances(p, li); // 该图层的实例紧跟像素，参与图层遮挡
    }
    // 本帧预算内没重建完的块：下一帧继续（渐进渲染）
    if (anyPending) requestRender();
  }

  function drawGridLines(w, h, gx0, gx1, gy0, gy1, p) {
    ctx.setTransform(p, 0, 0, p, 0, 0);
    if (!state.showGrid && !state.showAxis) return; // 网格线与坐标轴都关闭
    const s = state.scale; // 相邻像素的屏幕间距
    let step = 1;
    if (state.showGrid) {
      if (state.gridStep === 'auto') {
        // 自动：网格间距随缩放自适应，始终保持合适的视觉密度（线距 >= 12px）
        step = 1;
        while (s * step < 12) step *= 2;
      } else {
        step = state.gridStep;
      }
      // 线数量上限保护（稀疏化后仍可能超限）
      const cols = (gx1 - gx0 + 1) / step, rows = (gy1 - gy0 + 1) / step;
      const MAX = 6000;
      if (cols > MAX) step *= Math.ceil(cols / MAX);
      if (rows > MAX) step *= Math.ceil(rows / MAX);

      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const startX = Math.floor(gx0 / step) * step;
      for (let k = startX; k <= gx1; k += step) {
        const sx = Math.round(k * s + state.offsetX) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
      }
      const startY = Math.floor(gy0 / step) * step;
      for (let k = startY; k <= gy1; k += step) {
        const sy = Math.round(k * s + state.offsetY) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(w, sy);
      }
      ctx.stroke();
    }

    // 原点坐标轴（独立开关，不影响网格线）
    if (state.showAxis) {
      ctx.strokeStyle = AXIS_COLOR;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      if (gx0 <= 0 && 0 <= gx1) {
        const sx = Math.round(0 * s + state.offsetX) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
      }
      if (gy0 <= 0 && 0 <= gy1) {
        const sy = Math.round(0 * s + state.offsetY) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(w, sy);
      }
      ctx.stroke();
    }

    // 数轴刻度数字（随「数轴刻度数字」开关显示；间隔随缩放自适应）
    drawAxisLabels(w, h, gx0, gx1, gy0, gy1, p);
  }

  // 刻度间隔取「漂亮」步长（1/2/5×10^k），保证数字在屏幕上不重叠
  function niceTickStep(pxPerUnit, minPx) {
    let raw = minPx / pxPerUnit;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const r = raw / pow;
    const m = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
    return m * pow;
  }
  function fmtTick(v) {
    const r = Math.round(v * 1e6) / 1e6;
    return (r === Math.floor(r) && Math.abs(r) < 1e12) ? String(Math.floor(r)) : String(r);
  }
  // 数轴刻度数字：X 轴数字在轴下方，Y 轴数字在轴左侧；Y 轴按数学坐标（向上为正）
  function drawAxisLabels(w, h, gx0, gx1, gy0, gy1, p) {
    if (!state.showAxis || !state.showAxisLabels) return;
    const s = state.scale;
    // 字号：默认随「显示大小」自动调整，手动拖动滑块后用手动值
    const labelPx = state.axisLabelAuto
      ? clamp(Math.round((+els.mathScale.value || 8) * 1.6), 8, 28)
      : state.axisLabelSize;
    const step = niceTickStep(s, Math.max(56, labelPx * 3.2));
    ctx.setTransform(p, 0, 0, p, 0, 0);
    ctx.fillStyle = AXIS_COLOR;
    ctx.font = labelPx + 'px system-ui, sans-serif';
    // X 轴（画布水平线 y=0）：刻度数字在轴下方
    if (gy0 <= 0 && 0 <= gy1) {
      const ay = Math.round(0 * s + state.offsetY);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let k = Math.ceil(gx0 / step) * step; k <= gx1; k += step) {
        if (k === 0) continue; // 原点不标注
        const sx = Math.round(k * s + state.offsetX);
        ctx.fillText(fmtTick(k), sx, ay + 4);
      }
    }
    // Y 轴（画布竖直线 x=0）：刻度数字在轴左侧，数值 = 数学坐标（Y 向上为正，取 -k）
    if (gx0 <= 0 && 0 <= gx1) {
      const ax = Math.round(0 * s + state.offsetX);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let k = Math.ceil(gy0 / step) * step; k <= gy1; k += step) {
        if (k === 0) continue;
        const sy = Math.round(k * s + state.offsetY);
        ctx.fillText(fmtTick(-k), ax - 5, sy);
      }
    }
  }

  // 鼠标处的笔刷预览框
  function drawStampPreview(p) {
    if (!state.mouseOnCanvas) return;
    const g = screenToGrid(state.mouseX, state.mouseY);
    const t = currentStamp();
    if (!t.data && t.mode === 'custom') return; // 自定义笔刷未创建
    const b = stampBounds(g[0], g[1], t);
    const s = state.scale;
    const x = b.x0 * s + state.offsetX, y = b.y0 * s + state.offsetY;
    const w = (b.x1 - b.x0 + 1) * s, h = (b.y1 - b.y0 + 1) * s;
    ctx.setTransform(p, 0, 0, p, 0, 0);
    ctx.strokeStyle = state.tool === 'eraser' ? 'rgba(220,60,60,.85)' : 'rgba(40,40,60,.75)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  // 选择网格：开启颜色代码或使用拾色器时，高亮鼠标所在的当前格子
  function drawSelectionGrid(p) {
    if ((!state.showColorInfo && state.tool !== 'picker') || !state.mouseOnCanvas) return;
    const g = screenToGrid(state.mouseX, state.mouseY);
    const s = state.scale;
    const x = g[0] * s + state.offsetX, y = g[1] * s + state.offsetY;
    ctx.setTransform(p, 0, 0, p, 0, 0);
    ctx.strokeStyle = 'rgba(255, 45, 45, .95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
  }

  // ---------- 缩放 / 平移 ----------
  function zoomAt(cx, cy, factor) {
    const ns = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);
    if (ns === state.scale) return;
    const wx = (cx - state.offsetX) / state.scale;
    const wy = (cy - state.offsetY) / state.scale;
    state.scale = ns;
    state.offsetX = cx - wx * state.scale;
    state.offsetY = cy - wy * state.scale;
    updateZoomLabel();
    requestRender();
  }
  function updateZoomLabel() {
    els.zoomVal.textContent = Math.round(state.scale * 100) + '%';
  }

  // ---------- 颜色信息浮层 ----------
  function updateColorInfo() {
    const el = els.colorInfo;
    if (fastMode) { el.style.display = 'none'; return; } // 绘图时隐藏，避免拖慢
    if (!state.showColorInfo) { el.style.display = 'none'; return; }
    if (!state.mouseOnCanvas) { el.style.display = 'none'; return; }
    const g = screenToGrid(state.mouseX, state.mouseY);
    const color = state.pixels.get(g[0] + ',' + g[1]);
    const hex = color || '#00000000';
    // 颜色代码在前，网格坐标在后
    el.innerHTML = '<span class="sw" style="background:' + hex + '"></span>' +
      (color ? hex : '空') + '&nbsp; (' + g[0] + ', ' + g[1] + ')';
    el.style.display = 'block';
    const pad = 14, w = cssW(), h = cssH();
    const ew = el.offsetWidth, eh = el.offsetHeight;
    el.style.left = clamp(state.mouseX + 14, 0, w - ew - 6) + 'px';
    el.style.top = clamp(state.mouseY + 16, 0, h - eh - 6) + 'px';
  }

  // ---------- 交互（主画布） ----------
  let spaceHeld = false;
  const pointers = new Map();
  let panState = null, drawState = null, pinchState = null, dragInst = null;

  function syncToolUI() {
    const t = state.tool;
    els.rToolBrush.classList.toggle('active', t === 'brush' || t === 'eraser');
    els.rToolBrush.textContent = t === 'eraser' ? '🧹' : '🖌';
    els.rToolBrush.title = t === 'eraser' ? '橡皮（点击展开选择）' : '画笔（点击展开选择）';
    els.settingsTool.value = t;
    els.btnOpenPicker.classList.toggle('active', t === 'picker');
    const isShape = t === 'rect' || t === 'circle' || t === 'triangle' || t === 'fill';
    els.rToolShape.classList.toggle('active', isShape);
    // 封闭图形按钮显示当前选择的形状图标
    if (t === 'circle') els.rToolShape.textContent = '◯';
    else if (t === 'triangle') els.rToolShape.textContent = '△';
    else if (t === 'fill') els.rToolShape.textContent = '🪣';
    else els.rToolShape.textContent = '▭';
    els.rToolShape.title = '封闭图形（点击展开选择）：' +
      (t === 'circle' ? '圆形' : t === 'triangle' ? '三角形' : t === 'fill' ? '填充' : '矩形');
    els.rToolMove.classList.toggle('active', t === 'move');
    els.rToolSelect.classList.toggle('active', t === 'sel' || t === 'nodeSelect');
  }
  function syncModeUI() {
    els.settingsBrushMode.value = state.brushMode;
    els.settingsEraserMode.value = state.eraserMode;
    els.bpBrushMode.value = state.brushMode;
    els.bpEraserMode.value = state.eraserMode;
  }
  function syncSizeUI() {
    els.settingsBrushSize.value = state.brushSize;
    els.settingsBrushSizeVal.textContent = state.brushSize;
    els.settingsEraserSize.value = state.eraserSize;
    els.settingsEraserSizeVal.textContent = state.eraserSize;
    els.bpBrushSize.value = state.brushSize;
    els.bpBrushSizeVal.textContent = state.brushSize;
    els.bpEraserSize.value = state.eraserSize;
    els.bpEraserSizeVal.textContent = state.eraserSize;
  }
  function syncColorInputs() {
    els.settingsColor.value = state.color;
    els.bpColor.value = state.color;
    // 通知监听方（如调色板高亮）颜色已变化
    document.dispatchEvent(new CustomEvent('colorchange'));
  }

  function setTool(t) {
    state.tool = t;
    // 切换工具时清除「框选移动」区域（move 手掌拖动 / moveSel 重新框选时保留）
    if (t !== 'move' && t !== 'sel') { selMoveStart = null; selMoveEnd = null; dragSelMove = null; }
    syncToolUI();
    syncSizeUI();
    // 若选中了“自定义”但尚未创建，打开画板
    if (t === 'brush' && state.brushMode === 'custom' && !customBrush) openModal('brush');
    if (t === 'eraser' && state.eraserMode === 'custom' && !customEraser) openModal('eraser');
    requestRender();
  }

  function setBrushMode(m) {
    state.brushMode = m;
    syncModeUI();
    if (m === 'custom' && !customBrush) openModal('brush');
    syncSizeUI();
  }
  function setEraserMode(m) {
    state.eraserMode = m;
    syncModeUI();
    if (m === 'custom' && !customEraser) openModal('eraser');
    syncSizeUI();
  }

  // ---- 图形 / 统计工具的状态与实现 ----
  let shapeStart = null, shapeEnd = null;   // 图形工具起止（格子坐标）
  let statsStart = null, statsEnd = null, statsShift = false;
  let nodeSelStart = null, nodeSelEnd = null; // 「框选添加节点」起止（格子坐标）
  let selMoveStart = null, selMoveEnd = null; // 「框选移动」区域（格子坐标，常驻供手掌工具拖动）
  let dragSelMove = null; // 手掌拖动框选像素中

  // 拾色器：拾取鼠标下方格子的颜色
  function pickColor(gx, gy) {
    const c = state.pixels.get(gx + ',' + gy);
    if (!c) return; // 空白格子不改变颜色
    state.color = c;
    syncColorInputs();
  }

  // 封闭填充（flood fill）：点击填充同色连通区域
  function floodFill(gx, gy) {
    const target = state.pixels.get(gx + ',' + gy);
    if (target === state.color) return;
    const stack = [[gx, gy]];
    const seen = new Set();
    const LIMIT = 500000;
    let count = 0;
    beginStroke();
    while (stack.length && count < LIMIT) {
      const [x, y] = stack.pop();
      const key = x + ',' + y;
      if (seen.has(key)) continue;
      seen.add(key);
      if (state.pixels.get(key) !== target) continue;
      paintCellRaw(key, state.color);
      count++;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    endStroke();
    if (count >= LIMIT) alert('填充区域过大（超过 50 万像素），已停止。');
    requestRender();
  }

  function bresenhamLine(x0, y0, x1, y1, cb) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      cb(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }
  function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  // 三角形顶点：按拖动方向区分正 / 倒三角
  function trianglePoints(s0, s1) {
    const x0 = Math.min(s0.x, s1.x), x1 = Math.max(s0.x, s1.x);
    const y0 = Math.min(s0.y, s1.y), y1 = Math.max(s0.y, s1.y);
    const midX = (x0 + x1) / 2;
    if (s1.y >= s0.y) return [[midX, y0], [x0, y1], [x1, y1]]; // 向下拖：正三角（顶点在上）
    return [[midX, y1], [x0, y0], [x1, y0]];                  // 向上拖：倒三角（顶点在下）
  }

  // 以画笔大小画一个“粗点”（图形轮廓的粗细 = 画笔大小）
  function paintBrushCell(x, y) {
    const r = Math.floor(state.brushSize / 2);
    for (let dy = -r; dy < state.brushSize - r; dy++)
      for (let dx = -r; dx < state.brushSize - r; dx++)
        paintCellRaw((x + dx) + ',' + (y + dy), state.color);
  }

  // 图形工具落笔（pointerup 时一次性绘制：仅轮廓，粗细 = 画笔大小）
  function commitShape() {
    const x0 = Math.min(shapeStart.x, shapeEnd.x), x1 = Math.max(shapeStart.x, shapeEnd.x);
    const y0 = Math.min(shapeStart.y, shapeEnd.y), y1 = Math.max(shapeStart.y, shapeEnd.y);
    beginStroke();
    if (state.tool === 'rect') {
      // 矩形：四条边（轮廓）
      for (let x = x0; x <= x1; x++) { paintBrushCell(x, y0); paintBrushCell(x, y1); }
      for (let y = y0; y <= y1; y++) { paintBrushCell(x0, y); paintBrushCell(x1, y); }
    } else if (state.tool === 'circle') {
      // 圆形：边界像素（自身在圆内、四邻域有在圆外的格子）
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const rx = Math.max(0.5, (x1 - x0 + 1) / 2), ry = Math.max(0.5, (y1 - y0 + 1) / 2);
      const inC = function (x, y) { const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry; return dx * dx + dy * dy <= 1; };
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          if (inC(x, y) && (!inC(x - 1, y) || !inC(x + 1, y) || !inC(x, y - 1) || !inC(x, y + 1))) paintBrushCell(x, y);
        }
    } else if (state.tool === 'triangle') {
      // 三角形：三条边（轮廓），方向由拖动方向决定
      const pts = trianglePoints(shapeStart, shapeEnd);
      bresenhamLine(pts[0][0], pts[0][1], pts[1][0], pts[1][1], function (x, y) { paintBrushCell(x, y); });
      bresenhamLine(pts[1][0], pts[1][1], pts[2][0], pts[2][1], function (x, y) { paintBrushCell(x, y); });
      bresenhamLine(pts[2][0], pts[2][1], pts[0][0], pts[0][1], function (x, y) { paintBrushCell(x, y); });
    } else if (state.tool === 'line') {
      bresenhamLine(shapeStart.x, shapeStart.y, shapeEnd.x, shapeEnd.y, function (x, y) { paintBrushCell(x, y); });
    }
    endStroke();
    const pad = state.brushSize;
    markDirtyRect(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
    requestRender();
  }

  // 图形 / 统计预览（拖动过程中）
  function drawShapePreview(p) {
    if (!shapeStart || !shapeEnd) return;
    const s = state.scale;
    const X = function (gx) { return gx * s + state.offsetX; };
    const Y = function (gy) { return gy * s + state.offsetY; };
    ctx.setTransform(p, 0, 0, p, 0, 0);
    ctx.strokeStyle = 'rgba(30, 120, 255, .95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (state.tool === 'rect') {
      ctx.rect(X(shapeStart.x), Y(shapeStart.y), (shapeEnd.x - shapeStart.x + 1) * s, (shapeEnd.y - shapeStart.y + 1) * s);
    } else if (state.tool === 'circle') {
      const cx = (X(shapeStart.x) + X(shapeEnd.x)) / 2, cy = (Y(shapeStart.y) + Y(shapeEnd.y)) / 2;
      const rx = Math.abs(X(shapeEnd.x) - X(shapeStart.x)) / 2 + s / 2;
      const ry = Math.abs(Y(shapeEnd.y) - Y(shapeStart.y)) / 2 + s / 2;
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    } else if (state.tool === 'triangle') {
      const pts = trianglePoints(shapeStart, shapeEnd);
      ctx.moveTo(X(pts[0][0]) + s / 2, Y(pts[0][1]) + s / 2);
      ctx.lineTo(X(pts[1][0]) + s / 2, Y(pts[1][1]) + s / 2);
      ctx.lineTo(X(pts[2][0]) + s / 2, Y(pts[2][1]) + s / 2);
      ctx.closePath();
    } else if (state.tool === 'line') {
      ctx.moveTo(X(shapeStart.x) + s / 2, Y(shapeStart.y) + s / 2);
      ctx.lineTo(X(shapeEnd.x) + s / 2, Y(shapeEnd.y) + s / 2);
    }
    ctx.stroke();
  }
  function drawStatsPreview(p) {
    if (!statsStart || !statsEnd) return;
    const s = state.scale;
    const X = function (gx) { return gx * s + state.offsetX; };
    const Y = function (gy) { return gy * s + state.offsetY; };
    ctx.setTransform(p, 0, 0, p, 0, 0);
    ctx.strokeStyle = 'rgba(255, 180, 40, .95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (statsShift) {
      ctx.moveTo(X(statsStart.x) + s / 2, Y(statsStart.y) + s / 2);
      ctx.lineTo(X(statsEnd.x) + s / 2, Y(statsEnd.y) + s / 2);
    } else {
      ctx.rect(X(Math.min(statsStart.x, statsEnd.x)), Y(Math.min(statsStart.y, statsEnd.y)),
               (Math.abs(statsEnd.x - statsStart.x) + 1) * s, (Math.abs(statsEnd.y - statsStart.y) + 1) * s);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // 「框选添加节点」预览（拖动过程中）
  function drawNodeSelPreview(p) {
    if (!nodeSelStart || !nodeSelEnd) return;
    const s = state.scale;
    const X = function (gx) { return gx * s + state.offsetX; };
    const Y = function (gy) { return gy * s + state.offsetY; };
    const x0 = Math.min(nodeSelStart.x, nodeSelEnd.x), y0 = Math.min(nodeSelStart.y, nodeSelEnd.y);
    const x1 = Math.max(nodeSelStart.x, nodeSelEnd.x), y1 = Math.max(nodeSelStart.y, nodeSelEnd.y);
    ctx.setTransform(p, 0, 0, p, 0, 0);
    ctx.fillStyle = 'rgba(30, 200, 120, .14)';
    ctx.fillRect(X(x0), Y(y0), (x1 - x0 + 1) * s, (y1 - y0 + 1) * s);
    ctx.strokeStyle = 'rgba(30, 200, 120, .95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(X(x0), Y(y0), (x1 - x0 + 1) * s, (y1 - y0 + 1) * s);
  }

  // 「框选移动」区域：拖动时实时更新，框选完成后常驻显示（蓝色虚线），供手掌工具拖动
  function drawSelMovePreview(p) {
    if (!selMoveStart || !selMoveEnd) return;
    const s = state.scale;
    const X = function (gx) { return gx * s + state.offsetX; };
    const Y = function (gy) { return gy * s + state.offsetY; };
    const x0 = Math.min(selMoveStart.x, selMoveEnd.x), y0 = Math.min(selMoveStart.y, selMoveEnd.y);
    const x1 = Math.max(selMoveStart.x, selMoveEnd.x), y1 = Math.max(selMoveStart.y, selMoveEnd.y);
    ctx.setTransform(p, 0, 0, p, 0, 0);
    ctx.fillStyle = 'rgba(80, 140, 255, .12)';
    ctx.fillRect(X(x0), Y(y0), (x1 - x0 + 1) * s, (y1 - y0 + 1) * s);
    ctx.strokeStyle = 'rgba(80, 140, 255, .95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(X(x0), Y(y0), (x1 - x0 + 1) * s, (y1 - y0 + 1) * s);
    ctx.setLineDash([]);
  }

  // 图像统计：矩形框选 / Shift+拖动 直线统计
  function computeStats() {
    const isLine = statsShift;
    const x0 = Math.min(statsStart.x, statsEnd.x), x1 = Math.max(statsStart.x, statsEnd.x);
    const y0 = Math.min(statsStart.y, statsEnd.y), y1 = Math.max(statsStart.y, statsEnd.y);
    const counts = new Map();
    let total = 0, empty = 0;
    const addCell = function (x, y) {
      total++;
      const c = state.pixels.get(x + ',' + y);
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
      else empty++;
    };
    if (isLine) {
      bresenhamLine(statsStart.x, statsStart.y, statsEnd.x, statsEnd.y, addCell);
    } else {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) addCell(x, y);
    }
    state.stats = {
      mode: isLine ? 'line' : 'rect',
      x0: x0, y0: y0, x1: x1, y1: y1,
      total: total, empty: empty, counts: counts,
    };
    renderStatsPanel();
    openSelectPanel();
  }
  function renderStatsPanel() {
    const st = state.stats;
    if (!st) return;
    if (els.selInfo) {
      els.selInfo.textContent = '范围 (' + st.x0 + ', ' + st.y0 + ') ~ (' + st.x1 + ', ' + st.y1 + ')' +
        (st.mode === 'rect' ? ' · ' + (st.x1 - st.x0 + 1) + ' × ' + (st.y1 - st.y0 + 1) + ' 像素' : '（直线）');
    }
    const sorted = Array.from(st.counts.entries()).sort(function (a, b) { return b[1] - a[1]; });
    let html = '<div>方式：' + (st.mode === 'line' ? '直线统计' : '矩形框选') + '</div>';
    html += '<div>范围：(' + st.x0 + ', ' + st.y0 + ') ~ (' + st.x1 + ', ' + st.y1 + ')' +
      (st.mode === 'rect' ? '（' + (st.x1 - st.x0 + 1) + ' × ' + (st.y1 - st.y0 + 1) + '）' : '') + '</div>';
    html += '<div>像素总数：' + st.total + '（空白 ' + st.empty + '）</div>';
    html += '<div>颜色数量：' + sorted.length + '</div>';
    for (const [c, n] of sorted) {
      const pct = (n / st.total * 100).toFixed(1);
      html += '<div class="stat-row"><span class="stat-swatch" style="background:' + c + '"></span>' +
        c + ' × ' + n + '（' + pct + '%）</div>';
    }
    els.statsBody.innerHTML = html;
    if (els.selStats) {
      els.selStats.textContent = '像素 ' + st.total + '（空白 ' + st.empty + '）· 颜色 ' + sorted.length + ' 种';
    }
  }

  // ---------- 框选控制栏（统一框选工具：缩放 / 统计 / RotSprite 旋转 / 移动） ----------
  function selRect() {
    if (!selMoveStart || !selMoveEnd) return null;
    return {
      x0: Math.min(selMoveStart.x, selMoveEnd.x), y0: Math.min(selMoveStart.y, selMoveEnd.y),
      x1: Math.max(selMoveStart.x, selMoveEnd.x), y1: Math.max(selMoveStart.y, selMoveEnd.y),
    };
  }
  function openSelectPanel() {
    const r = selRect();
    if (!r) return;
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    els.selW.value = w;
    els.selH.value = h;
    if (els.selInfo) els.selInfo.textContent = '范围 (' + r.x0 + ', ' + r.y0 + ') ~ (' + r.x1 + ', ' + r.y1 + ') · ' + w + ' × ' + h + ' 像素';
    els.selectPanel.classList.add('open');
  }
  // 图像统计：点击按钮后统计当前框选区域
  function doSelStats() {
    const r = selRect();
    if (!r) { alert('请先在画布上框选一片区域'); return; }
    // 开关：已统计且导出按钮可见 → 再点一次隐藏
    if (els.selExportRow && els.selExportRow.style.display !== 'none') {
      state.stats = null;
      els.statsBody.innerHTML = '';
      els.selStats.textContent = '';
      els.selExportRow.style.display = 'none';
      return;
    }
    statsStart = { x: r.x0, y: r.y0 }; statsEnd = { x: r.x1, y: r.y1 }; statsShift = false;
    computeStats();
    if (els.selExportRow) els.selExportRow.style.display = '';
    els.selectPanel.classList.add('open');
  }
  function clearSel() {
    selMoveStart = null; selMoveEnd = null; dragSelMove = null;
    state.stats = null;
    if (els.selExportRow) els.selExportRow.style.display = 'none';
    if (els.selectPanel) els.selectPanel.classList.remove('open');
    requestRender();
  }
  // 读取框选区域像素（2D 数组，空 = null）
  function readSelPixels(r) {
    const L = state.layers[state.activeLayer];
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    const src = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) row.push(L.pixels.get((r.x0 + x) + ',' + (r.y0 + y)) || null);
      src.push(row);
    }
    return src;
  }
  // 最近邻缩放框选内容到新尺寸（保持像素锐利）
  function applySelScale() {
    const r = selRect();
    if (!r) { alert('请先在画布上框选一片区域'); return; }
    const nw = Math.round(+els.selW.value), nh = Math.round(+els.selH.value);
    if (!nw || !nh || nw < 1 || nh < 1 || nw > 4096 || nh > 4096) { alert('宽度/长度需为 1-4096 的整数'); return; }
    const src = readSelPixels(r);
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    if (nw === w && nh === h) return;
    const L = state.layers[state.activeLayer];
    beginStroke();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const key = (r.x0 + x) + ',' + (r.y0 + y);
      const ov = L.pixels.get(key);
      if (ov !== undefined) { recordCell(key, ov, null); L.pixels.delete(key); }
    }
    // 中心对齐
    const cx = r.x0 + Math.floor(w / 2), cy = r.y0 + Math.floor(h / 2);
    const nx0 = cx - Math.floor(nw / 2), ny0 = cy - Math.floor(nh / 2);
    for (let ty = 0; ty < nh; ty++) {
      const sy = Math.min(h - 1, Math.floor(ty * h / nh));
      for (let tx = 0; tx < nw; tx++) {
        const sx = Math.min(w - 1, Math.floor(tx * w / nw));
        const c = src[sy][sx];
        if (c) {
          const key = (nx0 + tx) + ',' + (ny0 + ty);
          const ov = L.pixels.get(key);
          recordCell(key, ov === undefined ? null : ov, c);
          L.pixels.set(key, c);
        }
      }
    }
    endStroke();
    selMoveStart = { x: nx0, y: ny0 }; selMoveEnd = { x: nx0 + nw - 1, y: ny0 + nh - 1 };
    markDirtyRect(Math.min(r.x0, nx0), Math.min(r.y0, ny0), Math.max(r.x1, nx0 + nw - 1), Math.max(r.y1, ny0 + nh - 1), state.activeLayer);
    requestRender();
    openSelectPanel();
  }
  // RotSprite 旋转：先放大 4 倍 → 旋转 → 面积平均缩小，最大程度保留像素边缘
  function applySelRotate() {
    const r = selRect();
    if (!r) { alert('请先在画布上框选一片区域'); return; }
    const angle = parseFloat(els.selAngle.value) || 0;
    if (angle % 360 === 0) return;
    const rad = angle * Math.PI / 180;
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    const src = readSelPixels(r);
    const L = state.layers[state.activeLayer];
    // 1. 放大 UP 倍（最近邻）
    const UP = 4;
    const UW = w * UP, UH = h * UP;
    const up = document.createElement('canvas'); up.width = UW; up.height = UH;
    const uc = up.getContext('2d');
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = src[y][x];
      if (c) { uc.fillStyle = c; uc.fillRect(x * UP, y * UP, UP, UP); }
    }
    // 2. 旋转（平滑插值）
    const ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
    const BW = Math.max(1, Math.ceil(UW * ca + UH * sa));
    const BH = Math.max(1, Math.ceil(UW * sa + UH * ca));
    const rot = document.createElement('canvas'); rot.width = BW; rot.height = BH;
    const rc = rot.getContext('2d');
    rc.translate(BW / 2, BH / 2);
    rc.rotate(rad);
    rc.drawImage(up, -UW / 2, -UH / 2);
    const img = rc.getImageData(0, 0, BW, BH);
    // 3. 缩小：目标像素 = 旋转大图中 UP×UP 区域面积平均（RotSprite 关键）
    const TW = Math.max(1, Math.ceil(BW / UP)), TH = Math.max(1, Math.ceil(BH / UP));
    const out = [];
    for (let ty = 0; ty < TH; ty++) {
      const row = [];
      for (let tx = 0; tx < TW; tx++) {
        let rr = 0, gg = 0, bb = 0, n = 0;
        for (let yy = ty * UP; yy < Math.min((ty + 1) * UP, BH); yy++)
          for (let xx = tx * UP; xx < Math.min((tx + 1) * UP, BW); xx++) {
            const i = (yy * BW + xx) * 4;
            if (img.data[i + 3] > 0) { rr += img.data[i]; gg += img.data[i + 1]; bb += img.data[i + 2]; n++; }
          }
        row.push(n ? '#' + [rr, gg, bb].map(function (v) { return Math.round(v / n).toString(16).padStart(2, '0'); }).join('') : null);
      }
      out.push(row);
    }
    // 4. 写入：清空原框选区域，结果以原框选中心对齐
    beginStroke();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const key = (r.x0 + x) + ',' + (r.y0 + y);
      const ov = L.pixels.get(key);
      if (ov !== undefined) { recordCell(key, ov, null); L.pixels.delete(key); }
    }
    const cx = r.x0 + Math.floor(w / 2), cy = r.y0 + Math.floor(h / 2);
    const nx0 = cx - Math.floor(TW / 2), ny0 = cy - Math.floor(TH / 2);
    for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) {
      const c = out[ty][tx];
      if (c) {
        const key = (nx0 + tx) + ',' + (ny0 + ty);
        const ov = L.pixels.get(key);
        recordCell(key, ov === undefined ? null : ov, c);
        L.pixels.set(key, c);
      }
    }
    endStroke();
    selMoveStart = { x: nx0, y: ny0 }; selMoveEnd = { x: nx0 + TW - 1, y: ny0 + TH - 1 };
    markDirtyRect(Math.min(r.x0, nx0), Math.min(r.y0, ny0), Math.max(r.x1, nx0 + TW - 1), Math.max(r.y1, ny0 + TH - 1), state.activeLayer);
    requestRender();
    openSelectPanel();
  }

  function buildStatsCSV() {
    const st = state.stats;
    const b = bounds();
    const imgW = (b.maxX - b.minX + 1) + 16, imgH = (b.maxY - b.minY + 1) + 16; // 导出 PNG 尺寸（含 8px 留白 ×2）
    const sorted = Array.from(st.counts.entries()).sort(function (a, b) { return b[1] - a[1]; });
    const L = [];
    L.push('图像统计');
    L.push('统计方式,' + (st.mode === 'line' ? '直线' : '矩形框选'));
    L.push('统计范围,(' + st.x0 + ',' + st.y0 + ')~(' + st.x1 + ',' + st.y1 + ')');
    L.push('统计尺寸,' + (st.x1 - st.x0 + 1) + 'x' + (st.y1 - st.y0 + 1) + ' px');
    L.push('像素总数,' + st.total);
    L.push('空白像素数,' + st.empty);
    L.push('颜色数量,' + sorted.length);
    L.push('图片尺寸(导出PNG),' + imgW + 'x' + imgH + ' px');
    L.push('图片内容像素,' + (b.maxX - b.minX + 1) + 'x' + (b.maxY - b.minY + 1));
    L.push('');
    L.push('颜色,数量,占比');
    for (const [c, n] of sorted) {
      L.push(c + ',' + n + ',' + (n / st.total * 100).toFixed(2) + '%');
    }
    return L.join('\r\n');
  }
  function exportStatsCSV() {
    if (!state.stats) { alert('请先进行统计。'); return; }
    downloadBlob(new Blob([buildStatsCSV()], { type: 'text/csv;charset=utf-8' }), 'stats-' + ts() + '.csv');
  }
  function exportStatsPNGCSV() {
    if (!state.stats) { alert('请先进行统计。'); return; }
    exportStatsCSV();
    exportPNG();
  }

  canvas.addEventListener('pointerdown', function (e) {
    canvas.focus();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 未激活指针（测试等）时忽略 */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button });
    e.preventDefault();

    // 手掌工具 / 框选工具：先命中「框选」区域（整片像素拖动），未命中再走实例逻辑
    const g = screenToGrid(e.clientX, e.clientY);
    if ((state.tool === 'move' || state.tool === 'sel') && e.button === 0 && selMoveStart && selMoveEnd) { // 仅左键：框选区域拖动/重框选（中键/右键不触发）
      const sr = {
        x0: Math.min(selMoveStart.x, selMoveEnd.x), y0: Math.min(selMoveStart.y, selMoveEnd.y),
        x1: Math.max(selMoveStart.x, selMoveEnd.x), y1: Math.max(selMoveStart.y, selMoveEnd.y),
      };
      const inside = g[0] >= sr.x0 && g[0] <= sr.x1 && g[1] >= sr.y0 && g[1] <= sr.y1;
      if (inside) {
        dragSelMove = {
          x0: sr.x0, y0: sr.y0, w: sr.x1 - sr.x0 + 1, h: sr.y1 - sr.y0 + 1,
          dx: g[0] - sr.x0, dy: g[1] - sr.y0, lastX: sr.x0, lastY: sr.y0,
        };
        return;
      }
      if (state.tool === 'sel') {
        // 框外点击：重新框选（替换旧框选）
        selMoveStart = { x: g[0], y: g[1] }; selMoveEnd = { x: g[0], y: g[1] };
        statsShift = e.shiftKey;
        drawState = e.shiftKey ? { stats: true } : { selMove: true };
        requestRender();
        return;
      }
    }
    // 节点系统：鼠标左键点击画布上的实例 → 选中（命中则拦截本次绘制）；仅「移动工具」按住可拖动
    if (e.pointerType === 'mouse' && e.button === 0 && !spaceHeld && typeof trySelectInstance === 'function') {
      if (trySelectInstance(g[0], g[1])) {
        if (state.tool === 'move') {
          const hitInst = state.instances.find(function (it) { return it.id === selInstId; });
          if (hitInst) dragInst = { id: hitInst.id, dx: hitInst.x - g[0], dy: hitInst.y - g[1] };
        }
        return;
      }
    }

    if (pointers.size === 2) {
      drawState = null; panState = null; shapeStart = null; shapeEnd = null;
      statsStart = null; statsEnd = null; nodeSelStart = null; nodeSelEnd = null;
      if (currentStroke) currentStroke = null; // 取消未完成的笔画记录
      const it = pointers.values();
      const p1 = it.next().value, p2 = it.next().value;
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
      pinchState = {
        d0: d, cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2,
        scale0: state.scale, ox: state.offsetX, oy: state.offsetY,
      };
      canvas.classList.add('panning');
      return;
    }

    const p = pointers.get(e.pointerId);
    const isMouse = p.type === 'mouse';
    if (isMouse && p.button === 2) { // 仅右键：拖动画布（中键无功能，左键按工具框选/绘制）
      panState = { startX: p.x, startY: p.y, ox: state.offsetX, oy: state.offsetY };
      canvas.classList.add('panning');
    } else if (isMouse && p.button === 0 && spaceHeld) {
      panState = { startX: p.x, startY: p.y, ox: state.offsetX, oy: state.offsetY };
      canvas.classList.add('panning');
    } else if ((isMouse && p.button === 0) || !isMouse) {
      const g = screenToGrid(p.x, p.y);
      const t = currentStamp();
      const tool = state.tool;
      if ((tool === 'brush' || tool === 'eraser') && t.mode === 'custom' && !t.data) {
        openModal(tool === 'eraser' ? 'eraser' : 'brush');
        return;
      }
      if (tool === 'brush' || tool === 'eraser') {
        beginStroke();
        paintStampAt(g[0], g[1], t);
        drawState = { gx: g[0], gy: g[1], t: t };
        fastMode = true;
        updateUI(); // 绘图时自动隐藏工具栏和提示
      } else if (tool === 'picker') {
        pickColor(g[0], g[1]);
      } else if (tool === 'fill') {
        floodFill(g[0], g[1]);
      } else if (tool === 'rect' || tool === 'circle' || tool === 'triangle' || tool === 'line') {
        shapeStart = { x: g[0], y: g[1] };
        shapeEnd = { x: g[0], y: g[1] };
        drawState = { shape: true };
        fastMode = true;
        updateUI();
      } else if (tool === 'sel') {
        if (e.shiftKey) {
          statsStart = { x: g[0], y: g[1] };
          statsEnd = { x: g[0], y: g[1] };
          statsShift = true;
          drawState = { stats: true };
        } else {
          selMoveStart = { x: g[0], y: g[1] };
          selMoveEnd = { x: g[0], y: g[1] };
          drawState = { selMove: true };
        }
      } else if (tool === 'nodeSelect') {
        nodeSelStart = { x: g[0], y: g[1] };
        nodeSelEnd = { x: g[0], y: g[1] };
        drawState = { nodeSel: true };
      }
      requestRender();
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    state.mouseOnCanvas = true;
    state.mouseX = e.clientX; state.mouseY = e.clientY;
    const g2 = screenToGrid(e.clientX, e.clientY);
    state.mouseGridX = g2[0]; state.mouseGridY = g2[1];
    const p = pointers.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }

    // 手掌拖动「框选移动」区域：整片像素跟随移动（活动图层）
    if (dragSelMove) {
      const g = screenToGrid(e.clientX, e.clientY);
      const nx = g[0] - dragSelMove.dx, ny = g[1] - dragSelMove.dy;
      if (nx !== dragSelMove.lastX || ny !== dragSelMove.lastY) {
        const L = state.layers[state.activeLayer];
        // 标记旧区域脏（分块缓存），否则屏幕仍显示旧缓存块
        markDirtyRect(dragSelMove.x0, dragSelMove.y0, dragSelMove.x0 + dragSelMove.w - 1, dragSelMove.y0 + dragSelMove.h - 1, state.activeLayer);
        const cells = [];
        for (let yy = 0; yy < dragSelMove.h; yy++)
          for (let xx = 0; xx < dragSelMove.w; xx++) {
            const c = L.pixels.get((dragSelMove.x0 + xx) + ',' + (dragSelMove.y0 + yy));
            if (c) cells.push(xx + ',' + yy + ':' + c);
          }
        for (let yy = 0; yy < dragSelMove.h; yy++)
          for (let xx = 0; xx < dragSelMove.w; xx++)
            L.pixels.delete((dragSelMove.x0 + xx) + ',' + (dragSelMove.y0 + yy));
        for (const s of cells) {
          const i = s.indexOf(':'); const k = s.slice(0, i); const c = s.slice(i + 1);
          const j = k.indexOf(','); const xx = +k.slice(0, j), yy = +k.slice(j + 1);
          L.pixels.set((nx + xx) + ',' + (ny + yy), c);
        }
        dragSelMove.x0 = nx; dragSelMove.y0 = ny; dragSelMove.lastX = nx; dragSelMove.lastY = ny;
        selMoveStart = { x: nx, y: ny }; selMoveEnd = { x: nx + dragSelMove.w - 1, y: ny + dragSelMove.h - 1 };
        // 标记新区域脏，分块缓存重建后新位置像素可见
        markDirtyRect(nx, ny, nx + dragSelMove.w - 1, ny + dragSelMove.h - 1, state.activeLayer);
        requestRender();
      }
      return;
    }

    // 拖动已选中的实例（节点系统）：按住实例移动它
    if (dragInst) {
      const g = screenToGrid(e.clientX, e.clientY);
      const it = state.instances.find(function (x) { return x.id === dragInst.id; });
      if (it) { it.x = g[0] + dragInst.dx; it.y = g[1] + dragInst.dy; }
      requestRender();
      return;
    }

    if (pinchState && pointers.size >= 2) {
      const it = pointers.values();
      const p1 = it.next().value, p2 = it.next().value;
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
      const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
      const ns = clamp(pinchState.scale0 * d / pinchState.d0, MIN_SCALE, MAX_SCALE);
      const wx = (pinchState.cx - pinchState.ox) / pinchState.scale0;
      const wy = (pinchState.cy - pinchState.oy) / pinchState.scale0;
      state.scale = ns;
      state.offsetX = cx - wx * ns;
      state.offsetY = cy - wy * ns;
      updateZoomLabel();
      requestRender();
    } else if (panState) {
      state.offsetX = panState.ox + (e.clientX - panState.startX);
      state.offsetY = panState.oy + (e.clientY - panState.startY);
      requestRender();
    } else if (drawState && pointers.size === 1) {
      const g = screenToGrid(e.clientX, e.clientY);
      if (drawState.shape) {
        shapeEnd = { x: g[0], y: g[1] };
        requestRender();
      } else if (drawState.stats) {
        statsEnd = { x: g[0], y: g[1] };
        requestRender();
      } else if (drawState.nodeSel) {
        nodeSelEnd = { x: g[0], y: g[1] };
        requestRender();
      } else if (drawState.selMove) {
        selMoveEnd = { x: g[0], y: g[1] };
        requestRender();
      } else if (g[0] !== drawState.gx || g[1] !== drawState.gy) {
        linePaint(drawState.gx, drawState.gy, g[0], g[1], drawState.t);
        drawState.gx = g[0]; drawState.gy = g[1];
        requestRender();
      }
    } else {
      requestRender(); // 更新笔刷预览
    }
    updateColorInfo();
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchState = null;
    if (pointers.size === 0) {
      panState = null;
      dragInst = null; // 实例拖动结束
      dragSelMove = null; // 框选像素拖动结束
      if (typeof renderNodePanel === 'function') renderNodePanel(); // 同步实例列表位置
      if (drawState) {
        if (drawState.shape) commitShape();
        else if (drawState.stats) computeStats();
        else if (drawState.nodeSel) commitNodeSelect();
        else if (drawState.selMove) { openSelectPanel(); }
        else endStroke();
        drawState = null;
      } else if (selMoveStart && selMoveEnd) {
        openSelectPanel(); // 框选内容拖动结束 → 刷新控制栏
      }
      shapeStart = null; shapeEnd = null;
      statsStart = null; statsEnd = null;
      nodeSelStart = null; nodeSelEnd = null;
      canvas.classList.remove('panning');
      if (fastMode) { fastMode = false; updateUI(); updateColorInfo(); requestRender(); } // 松手恢复 UI
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('pointerleave', function () {
    state.mouseOnCanvas = false;
    updateColorInfo();
    requestRender();
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { spaceHeld = true; e.preventDefault(); canvas.classList.add('space'); }
    // 撤销 / 重做（不受弹窗影响，但弹窗中避免误触输入框）
    const tag = (e.target && e.target.tagName) || '';
    // 节点编辑器打开时，Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y 交给节点画布的撤销/重做，不碰像素撤销
    if (window.__nodeEditorOpen) return;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
    }
    if (els.modalMask.classList.contains('open') || els.settingsMask.classList.contains('open')) return; // 弹窗打开时不响应
    if (e.code === 'KeyE' && e.target === canvas) setTool('eraser');
    if (e.code === 'KeyB' && e.target === canvas) setTool('brush');
    if (e.code === 'KeyH' && e.target === canvas) toggleHideUI();
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { spaceHeld = false; canvas.classList.remove('space'); }
  });
  canvas.addEventListener('blur', function () {
    spaceHeld = false;
    canvas.classList.remove('space');
    if (fastMode) { fastMode = false; updateUI(); updateColorInfo(); requestRender(); }
  });

  // ---------- 工具栏 ----------
  // 画笔/橡皮右键控制栏：笔刷、橡皮、颜色设置
  els.rToolBrush.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const r = els.rToolBrush.getBoundingClientRect();
    const p = els.brushPanel;
    p.style.display = 'block';
    p.style.left = Math.max(4, r.left - p.offsetWidth - 8) + 'px';
    p.style.top = r.top + 'px';
    syncModeUI(); syncSizeUI(); syncColorInputs();
  });
  els.bpBrushMode.addEventListener('change', function () { setBrushMode(els.bpBrushMode.value); });
  els.bpEraserMode.addEventListener('change', function () { setEraserMode(els.bpEraserMode.value); });
  els.bpBrushSize.addEventListener('input', function () {
    state.brushSize = +els.bpBrushSize.value;
    syncSizeUI();
    requestRender();
  });
  els.bpEraserSize.addEventListener('input', function () {
    state.eraserSize = +els.bpEraserSize.value;
    syncSizeUI();
    requestRender();
  });
  els.bpColor.addEventListener('input', function () {
    state.color = els.bpColor.value;
    syncColorInputs();
  });
  // 点击面板外 / 滚轮 → 关闭控制栏
  document.addEventListener('click', function (e) {
    if (els.brushPanel && els.brushPanel.style.display === 'block' && !els.brushPanel.contains(e.target) && e.target !== els.rToolBrush) {
      els.brushPanel.style.display = 'none';
    }
  });
  document.addEventListener('wheel', function () {
    if (els.brushPanel) els.brushPanel.style.display = 'none';
  });

  // 手动隐藏 / 显示界面（工具栏按钮 + 设置面板按钮 + 恢复按钮）
  els.btnHideUI.addEventListener('click', toggleHideUI);
  els.settingsHideUI.addEventListener('click', toggleHideUI);
  els.btnRestoreUI.addEventListener('click', function () {
    if (state.uiHidden) toggleHideUI();
  });

  // 撤销 / 重做
  els.btnUndo.addEventListener('click', undo);
  els.btnRedo.addEventListener('click', redo);
  els.settingsUndo.addEventListener('click', undo);
  els.settingsRedo.addEventListener('click', redo);


  // 统计面板
  els.btnCloseSelect.addEventListener('click', function () { els.selectPanel.classList.remove('open'); });
  els.btnSelClear.addEventListener('click', clearSel);
  els.btnSelScale.addEventListener('click', applySelScale);
  els.btnSelRotate.addEventListener('click', applySelRotate);
  els.btnSelStats.addEventListener('click', doSelStats);
  els.btnStatsCsv.addEventListener('click', exportStatsCSV);
  els.btnStatsPngCsv.addEventListener('click', exportStatsPNGCSV);

  // 设置面板开关
  els.btnSettings.addEventListener('click', function () {
    els.settingsMask.classList.add('open');
  });
  els.btnCloseSettings.addEventListener('click', function () {
    els.settingsMask.classList.remove('open');
  });
  els.settingsMask.addEventListener('click', function (e) {
    if (e.target === els.settingsMask) els.settingsMask.classList.remove('open');
  });

  // 设置面板：工具（下拉选择全部工具）
  els.settingsTool.addEventListener('change', function () { setTool(els.settingsTool.value); });
  // 设置面板：撤销步数
  els.settingsUndoSteps.addEventListener('input', function () {
    state.maxUndoSteps = +els.settingsUndoSteps.value;
    els.settingsUndoStepsVal.textContent = state.maxUndoSteps;
    while (undoStack.length > state.maxUndoSteps) undoStack.shift();
    updateUndoUI();
  });
  // 设置面板：笔刷 / 橡皮模式
  els.settingsBrushMode.addEventListener('change', function () { setBrushMode(els.settingsBrushMode.value); });
  els.settingsEraserMode.addEventListener('change', function () { setEraserMode(els.settingsEraserMode.value); });
  // 设置面板：大小
  els.settingsBrushSize.addEventListener('input', function () {
    state.brushSize = +els.settingsBrushSize.value;
    syncSizeUI();
    requestRender();
  });
  els.settingsEraserSize.addEventListener('input', function () {
    state.eraserSize = +els.settingsEraserSize.value;
    syncSizeUI();
    requestRender();
  });
  // 设置面板：颜色
  els.settingsColor.addEventListener('input', function () {
    state.color = els.settingsColor.value;
    syncColorInputs();
  });
  // 设置面板：自定义笔刷 / 橡皮画板入口
  els.settingsEditBrush.addEventListener('click', function () { openModal('brush'); });
  els.settingsEditEraser.addEventListener('click', function () { openModal('eraser'); });

  // 颜色代码开关（设置面板中）：开启后鼠标所在格子出现红色选择网格，浮层显示颜色代码与坐标
  function toggleColorInfo() {
    state.showColorInfo = !state.showColorInfo;
    els.settingsColorInfo.classList.toggle('active', state.showColorInfo);
    updateColorInfo();
    requestRender();
  }
  els.settingsColorInfo.addEventListener('click', toggleColorInfo);

  // 网格线开关与网格大小（设置面板）
  els.settingsGrid.addEventListener('click', function () {
    state.showGrid = !state.showGrid;
    els.settingsGrid.classList.toggle('active', state.showGrid);
    requestRender();
  });
  els.settingsAxis.addEventListener('click', function () {
    state.showAxis = !state.showAxis;
    els.settingsAxis.classList.toggle('active', state.showAxis);
    requestRender();
  });
  els.settingsGridStep.addEventListener('change', function () {
    const v = els.settingsGridStep.value;
    state.gridStep = v === 'auto' ? 'auto' : +v;
    requestRender();
  });

  // 工程压缩等级（设置面板）：0=不压缩 · 1~3 紧凑格式 · 4~7 deflate · 8~10 gzip
  els.settingsCompressLevel.addEventListener('input', function () {
    state.compressLevel = +els.settingsCompressLevel.value;
    els.settingsCompressLevelVal.textContent = state.compressLevel;
  });
  // 工程导出格式（设置面板）：v3 紧凑 / v2 旧版兼容
  function updateExportFormatUI() {
    // v2 旧版兼容格式不支持压缩，隐藏压缩等级控件
    els.compressField.style.display = state.exportFormat === 'v3' ? '' : 'none';
  }
  els.settingsExportFormat.addEventListener('change', function () {
    state.exportFormat = els.settingsExportFormat.value;
    updateExportFormatUI();
  });

  els.btnReset.addEventListener('click', function () {
    state.scale = 1;
    state.offsetX = cssW() / 2;
    state.offsetY = cssH() / 2;
    updateZoomLabel();
    requestRender();
  });

  els.btnClear.addEventListener('click', function () {
    if (!hasContent() && state.instances.length === 0) return;
    if (confirm('确定要清空所有图层的像素与矢量对象吗？\n（画布上的实例也会一并清除）')) {
      for (const L of state.layers) { L.pixels.clear(); L.shapes.length = 0; }
      for (let i = 0; i < layerChunks.length; i++) {
        if (layerChunks[i]) { layerChunks[i].map.clear(); layerChunks[i].dirty.clear(); }
      }
      state.instances.length = 0; // 同时清空画布上的实例
      selInstId = -1;
      if (typeof renderNodePanel === 'function') renderNodePanel(); // 刷新节点编辑器实例列表
      clearHistory(); // 清空操作不可撤销
      requestRender();
    }
  });


  // ---------- 自定义笔刷画板 ----------
  const modal = {
    n: 16, tool: 'paint', pixels: new Map(),
    drawing: false, last: null,
    shapeStart: null, shapeEnd: null,   // 图形工具起止（画板格子坐标）
  };
  const MODAL_DISPLAY = 640; // 画板 canvas 显示尺寸（CSS px），128×128 时每格 5px
  const MODAL_UNDO_MAX = 16; // 画板撤销 / 重做步数上限
  const modalUndoStack = [], modalRedoStack = [];
  let modalStroke = null;    // 当前画板操作的修改记录

  function modalBeginStroke() { modalStroke = new Map(); }
  function modalRecordCell(key, newVal) {
    const old = modal.pixels.get(key);
    if (old === newVal) return;
    if (modalStroke) {
      const rec = modalStroke.get(key);
      if (rec) rec[2] = newVal;
      else modalStroke.set(key, [key, old, newVal]);
    }
    if (newVal === null || newVal === undefined) modal.pixels.delete(key);
    else modal.pixels.set(key, newVal);
  }
  function modalEndStroke() {
    if (modalStroke && modalStroke.size > 0) {
      modalUndoStack.push(Array.from(modalStroke.values()));
      if (modalUndoStack.length > MODAL_UNDO_MAX) modalUndoStack.shift();
      modalRedoStack.length = 0;
      updateModalUndoUI();
    }
    modalStroke = null;
  }
  function modalApplyDiff(diff, useNew) {
    for (const rec of diff) {
      const v = useNew ? rec[2] : rec[1];
      if (v === null || v === undefined) modal.pixels.delete(rec[0]);
      else modal.pixels.set(rec[0], v);
    }
    renderModal();
  }
  function modalUndo() {
    const diff = modalUndoStack.pop();
    if (!diff) return;
    modalApplyDiff(diff, false);
    modalRedoStack.push(diff);
    updateModalUndoUI();
  }
  function modalRedo() {
    const diff = modalRedoStack.pop();
    if (!diff) return;
    modalApplyDiff(diff, true);
    modalUndoStack.push(diff);
    if (modalUndoStack.length > MODAL_UNDO_MAX) modalUndoStack.shift();
    updateModalUndoUI();
  }
  function updateModalUndoUI() {
    els.modalUndoBtn.classList.toggle('disabled', modalUndoStack.length === 0);
    els.modalRedoBtn.classList.toggle('disabled', modalRedoStack.length === 0);
  }

  function openModal(target) {
    modalEditing = target;
    const curBrush0 = target === 'eraser' ? customEraser : customBrush;
    els.modalTitle.textContent = (target === 'eraser' ? '自定义橡皮' : '自定义笔刷') + (curBrush0 && curBrush0.name ? '：' + curBrush0.name : '（图案 = ' + (target === 'eraser' ? '擦除形状' : '绘制形状') + '）');
    const src = target === 'eraser' ? customEraser : customBrush;
    if (src) {
      modal.n = src.w;
      modal.pixels = new Map(src.pixels);
      els.modalSizeSelect.value = String(modal.n);
    } else {
      modal.n = 16;
      modal.pixels = new Map();
      els.modalSizeSelect.value = '16';
    }
    modal.tool = 'paint';
    modal.shapeStart = null; modal.shapeEnd = null;
    modalUndoStack.length = 0; modalRedoStack.length = 0; modalStroke = null;
    setModalTool('paint');
    resizeModalCanvas();
    renderModal();
    updateModalUndoUI();
    els.modalMask.classList.add('open');
  }
  function closeModal() { els.modalMask.classList.remove('open'); }

  function setModalTool(t) {
    modal.tool = t;
    els.modalBtnPaint.classList.toggle('active', t === 'paint');
    els.modalBtnErase.classList.toggle('active', t === 'erase');
    els.modalToolLine.classList.toggle('active', t === 'line');
    els.modalToolRect.classList.toggle('active', t === 'rect');
    els.modalToolCircle.classList.toggle('active', t === 'circle');
    els.modalToolTriangle.classList.toggle('active', t === 'triangle');
  }

  function resizeModalCanvas() {
    const p = dpr();
    // 同步 CSS 尺寸与内部缓冲，保证 getBoundingClientRect 与实际绘制坐标完全一致
    els.modalCanvas.style.width = MODAL_DISPLAY + 'px';
    els.modalCanvas.style.height = MODAL_DISPLAY + 'px';
    els.modalCanvas.width = Math.round(MODAL_DISPLAY * p);
    els.modalCanvas.height = Math.round(MODAL_DISPLAY * p);
  }
  function modalCellPx() { return MODAL_DISPLAY / modal.n; }

  function modalPaintAt(gx, gy) {
    if (modal.tool === 'paint') modalRecordCell(gx + ',' + gy, els.modalColor.value);
    else modalRecordCell(gx + ',' + gy, null);
  }
  function modalLine(x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      modalPaintAt(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }
  function modalLineBresenham(x0, y0, x1, y1, cb) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      cb(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  // 画板三角形顶点：按拖动方向区分正 / 倒三角
  function modalTrianglePoints(s0, s1) {
    const x0 = Math.min(s0.x, s1.x), x1 = Math.max(s0.x, s1.x);
    const y0 = Math.min(s0.y, s1.y), y1 = Math.max(s0.y, s1.y);
    const midX = (x0 + x1) / 2;
    if (s1.y >= s0.y) return [[midX, y0], [x0, y1], [x1, y1]]; // 向下拖：正三角
    return [[midX, y1], [x0, y0], [x1, y0]];                  // 向上拖：倒三角
  }

  // 画板图形工具落笔（仅轮廓，1 格粗细）
  function commitModalShape() {
    const s0 = modal.shapeStart, s1 = modal.shapeEnd;
    if (!s0 || !s1) return;
    const x0 = Math.min(s0.x, s1.x), x1 = Math.max(s0.x, s1.x);
    const y0 = Math.min(s0.y, s1.y), y1 = Math.max(s0.y, s1.y);
    modalBeginStroke();
    const color = els.modalColor.value;
    const p = function (x, y) { modalRecordCell(x + ',' + y, color); };
    if (modal.tool === 'rect') {
      for (let x = x0; x <= x1; x++) { p(x, y0); p(x, y1); }
      for (let y = y0; y <= y1; y++) { p(x0, y); p(x1, y); }
    } else if (modal.tool === 'circle') {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const rx = Math.max(0.5, (x1 - x0 + 1) / 2), ry = Math.max(0.5, (y1 - y0 + 1) / 2);
      const inC = function (x, y) { const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry; return dx * dx + dy * dy <= 1; };
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          if (inC(x, y) && (!inC(x - 1, y) || !inC(x + 1, y) || !inC(x, y - 1) || !inC(x, y + 1))) p(x, y);
        }
    } else if (modal.tool === 'triangle') {
      const pts = modalTrianglePoints(s0, s1);
      modalLineBresenham(pts[0][0], pts[0][1], pts[1][0], pts[1][1], p);
      modalLineBresenham(pts[1][0], pts[1][1], pts[2][0], pts[2][1], p);
      modalLineBresenham(pts[2][0], pts[2][1], pts[0][0], pts[0][1], p);
    } else if (modal.tool === 'line') {
      modalLineBresenham(s0.x, s0.y, s1.x, s1.y, p);
    }
    modalEndStroke();
    renderModal();
  }

  function renderModal() {
    const p = dpr(), cell = modalCellPx();
    mctx.setTransform(p * cell, 0, 0, p * cell, 0, 0);
    mctx.fillStyle = '#ffffff';
    mctx.fillRect(0, 0, modal.n, modal.n);
    for (const [key, c] of modal.pixels) {
      const i = key.indexOf(',');
      mctx.fillStyle = c;
      mctx.fillRect(+key.slice(0, i), +key.slice(i + 1), 1, 1);
    }
    // 网格线
    mctx.setTransform(p, 0, 0, p, 0, 0);
    mctx.strokeStyle = 'rgba(0,0,0,.18)';
    mctx.lineWidth = 1;
    mctx.beginPath();
    for (let k = 1; k < modal.n; k++) {
      const pos = Math.round(k * cell) + 0.5;
      mctx.moveTo(pos, 0); mctx.lineTo(pos, MODAL_DISPLAY);
      mctx.moveTo(0, pos); mctx.lineTo(MODAL_DISPLAY, pos);
    }
    mctx.stroke();
    drawModalShapePreview(p, cell);
  }

  // 画板图形工具拖动预览
  function drawModalShapePreview(p, cell) {
    if (!modal.shapeStart || !modal.shapeEnd) return;
    const t = modal.tool;
    if (t !== 'line' && t !== 'rect' && t !== 'circle' && t !== 'triangle') return;
    const s0 = modal.shapeStart, s1 = modal.shapeEnd;
    const X = function (gx) { return gx * cell; };
    const Y = function (gy) { return gy * cell; };
    mctx.setTransform(p, 0, 0, p, 0, 0);
    mctx.strokeStyle = 'rgba(30, 120, 255, .9)';
    mctx.lineWidth = 2;
    mctx.beginPath();
    if (t === 'rect') {
      mctx.rect(X(s0.x), Y(s0.y), (s1.x - s0.x + 1) * cell, (s1.y - s0.y + 1) * cell);
    } else if (t === 'circle') {
      const cx = (X(s0.x) + X(s1.x)) / 2, cy = (Y(s0.y) + Y(s1.y)) / 2;
      const rx = Math.abs(X(s1.x) - X(s0.x)) / 2 + cell / 2;
      const ry = Math.abs(Y(s1.y) - Y(s0.y)) / 2 + cell / 2;
      mctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    } else if (t === 'triangle') {
      const pts = modalTrianglePoints(s0, s1);
      mctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
      mctx.lineTo(X(pts[1][0]), Y(pts[1][1]));
      mctx.lineTo(X(pts[2][0]), Y(pts[2][1]));
      mctx.closePath();
    } else if (t === 'line') {
      mctx.moveTo(X(s0.x) + cell / 2, Y(s0.y) + cell / 2);
      mctx.lineTo(X(s1.x) + cell / 2, Y(s1.y) + cell / 2);
    }
    mctx.stroke();
  }

  els.modalCanvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    els.modalCanvas.setPointerCapture(e.pointerId);
    const rect = els.modalCanvas.getBoundingClientRect();
    const cell = rect.width / modal.n; // 以实际显示尺寸为准，与网格严格对齐
    const gx = Math.floor((e.clientX - rect.left) / cell);
    const gy = Math.floor((e.clientY - rect.top) / cell);
    if (gx < 0 || gx >= modal.n || gy < 0 || gy >= modal.n) return;
    modal.drawing = true;
    if (modal.tool === 'line' || modal.tool === 'rect' || modal.tool === 'circle' || modal.tool === 'triangle') {
      modal.shapeStart = { x: gx, y: gy };
      modal.shapeEnd = { x: gx, y: gy };
    } else {
      modalBeginStroke();
      modalPaintAt(gx, gy);
      modal.last = [gx, gy];
    }
    renderModal();
  });
  els.modalCanvas.addEventListener('pointermove', function (e) {
    if (!modal.drawing) return;
    const rect = els.modalCanvas.getBoundingClientRect();
    const cell = rect.width / modal.n;
    const gx = Math.floor((e.clientX - rect.left) / cell);
    const gy = Math.floor((e.clientY - rect.top) / cell);
    if (gx < 0 || gx >= modal.n || gy < 0 || gy >= modal.n) return;
    if (modal.shapeStart) {
      modal.shapeEnd = { x: gx, y: gy };
      renderModal();
    } else if (gx !== modal.last[0] || gy !== modal.last[1]) {
      modalLine(modal.last[0], modal.last[1], gx, gy);
      modal.last = [gx, gy];
      renderModal();
    }
  });
  function modalEndPointer() {
    modal.drawing = false;
    if (modal.shapeStart) {
      commitModalShape();
      modal.shapeStart = null; modal.shapeEnd = null;
    } else {
      modalEndStroke();
    }
  }
  els.modalCanvas.addEventListener('pointerup', modalEndPointer);
  els.modalCanvas.addEventListener('pointercancel', modalEndPointer);
  els.modalCanvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  els.modalBtnPaint.addEventListener('click', function () { setModalTool('paint'); });
  els.modalBtnErase.addEventListener('click', function () { setModalTool('erase'); });
  els.modalToolLine.addEventListener('click', function () { setModalTool('line'); });
  els.modalToolRect.addEventListener('click', function () { setModalTool('rect'); });
  els.modalToolCircle.addEventListener('click', function () { setModalTool('circle'); });
  els.modalToolTriangle.addEventListener('click', function () { setModalTool('triangle'); });
  els.modalUndoBtn.addEventListener('click', modalUndo);
  els.modalRedoBtn.addEventListener('click', modalRedo);
  // 画板右侧工具栏可隐藏 / 展开
  let modalSideHidden = false;
  els.modalHideTools.addEventListener('click', function () {
    modalSideHidden = !modalSideHidden;
    const tools = els.modalSideTools.querySelectorAll('.tool-btn:not(#modalHideTools)');
    for (const b of tools) b.style.display = modalSideHidden ? 'none' : '';
    els.modalHideTools.textContent = modalSideHidden ? '«' : '»';
  });

  els.modalSizeSelect.addEventListener('change', function () {
    modal.n = +els.modalSizeSelect.value;
    modal.pixels = new Map();
    renderModal();
  });

  els.modalBtnClear.addEventListener('click', function () {
    modal.pixels = new Map();
    renderModal();
  });

  // ---------- 笔刷库（localStorage 持久化） ----------
  const BRUSH_LIB_KEY = 'grid-brush-library';
  function loadBrushLib() {
    try { return JSON.parse(localStorage.getItem(BRUSH_LIB_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveBrushLib(arr) {
    try { localStorage.setItem(BRUSH_LIB_KEY, JSON.stringify(arr)); } catch (e) { /* 存储满时忽略 */ }
  }
  function brushToStore(obj, kind) {
    return {
      kind: kind || 'brush', name: obj.name || '笔刷', w: obj.w, h: obj.h,
      pixels: Array.from(obj.pixels, function (kv) {
        const i = kv[0].indexOf(',');
        return [+kv[0].slice(0, i), +kv[0].slice(i + 1), kv[1]];
      }),
      time: Date.now(),
    };
  }
  function brushFromStore(s) {
    const px = new Map();
    for (const it of (s.pixels || [])) px.set(it[0] + ',' + it[1], it[2]);
    return { name: s.name, w: s.w, h: s.h, pixels: px };
  }
  function addToBrushLib(obj, kind) {
    const arr = loadBrushLib();
    const st = brushToStore(obj, kind);
    arr.unshift(st);
    if (arr.length > 200) arr.length = 200;
    saveBrushLib(arr);
    renderBrushLib();
    return st; // 返回 store（含 time），用于把当前笔刷与库项关联
  }
  // 设置面板下拉「自定义笔刷/自定义橡皮」选项文字 = 当前自定义笔刷的名字
  function updateCustomBrushLabels() {
    const sel = els.settingsBrushMode;
    if (sel) {
      const opt = sel.querySelector('option[value=\"custom\"]');
      if (opt) opt.textContent = customBrush ? (customBrush.name || '自定义笔刷') : '自定义笔刷';
    }
    const selE = els.settingsEraserMode;
    if (selE) {
      const optE = selE.querySelector('option[value=\"custom\"]');
      if (optE) optE.textContent = customEraser ? (customEraser.name || '自定义橡皮') : '自定义橡皮';
    }
  }
  function renderBrushLib() {
    const list = els.brushLibraryList;
    if (!list) return;
    const kind = modalEditing || 'brush';
    const isEr = kind === 'eraser';
    // 标题按画板类型区分（橡皮画板显示橡皮库，画笔画板显示笔刷库）
    const head = document.querySelector('#brushLibrary .bl-head span');
    if (head) {
      head.childNodes[0].textContent = isEr ? '📚 橡皮库 ' : '📚 笔刷库 ';
    }
    const arr = loadBrushLib().filter(function (x) { return (x.kind || 'brush') === kind; });
    list.innerHTML = '';
    if (!arr.length) {
      list.innerHTML = '<div class="bl-empty">暂无' + (isEr ? '橡皮' : '笔刷') + '：保存或导入后自动出现在这里</div>';
      return;
    }
    for (const s of arr) {
      const item = document.createElement('div');
      item.className = 'bl-item';
      item.title = '点击设为当前笔刷';
      const t = new Date(s.time || Date.now());
      const nm = document.createElement('span');
      nm.className = 'bl-name';
      nm.textContent = s.name || '笔刷';
      const meta = document.createElement('span');
      meta.className = 'bl-meta';
      meta.textContent = s.w + '×' + s.h + ' · ' + t.toLocaleDateString();
      // 右上角删除按钮
      const del = document.createElement('span');
      del.className = 'bl-del';
      del.textContent = '×';
      del.title = '删除该笔刷';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        const cur = loadBrushLib();
        // indexOf 引用比较会失败（重新解析是新对象），用 time+name 匹配
        const idx = cur.findIndex(function (x) { return x.time === s.time && x.name === s.name && x.w === s.w && x.h === s.h; });
        if (idx >= 0) cur.splice(idx, 1);
        saveBrushLib(cur);
        renderBrushLib();
      });
      item.appendChild(del);
      item.appendChild(nm);
      item.appendChild(meta);
      // 右键重命名
      item.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const nn = prompt('重命名笔刷「' + (s.name || '') + '」：', s.name || '');
        if (nn === null || nn.trim() === '') return;
        const cur = loadBrushLib();
        const idx = cur.findIndex(function (x) { return x.time === s.time && x.name === s.name && x.w === s.w && x.h === s.h; });
        if (idx >= 0) {
          cur[idx].name = nn.trim(); saveBrushLib(cur); renderBrushLib();
          // 若重命名的就是当前自定义笔刷，同步名称与设置面板标签
          if (customBrush && customBrush.__libTime === s.time) customBrush.name = nn.trim();
          if (customEraser && customEraser.__libTime === s.time) customEraser.name = nn.trim();
          updateCustomBrushLabels();
        }
      });
      item.addEventListener('click', function () {
        const obj = brushFromStore(s);
        if (s.kind === 'eraser') { customEraser = obj; setEraserMode('custom'); }
        else { customBrush = obj; setBrushMode('custom'); }
        if (s.kind === 'eraser') customEraser.__libTime = s.time; else customBrush.__libTime = s.time;
        updateCustomBrushLabels();
        els.modalTitle.textContent = (s.kind === 'eraser' ? '自定义橡皮' : '自定义笔刷') + '：' + (s.name || '');
        // 同时载入画板，便于继续编辑
        modal.n = obj.w;
        modal.pixels = new Map(obj.pixels);
        els.modalSizeSelect.value = String(obj.w);
        resizeModalCanvas();
        renderModal();
        requestRender();
        alert('已设为当前' + (s.kind === 'eraser' ? '橡皮' : '笔刷') + '：' + (s.name || ''));
      });
      list.appendChild(item);
    }
  }
  els.modalBtnLibrary.addEventListener('click', function () {
    const lib = els.brushLibrary;
    lib.style.display = lib.style.display === 'none' ? 'block' : 'none';
    if (lib.style.display === 'block') renderBrushLib();
  });
  const blClose = document.querySelector('#brushLibrary .bl-close');
  if (blClose) blClose.addEventListener('click', function () {
    els.brushLibrary.style.display = 'none';
  });

  els.modalBtnSave.addEventListener('click', function () {
    const isEr = modalEditing === 'eraser';
    const curBrush = isEr ? customEraser : customBrush;
    // 从笔刷库加载过的笔刷：询问覆盖 or 另存为新笔刷
    if (curBrush && curBrush.__libTime) {
      const over = confirm('已从笔刷库加载「' + (curBrush.name || '') + '」：\n确定 = 覆盖此笔刷\n取消 = 另存为新笔刷');
      if (over) {
        // 覆盖：更新库中该条目（保持名称）
        const cur = loadBrushLib();
        const idx = cur.findIndex(function (x) { return x.time === curBrush.__libTime; });
        if (idx >= 0) {
          cur[idx].w = modal.n; cur[idx].h = modal.n;
          cur[idx].pixels = Array.from(modal.pixels, function (kv) { const i = kv[0].indexOf(','); return [+kv[0].slice(0, i), +kv[0].slice(i + 1), kv[1]]; });
          saveBrushLib(cur); renderBrushLib();
        }
        const obj = { name: curBrush.name || '自定义笔刷', w: modal.n, h: modal.n, pixels: new Map(modal.pixels), __libTime: curBrush.__libTime };
        if (isEr) { customEraser = obj; setEraserMode('custom'); }
        else { customBrush = obj; setBrushMode('custom'); }
        updateCustomBrushLabels();
        requestRender();
        alert('已覆盖笔刷「' + obj.name + '」（画板保持打开）。');
        return;
      }
      // 另存为新笔刷：输入名称
      const nn = prompt('保存为新笔刷，输入名称：', (curBrush.name || '笔刷') + ' 副本');
      if (nn === null || nn.trim() === '') { alert('已取消保存。'); return; }
      const obj2 = { name: nn.trim(), w: modal.n, h: modal.n, pixels: new Map(modal.pixels) };
      if (isEr) { customEraser = obj2; setEraserMode('custom'); }
      else { customBrush = obj2; setBrushMode('custom'); }
      const libSt2 = addToBrushLib(obj2, modalEditing);
      if (isEr) customEraser.__libTime = libSt2.time; else customBrush.__libTime = libSt2.time;
      updateCustomBrushLabels();
      requestRender();
      alert('已保存为新笔刷「' + obj2.name + '」（画板保持打开）。');
      return;
    }
    // 新笔刷：直接保存并入库
    const obj = { name: isEr ? '自定义橡皮' : '自定义笔刷', w: modal.n, h: modal.n, pixels: new Map(modal.pixels) };
    if (isEr) { customEraser = obj; setEraserMode('custom'); }
    else { customBrush = obj; setBrushMode('custom'); }
    const libSt = addToBrushLib(obj, modalEditing); // 保存的笔刷自动入库
    if (isEr) { if (customEraser) customEraser.__libTime = libSt.time; }
    else { if (customBrush) customBrush.__libTime = libSt.time; }
    updateCustomBrushLabels();
    requestRender();
    alert('已保存为当前' + (isEr ? '橡皮（画板保持打开，可继续绘制）。' : '笔刷（画板保持打开，可继续绘制）。'));
  });

  els.btnCloseModal.addEventListener('click', closeModal);
  els.modalMask.addEventListener('click', function (e) { if (e.target === els.modalMask) closeModal(); });

  function modalBrushToJSON(obj) {
    return {
      app: 'grid-brush', version: 1, name: obj.name, w: obj.w, h: obj.h,
      pixels: Array.from(obj.pixels, function (kv) {
        const i = kv[0].indexOf(',');
        return [+kv[0].slice(0, i), +kv[0].slice(i + 1), kv[1]];
      }),
    };
  }
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function ts() {
    const d = new Date();
    function p2(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' +
           p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }

  els.modalBtnExport.addEventListener('click', function () {
    const obj = { name: modalEditing === 'eraser' ? '自定义橡皮' : '自定义笔刷', w: modal.n, h: modal.n, pixels: new Map(modal.pixels) };
    const blob = new Blob([JSON.stringify(modalBrushToJSON(obj))], { type: 'application/json' });
    downloadBlob(blob, (modalEditing === 'eraser' ? 'eraser-' : 'brush-') + ts() + '.json');
  });

  els.modalBtnImport.addEventListener('click', function () { els.modalFileInput.click(); });
  els.modalFileInput.addEventListener('change', function () {
    const f = els.modalFileInput.files && els.modalFileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const d = JSON.parse(reader.result);
        if (!d || d.app !== 'grid-brush' || d.version !== 1 || !Array.isArray(d.pixels)) throw new Error('不是有效的笔刷文件');
        const w = Math.round(+d.w) || 16, h = Math.round(+d.h) || 16;
        if (w < 1 || w > 128 || h < 1 || h > 128) throw new Error('笔刷尺寸非法');
        const px = new Map();
        for (const it of d.pixels) {
          if (!Array.isArray(it) || it.length < 3) continue;
          const x = Math.round(+it[0]), y = Math.round(+it[1]);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          px.set(x + ',' + y, String(it[2]));
        }
        modal.n = w;
        modal.pixels = px;
        els.modalSizeSelect.value = String(w);
        resizeModalCanvas();
        renderModal();
        addToBrushLib({ name: d.name || '导入笔刷', w: w, h: h, pixels: px }, modalEditing); // 导入的笔刷自动入库
        alert('笔刷已载入画板，点击「保存」生效。');
      } catch (err) { alert('导入笔刷失败：' + err.message); }
    };
    reader.readAsText(f);
    els.modalFileInput.value = '';
  });

  // ---------- 导出 / 导入工程 ----------
  // 内容辅助：所有可见图层中是否有内容

  // ---------- 工程压缩 / 解压（CompressionStream） ----------
  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function deflateText(text, alg) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream(alg));
    const buf = await new Response(stream).arrayBuffer();
    return bytesToBase64(new Uint8Array(buf));
  }
  async function inflateText(b64, alg) {
    const stream = new Blob([base64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream(alg));
    return await new Response(stream).text();
  }

  // 构建 v3 数据：调色板 + 按行 RLE（rows = [y, [[x1,x2,palIdx],...]]），大幅减小体积
  // pixels 参数缺省时使用所有可见图层的合并像素
  function mergedVisiblePixels() {
    const map = new Map();
    for (const L of state.layers) {
      if (!L.visible) continue;
      for (const [k, v] of L.pixels) map.set(k, v);
    }
    return map;
  }
  function buildProjectData(pixels) {
    if (pixels === undefined) pixels = mergedVisiblePixels();
    const byY = new Map();
    for (const [key, color] of pixels) {
      const i = key.indexOf(',');
      const x = +key.slice(0, i), y = +key.slice(i + 1);
      let arr = byY.get(y);
      if (!arr) { arr = []; byY.set(y, arr); }
      arr.push([x, color]);
    }
    const palIdx = new Map();
    const pal = [];
    const idxOf = function (c) {
      let i = palIdx.get(c);
      if (i === undefined) { i = pal.length; palIdx.set(c, i); pal.push(c); }
      return i;
    };
    const rows = [];
    for (const [y, arr] of byY) {
      arr.sort(function (a, b) { return a[0] - b[0]; });
      const segs = [];
      let sx = arr[0][0], px = sx, pc = arr[0][1];
      for (let k = 1; k < arr.length; k++) {
        const x = arr[k][0], c = arr[k][1];
        if (c === pc && x === px + 1) { px = x; continue; }
        segs.push([sx, px, idxOf(pc)]);
        sx = x; px = x; pc = c;
      }
      segs.push([sx, px, idxOf(pc)]);
      rows.push([y, segs]);
    }
    rows.sort(function (a, b) { return a[0] - b[0]; });
    return { pal: pal, rows: rows };
  }

  // 导出工程：v3 紧凑格式（调色板 + RLE，类似 pig2.json，可选压缩）
  // 或 v2 旧版兼容格式（pixels 明文数组，类似 pig.json），由设置面板「导出格式」决定
  async function exportProject() {
    if (!hasContent()) {
      alert('画布是空的，没有内容可导出。'); return;
    }
    const tag = state.exportFormat === 'v2' ? 'v2' : 'v3';
    const name = 'pixel-project-' + ts() + '-' + tag + '.json';

    // v2 旧版兼容格式：[[x, y, color], ...] 明文数组（矢量对象与图层附加字段，旧版忽略）
    if (state.exportFormat === 'v2') {
      const merged = mergedVisiblePixels();
      if (merged.size > 500000) {
        if (!confirm('当前内容较大（' + merged.size + ' 个像素），v2 明文格式导出的文件会非常大且耗时较长，是否继续？')) return;
      }
      const pixels = [];
      for (const [key, color] of merged) {
        const i = key.indexOf(',');
        pixels.push([+key.slice(0, i), +key.slice(i + 1), color]);
      }
      const out = {
        app: 'infinite-grid-canvas', version: 2, pixels: pixels, shapes: [],
        layers: state.layers.map(function (L) { return { name: L.name, visible: L.visible, shapes: L.shapes }; }),
        objects: state.objects.map(serializeObject),
        instances: state.instances.map(serializeInstance),
        ...state.extra
      };
      downloadBlob(new Blob([JSON.stringify(out)]), name);
      return;
    }

    // v3 紧凑格式（默认）：pal/rows 为所有可见图层的合并像素（旧版可见全部内容），
    // layers 数组保存完整分层结构（新版导入恢复）；objects/instances 保存节点对象与实例
    const data = buildProjectData();
    const layers = state.layers.map(function (L) {
      const d = buildProjectData(L.pixels);
      return { name: L.name, visible: L.visible, pal: d.pal, rows: d.rows, shapes: L.shapes };
    });
    const objects = state.objects.map(serializeObject);
    const instances = state.instances.map(serializeInstance);
    const payload = { pal: data.pal, rows: data.rows, shapes: [], layers: layers, objects: objects, instances: instances, ...state.extra };
    const level = state.compressLevel;
    if (level <= 0) {
      const out = { app: 'infinite-grid-canvas', version: 3, pal: data.pal, rows: data.rows, shapes: [], layers: layers, objects: objects, instances: instances, ...state.extra };
      downloadBlob(new Blob([JSON.stringify(out)]), name);
      return;
    }
    const alg = level >= 8 ? 'gzip' : 'deflate';
    const compressed = await deflateText(JSON.stringify(payload), alg);
    const out = { app: 'infinite-grid-canvas', version: 3, alg: alg, data: compressed };
    downloadBlob(new Blob([JSON.stringify(out)]), name);
  }

  // ---- 对象 / 实例序列化（节点图 graph 与变量 vars 一起导出） ----
  function serializeObject(o) {
    return {
      id: o.id, name: o.name, kind: o.kind, srcLayer: o.srcLayer,
      w: o.w, h: o.h, srcX: o.srcX, srcY: o.srcY,
      pixels: Array.from((o.pixels || new Map()).entries()),
      vars: o.vars || [],
      graph: o.graph || { nodes: [], conns: [], flows: [] },
    };
  }
  function serializeInstance(it) {
    return { id: it.id, objectIdx: it.objectIdx, x: it.x, y: it.y, layerIdx: it.layerIdx, st: it.st || {} };
  }
  // 从工程数据恢复对象与实例（导入时调用）
  function restoreObjectsAndInstances(rawObjs, rawInsts) {
    state.objects.length = 0;
    objCanvases.clear();
    state.instances.length = 0;
    if (Array.isArray(rawObjs)) {
      for (const ro of rawObjs) {
        if (!ro || typeof ro.w !== 'number') continue;
        const o = {
          id: ro.id, name: ro.name || ('对象 ' + ro.id), kind: ro.kind || 'selection',
          srcLayer: ro.srcLayer, w: ro.w, h: ro.h, srcX: ro.srcX, srcY: ro.srcY,
          pixels: new Map(Array.isArray(ro.pixels) ? ro.pixels : []),
          vars: Array.isArray(ro.vars) ? ro.vars : [],
          graph: ro.graph || { nodes: [], conns: [], flows: [] },
        };
        if (o.id >= nextObjId) nextObjId = o.id + 1;
        state.objects.push(o);
        objCanvases.set(o.id, buildObjectCanvas(o));
      }
    }
    if (Array.isArray(rawInsts)) {
      for (const ri of rawInsts) {
        if (!ri || typeof ri.objectIdx !== 'number') continue;
        if (ri.id >= nextInstId) nextInstId = ri.id + 1;
        state.instances.push({ id: ri.id, objectIdx: ri.objectIdx, x: ri.x, y: ri.y, layerIdx: ri.layerIdx, st: ri.st || {} });
      }
    }
    if (typeof renderNodePanel === 'function') renderNodePanel();
    requestRender();
  }

  function importProject(file) {
    const reader = new FileReader();
    reader.onload = function () {
      (async function () {
        try {
          const raw = JSON.parse(reader.result);
          let pal = null, rows = null, arr = null, shapes = null, layers = null;
          let objects = null, instances = null; // 对象（含节点图/变量）与实例
          let extra = {}; // 扩展字段（如思维导图 labels）：导入保留、导出带出（数据中转不丢失）
          const KNOWN = new Set(['app', 'version', 'pixels', 'rows', 'pal', 'layers', 'objects', 'instances', 'shapes', 'alg', 'data']);
          const collectExtra = function (o) {
            const e = {};
            for (const k of Object.keys(o)) if (!KNOWN.has(k)) e[k] = o[k];
            return e;
          };
          if (raw && typeof raw.data === 'string' && raw.alg) {
            // 压缩格式：先解压（objects/instances 在解压后的 inner 里）
            const inner = JSON.parse(await inflateText(raw.data, raw.alg));
            pal = inner.pal; rows = inner.rows; shapes = inner.shapes; layers = inner.layers;
            objects = inner.objects; instances = inner.instances;
            extra = collectExtra(inner);
          } else if (raw && Array.isArray(raw.rows) && Array.isArray(raw.pal)) {
            // v3 明文格式
            pal = raw.pal; rows = raw.rows; shapes = raw.shapes; layers = raw.layers;
            objects = raw.objects; instances = raw.instances;
            extra = collectExtra(raw);
          } else if (raw && Array.isArray(raw.pixels)) {
            arr = raw.pixels; // 旧版 v1/v2 格式
            shapes = raw.shapes; layers = raw.layers;
            objects = raw.objects; instances = raw.instances;
            extra = collectExtra(raw);
          } else {
            throw new Error('不是有效的工程文件');
          }
          state.extra = extra; // 供导出带出（labels 等）
          // 把 pal/rows 展开为像素 Map
          function expandRows(p, r) {
            const m = new Map();
            for (const row of r) {
              const y = Math.round(+row[0]);
              if (!isFinite(y)) continue;
              const segs = row[1];
              for (let si = 0; si < segs.length; si++) {
                const seg = segs[si];
                const color = p[seg[2]];
                const x0 = Math.round(+seg[0]), x1 = Math.round(+seg[1]);
                if (isFinite(x0) && isFinite(x1) && color !== undefined) {
                  for (let x = x0; x <= x1; x++) m.set(x + ',' + y, color);
                }
              }
            }
            return m;
          }
          // 导入完成：重建图层结构
          const finish = function (newLayers, msg) {
            // 清空旧图层块缓存
            for (let i = 0; i < layerChunks.length; i++) {
              if (layerChunks[i]) { layerChunks[i].map.clear(); layerChunks[i].dirty.clear(); }
            }
            state.layers = newLayers;
            state.activeLayer = Math.min(state.activeLayer || 0, state.layers.length - 1);
            syncActiveLayerRefs();
            layerChunks.length = Math.min(layerChunks.length, state.layers.length);
            restoreObjectsAndInstances(objects, instances); // 恢复节点对象与实例（含节点图/变量）
            els.importStatus.style.display = 'none';
            clearHistory(); // 导入工程不可撤销
            renderLayerPanel();
            requestRender();
            alert('导入成功：' + msg);
          };
          // 优先：v3 分层数据（每层含 pal/rows/shapes）
          if (Array.isArray(layers) && layers.length && layers[0] && Array.isArray(layers[0].rows) && Array.isArray(layers[0].pal)) {
            const newLayers = layers.map(function (l, i) {
              return {
                name: l.name || '图层 ' + (i + 1),
                visible: l.visible !== false,
                pixels: expandRows(l.pal, l.rows),
                shapes: Array.isArray(l.shapes) ? l.shapes : [],
              };
            });
            finish(newLayers, '共 ' + newLayers.length + ' 个图层。');
            return;
          }
          // v3 单图层 / v2 兼容：分片展开像素
          const map = new Map();
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          const finishSingle = function () {
            let shapesArr = Array.isArray(shapes) ? shapes : [];
            if (!shapesArr.length && Array.isArray(layers)) {
              for (const l of layers) {
                if (Array.isArray(l.shapes)) shapesArr = shapesArr.concat(l.shapes);
              }
            }
            finish([{ name: '图层 1', visible: true, pixels: map, shapes: shapesArr }],
              '共 ' + map.size + ' 个像素，' + shapesArr.length + ' 个矢量对象。');
            restoreObjectsAndInstances(objects, instances); // v2 旧格式也恢复对象/实例（含节点图/变量）
          };
          if (arr) {
            // 旧格式（v1/v2）：[[x,y,color],...] 分片写入
            let idx = 0;
            (function slice() {
              const t0 = performance.now();
              while (idx < arr.length && performance.now() - t0 < 24) {
                const px = arr[idx++];
                if (!Array.isArray(px) || px.length < 3) continue;
                const x = Math.round(+px[0]), y = Math.round(+px[1]);
                if (!isFinite(x) || !isFinite(y)) continue;
                map.set(x + ',' + y, String(px[2]));
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
              }
              if (idx < arr.length) {
                els.importStatus.textContent = '正在导入工程… ' + Math.round(idx / arr.length * 100) + '%';
                requestAnimationFrame(slice);
                return;
              }
              finishSingle();
            })();
          } else {
            // v3：rows = [y, [[x1,x2,palIdx],...]] 分片展开
            let ri = 0;
            (function slice() {
              const t0 = performance.now();
              while (ri < rows.length && performance.now() - t0 < 24) {
                const row = rows[ri];
                const y = Math.round(+row[0]);
                const segs = row[1];
                if (isFinite(y)) {
                  if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
                for (let si = 0; si < segs.length; si++) {
                  const seg = segs[si];
                  const color = pal[seg[2]];
                  const x0 = Math.round(+seg[0]), x1 = Math.round(+seg[1]);
                  if (isFinite(x0) && isFinite(x1) && color !== undefined) {
                    if (x0 < minX) minX = x0; if (x1 > maxX) maxX = x1;
                    for (let x = x0; x <= x1; x++) map.set(x + ',' + y, color);
                  }
                }
                ri++;
              }
              if (ri < rows.length) {
                els.importStatus.textContent = '正在导入工程… ' + Math.round(ri / rows.length * 100) + '%';
                requestAnimationFrame(slice);
                return;
              }
              finishSingle();
            })();
          }
        } catch (err) {
          alert('导入失败：' + err.message);
        }
      })();
    };
    reader.onerror = function () { alert('读取文件失败。'); };
    reader.readAsText(file);
  }

  // ---------- 噪声生成 ----------
  // 基于种子的确定性随机：相同种子 + 相同参数 → 相同噪声图
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 排列表（perlin / simplex / value / worley 共用）
  function makePerm(seed) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    return p;
  }
  const permCache = new Map();   // seed -> 排列表（避免重复生成）
  function permFor(seed) {
    let p = permCache.get(seed);
    if (!p) {
      if (permCache.size > 64) permCache.clear();
      p = makePerm(seed);
      permCache.set(seed, p);
    }
    return p;
  }
  function fade(t) { return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  const GRAD2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  const GRAD3 = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
                 [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
                 [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
  function dotG2(g, x, y) { return g[0] * x + g[1] * y; }
  function dotG3(g, x, y) { return g[0] * x + g[1] * y; }

  // 经典 Perlin 梯度噪声，返回约 [-1, 1]
  function perlin2(p, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const X = xi & 255, Y = yi & 255;
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    const g = GRAD2;
    const n00 = dotG2(g[aa & 7], xf, yf);
    const n10 = dotG2(g[ba & 7], xf - 1, yf);
    const n01 = dotG2(g[ab & 7], xf, yf - 1);
    const n11 = dotG2(g[bb & 7], xf - 1, yf - 1);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
  }

  // Simplex 2D 噪声（Gustavson 实现），返回约 [-1, 1]
  function simplex2(p, xin, yin) {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const gi0 = p[ii + p[jj]] % 12;
    const gi1 = p[ii + i1 + p[jj + j1]] % 12;
    const gi2 = p[ii + 1 + p[jj + 1]] % 12;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * dotG3(GRAD3[gi0], x0, y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * dotG3(GRAD3[gi1], x1, y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * dotG3(GRAD3[gi2], x2, y2); }
    return 70.0 * (n0 + n1 + n2);
  }

  // Value 噪声：网格点随机值 + 平滑插值，返回 [0, 1]
  function value2(p, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const X = xi & 255, Y = yi & 255;
    const a = p[X + p[Y]] / 255;
    const b = p[X + 1 + p[Y] & 511] / 255;
    const c = p[X + p[(Y + 1) & 255] & 511] / 255;
    const d = p[X + 1 + p[(Y + 1) & 255] & 511] / 255;
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  // Worley 细胞噪声：取最近特征点的距离，返回 [0, 1]
  function worley2(p, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    let minD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy;
        const h1 = p[(cx & 255) + p[cy & 255] & 511];
        const h2 = p[(cx & 255) + p[(cy + 57) & 255] & 511];
        const fx = cx + h1 / 255, fy = cy + h2 / 255;
        const ddx = fx - (xi + xf), ddy = fy - (yi + yf);
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < minD) minD = d2;
      }
    }
    return Math.min(Math.sqrt(minD), 1);
  }

  // 统一采样入口：type ∈ perlin | simplex | value | worley | ridge
  // x/y 为世界格坐标；scale 为缩放；oct 为倍频层数（fbm 叠加）；p 为种子排列表
  function sampleNoise(type, x, y, scale, oct, p) {
    // +0.5：避免采样点落在网格顶点上（Perlin/Simplex 在顶点处退化为常数）
    const px = (x + 0.5) / scale, py = (y + 0.5) / scale;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      let n;
      switch (type) {
        case 'perlin':  n = (perlin2(p, px * freq, py * freq) + 1) / 2; break;
        case 'simplex': n = (simplex2(p, px * freq, py * freq) + 1) / 2; break;
        case 'value':   n = value2(p, px * freq, py * freq); break;
        case 'worley':  n = worley2(p, px * freq, py * freq); break;
        default:        // ridge：基于 Perlin 的山脊变换，平方增强山脊感
          n = perlin2(p, px * freq, py * freq);
          n = 1 - Math.abs(n); n = n * n; break;
      }
      sum += amp * n;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return clamp(sum / norm, 0, 1);
  }

  // 噪声值 -> 颜色（灰度 / 黑白二值 / 彩色渐变）
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l / 100 - 1)) * (s / 100);
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l / 100 - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return rgbaToHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), 255);
  }
  function noiseToColor(v, mode, th) {
    if (mode === 'bw') {
      const g = v >= th ? 255 : 0;
      return rgbaToHex(g, g, g, 255);
    }
    if (mode === 'color') return hslToHex(v * 300, 90, 55);
    const g = Math.round(clamp(v, 0, 1) * 255);
    return rgbaToHex(g, g, g, 255);
  }

  let noiseGenerating = false;
  renderNoiseSeedHist();
  // 噪声种子历史（最近两次）与自动换种子
  let noiseSeedHist = [];
  function renderNoiseSeedHist() {
    const box = document.getElementById('noiseSeedHist');
    if (!box) return;
    box.innerHTML = '';
    if (!noiseSeedHist.length) { box.innerHTML = '<span class="n-note">生成后自动记录前两次种子</span>'; return; }
    noiseSeedHist.slice().reverse().forEach(function (s, i) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.style.cssText = 'padding:2px 8px;font-size:11px;margin-right:6px;';
      b.textContent = (i === 0 ? '🕘 上一次种子 ' : '🕘 上上次种子 ') + s;
      b.title = '点击回填该种子';
      b.addEventListener('click', function () { els.noiseSeed.value = s; });
      box.appendChild(b);
    });
  }
  // 把噪声图按像素写入画布：居中放置、分片生成（每帧 ≤24ms）、支持撤销
  function generateNoise() {
    if (noiseGenerating) return;
    const w = Math.max(1, Math.floor(+els.noiseW.value || 128));
    const h = Math.max(1, Math.floor(+els.noiseH.value || 128));
    if (w > 4096 || h > 4096) { alert('大小不能超过 4096×4096。'); return; }
    if (w * h > 4000000 &&
        !confirm('噪声图较大（' + w + '×' + h + '，约 ' + Math.round(w * h / 1000000) +
                 'M 像素），生成可能需要较长时间，是否继续？')) return;
    const type = els.noiseType.value;
    const scale = Math.max(0.01, +els.noiseScale.value || 10);
    const offX = +els.noiseOffX.value || 0;
    const offY = +els.noiseOffY.value || 0;
    const seed = Math.floor(+els.noiseSeed.value) >>> 0;
    const oct = Math.max(1, Math.min(8, Math.floor(+els.noiseOctaves.value || 1)));
    const mode = els.noiseMode.value;
    const th = clamp(+els.noiseThreshold.value || 0.5, 0, 1);
    const p = permFor(seed);
    // 图片中心放在屏幕中心
    const [wx, wy] = screenToWorld(cssW() / 2, cssH() / 2);
    const gx0 = Math.floor(wx - w / 2), gy0 = Math.floor(wy - h / 2);
    beginStroke();
    noiseGenerating = true;
    els.importStatus.style.display = 'block';
    let row = 0;
    (function slice() {
      const t0 = performance.now();
      while (row < h && performance.now() - t0 < 24) {
        const gy = gy0 + row;
        for (let x = 0; x < w; x++) {
          const v = sampleNoise(type, gx0 + x + offX, gy + offY, scale, oct, p);
          paintCellRaw((gx0 + x) + ',' + gy, noiseToColor(v, mode, th));
        }
        row++;
      }
      if (row < h) {
        els.importStatus.textContent = '正在生成噪声… ' + Math.round(row / h * 100) + '%';
        requestAnimationFrame(slice);
        return;
      }
      els.importStatus.style.display = 'none';
      noiseGenerating = false;
      // 记录本次种子并自动切换新种子（下次无需手动输入）
      noiseSeedHist.push(seed);
      if (noiseSeedHist.length > 2) noiseSeedHist.shift();
      renderNoiseSeedHist();
      els.noiseSeed.value = Math.floor(Math.random() * 1000000);
      markDirtyRect(gx0, gy0, gx0 + w - 1, gy0 + h - 1);
      endStroke();
      requestRender();
    })();
  }

  // ---------- 数学方程图像 ----------
  // 简易表达式解析器：支持 x/y 变量、+ - * / ^ % 运算符、括号、函数、常量
  function tokenizeMath(src) {
    const tokens = [];
    const s = src.replace(/\s+/g, '');
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        const m = s.slice(i).match(/^[0-9]+(\.[0-9]+)?/);
        tokens.push({ t: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
      } else if (/[a-zA-Z_]/.test(c)) {
        const m = s.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
        tokens.push({ t: 'id', v: m[0] });
        i += m[0].length;
      } else if ('+-*/^%(),'.indexOf(c) >= 0) {
        tokens.push({ t: c });
        i++;
      } else {
        throw new Error('无法识别的字符: ' + c);
      }
    }
    return tokens;
  }
  // 编译表达式 → 求值函数 f(x, y)
  function compileMathExpr(src) {
    const tokens = tokenizeMath(src);
    let pos = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function expect(t) {
      const tk = next();
      if (!tk || tk.t !== t) throw new Error('语法错误：缺少 ' + t);
      return tk;
    }
    function parseExpr() {
      let node = parseTerm();
      while (peek() && (peek().t === '+' || peek().t === '-')) {
        const op = next().t;
        const r = parseTerm();
        node = { op: op, l: node, r: r };
      }
      return node;
    }
    function parseTerm() {
      let node = parseUnary();
      while (peek() && (peek().t === '*' || peek().t === '/' || peek().t === '%')) {
        const op = next().t;
        const r = parseUnary();
        node = { op: op, l: node, r: r };
      }
      return node;
    }
    function parseUnary() {
      if (peek() && (peek().t === '-' || peek().t === '+')) {
        const op = next().t;
        return { op: op === '-' ? 'neg' : 'pos', v: parseUnary() };
      }
      return parsePower();
    }
    // 幂运算：优先级高于一元负号（-x^2 = -(x^2)），右结合
    function parsePower() {
      const base = parsePrimary();
      if (peek() && peek().t === '^') {
        next();
        return { op: '^', l: base, r: parseUnary() };
      }
      return base;
    }
    function parsePrimary() {
      const tk = next();
      if (!tk) throw new Error('表达式不完整');
      if (tk.t === 'num') return { v: tk.v };
      if (tk.t === '(') {
        const node = parseExpr();
        expect(')');
        return node;
      }
      if (tk.t === 'id') {
        if (peek() && peek().t === '(') {
          next();
          const args = [];
          if (!(peek() && peek().t === ')')) {
            args.push(parseExpr());
            while (peek() && peek().t === ',') { next(); args.push(parseExpr()); }
          }
          expect(')');
          return { fn: tk.v, args: args };
        }
        return { var: tk.v };
      }
      throw new Error('意外的符号: ' + tk.t);
    }
    const ast = parseExpr();
    if (pos < tokens.length) throw new Error('多余的符号: ' + tokens[pos].t);
    const FN = {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
      sqrt: Math.sqrt, abs: Math.abs, log: Math.log10, ln: Math.log, exp: Math.exp,
      floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
      min: Math.min, max: Math.max, pow: Math.pow,
    };
    function ev(node, x, y) {
      if (node === null || node === undefined) throw new Error('无效表达式');
      if (node.op === 'neg') return -ev(node.v, x, y);
      if (node.op === 'pos') return ev(node.v, x, y);
      if (node.v !== undefined) return node.v;
      if (node.var !== undefined) {
        if (node.var === 'x') return x;
        if (node.var === 'y') return y;
        if (node.var === 'pi') return Math.PI;
        if (node.var === 'e') return Math.E;
        throw new Error('未知变量: ' + node.var);
      }
      if (node.op) {
        const l = ev(node.l, x, y), r = ev(node.r, x, y);
        switch (node.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return l / r;
          case '%': return l % r;
          case '^': return Math.pow(l, r);
        }
      }
      if (node.fn) {
        const f = FN[node.fn];
        if (!f) throw new Error('未知函数: ' + node.fn);
        return f.apply(null, node.args.map(function (a) { return ev(a, x, y); }));
      }
      throw new Error('无效表达式');
    }
    return function (x, y) { return ev(ast, x, y); };
  }
  // 解析方程：y=f(x) → 显式；否则 f(x,y)=g(x,y) → 隐式
  function parseEquation(expr) {
    let depth = 0, eqIdx = -1;
    for (let i = 0; i < expr.length; i++) {
      const c = expr[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '=' && depth === 0) { eqIdx = i; break; }
    }
    if (eqIdx < 0) throw new Error('请使用 = 连接方程，如 y=x^2 或 x^2+y^2=16');
    const left = expr.slice(0, eqIdx).trim();
    const right = expr.slice(eqIdx + 1).trim();
    if (left === 'y' || left === 'Y') {
      const f = compileMathExpr(right);
      return { mode: 'explicit', fn: function (x) { return f(x, 0); } };
    }
    const fl = compileMathExpr(left);
    const fr = compileMathExpr(right);
    return { mode: 'implicit', fn: function (x, y) { return fl(x, y) - fr(x, y); } };
  }
  // 圆形笔触：粗细 = 笔刷大小（以采样点格子中心为圆心）
  function mathPaintDot(cx, cy) {
    const r = state.brushSize / 2;
    const x0 = Math.floor(cx - r), x1 = Math.floor(cx + r);
    const y0 = Math.floor(cy - r), y1 = Math.floor(cy + r);
    const r2 = r * r;
    const ccx = cx + 0.5, ccy = cy + 0.5;
    for (let yy = y0; yy <= y1; yy++)
      for (let xx = x0; xx <= x1; xx++) {
        const dx = (xx + 0.5) - ccx, dy = (yy + 0.5) - ccy;
        if (dx * dx + dy * dy <= r2) paintCellRaw(xx + ',' + yy, state.color);
      }
  }
  // 显式模式下相邻采样点线性插值补点（保证线条连续）
  function mathConnect(ax, ay, bx, by) {
    const dist = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(dist * 2));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      mathPaintDot(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  // 绘制数学方程图像到当前活动图层（屏幕中心放置，支持撤销）
  // 数学坐标 → 画布坐标：画布 Y 向下为正、数学 Y 向上为正，故 Y 翻转；
  // 每个数学单位 × 显示大小 = 画布像素数（默认 8，图像更清晰更大）
  function generateMathGraph() {
    const expr = els.mathExpr.value.trim();
    if (!expr) { alert('请输入方程，如 y=x^2 或 x^2+y^2=16。'); return; }
    let eq;
    try { eq = parseEquation(expr); }
    catch (e) { alert('方程解析失败：' + e.message); return; }
    const xMin = +els.mathXMin.value, xMax = +els.mathXMax.value;
    const yMin = +els.mathYMin.value, yMax = +els.mathYMax.value;
    const scale = Math.max(1, Math.min(64, Math.round(+els.mathScale.value || 8)));
    const step = Math.max(0.5, +els.mathStep.value || 1);
    if (!isFinite(xMin) || !isFinite(xMax) || !isFinite(yMin) || !isFinite(yMax) || xMin >= xMax || yMin >= yMax) {
      alert('范围无效：min 必须小于 max 且为数字。'); return;
    }
    // 画布像素范围：数学坐标 × 显示大小，Y 翻转
    const cxMin = Math.round(xMin * scale), cxMax = Math.round(xMax * scale);
    const cyMin = Math.round(-yMax * scale), cyMax = Math.round(-yMin * scale);
    const scanN = Math.ceil((cxMax - cxMin) / step) * Math.ceil((cyMax - cyMin) / step);
    if (eq.mode === 'implicit' && scanN > 1000000) {
      if (!confirm('隐式扫描点数较多（约 ' + scanN + ' 个），可能较慢，是否继续？')) return;
    }
    beginStroke();
    if (eq.mode === 'explicit') {
      let prev = null;
      for (let cx = cxMin; cx <= cxMax; cx += step) {
        const mx = cx / scale;
        let my;
        try { my = eq.fn(mx); } catch (e) { prev = null; continue; }
        if (!isFinite(my)) { prev = null; continue; }
        const cy = -my * scale; // Y 翻转
        if (cy < cyMin || cy > cyMax) { prev = null; continue; }
        if (prev) mathConnect(prev[0], prev[1], cx, cy);
        else mathPaintDot(cx, cy);
        prev = [cx, cy];
      }
    } else {
      // 隐式方程：线宽完全由笔刷大小控制（与显式方程一致）。
      // 像素到曲线距离 ≈ |f| / |∇f|（一阶近似）；判定带半宽取 0.707px（≈1/√2，
      // 保证任意走向的曲线像素连续），视觉线宽 ≈ 笔刷大小 + 1.4px。
      // 先粗筛远离曲线的像素，再对候选像素数值差分求梯度，控制性能。
      const bwHalf = 0.707 / scale;            // 判定带半宽（数学单位）
      const loose = bwHalf * 30 + 1e-9;        // 粗筛阈值：覆盖 |∇f| ≤ 30 的常见方程
      const h = Math.max(1e-4, 0.25 / scale);  // 梯度差分步长（约 1/4 像素）
      for (let cy = cyMin; cy <= cyMax; cy += step) {
        const my = -cy / scale; // Y 翻转
        for (let cx = cxMin; cx <= cxMax; cx += step) {
          const mx = cx / scale;
          let v;
          try { v = eq.fn(mx, my); } catch (e) { continue; }
          if (!isFinite(v) || Math.abs(v) > loose) continue;
          let g;
          try {
            const gx = (eq.fn(mx + h, my) - eq.fn(mx - h, my)) / (2 * h);
            const gy = (eq.fn(mx, my + h) - eq.fn(mx, my - h)) / (2 * h);
            g = Math.hypot(gx, gy);
          } catch (e) { continue; }
          if (!isFinite(g) || g < 1e-9) continue; // 梯度为 0 的奇异点跳过
          if (Math.abs(v) / g <= bwHalf) mathPaintDot(cx, cy);
        }
      }
    }
    endStroke();
    const pad = state.brushSize;
    markDirtyRect(cxMin - pad, cyMin - pad, cxMax + pad, cyMax + pad);
    requestRender();
  }
  els.btnCloseMath.addEventListener('click', function () { els.mathPanel.classList.remove('open'); });
  els.btnGenMath.addEventListener('click', generateMathGraph);
  // 数轴刻度数字开关与字号（默认随「显示大小」自动调整，拖动滑块手动覆盖）
  els.mathAxisLabels.addEventListener('click', function () {
    state.showAxisLabels = !state.showAxisLabels;
    els.mathAxisLabels.classList.toggle('active', state.showAxisLabels);
    els.mathLabelSizeRow.style.display = state.showAxisLabels ? '' : 'none';
    requestRender();
  });
  els.mathLabelSize.addEventListener('input', function () {
    state.axisLabelAuto = false;
    state.axisLabelSize = +els.mathLabelSize.value;
    els.mathLabelSizeVal.textContent = state.axisLabelSize;
    requestRender();
  });
  els.mathLabelAuto.addEventListener('click', function () {
    state.axisLabelAuto = true;
    els.mathLabelSize.value = 13;
    els.mathLabelSizeVal.textContent = 13;
    requestRender();
  });

  // ---------- 导入图片（按像素） ----------
  // 查表法快速转 hex（比 toString(16)+padStart 快数倍）
  const HEXCH = '0123456789abcdef';
  function rgbaToHex(r, g, b, a) {
    const s = '#' + HEXCH[r >> 4] + HEXCH[r & 15] + HEXCH[g >> 4] + HEXCH[g & 15] + HEXCH[b >> 4] + HEXCH[b & 15];
    return a === 255 ? s : s + HEXCH[a >> 4] + HEXCH[a & 15];
  }

  function importImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { alert('无法读取图片。'); URL.revokeObjectURL(url); return; }
      // 超大图片给出提示（不再强制限制），由用户决定是否继续
      if (w * h > 20000000) {
        if (!confirm('图片较大（' + w + '×' + h + '，约 ' +
            Math.round(w * h / 1000000) + 'M 像素），导入可能需要较长时间，是否继续？')) {
          URL.revokeObjectURL(url);
          return;
        }
      }
      try {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        const data = cx.getImageData(0, 0, w, h).data;
        // 图片左上角放在当前屏幕中心
        const [wx, wy] = screenToWorld(cssW() / 2, cssH() / 2);
        const ox = Math.floor(wx), oy = Math.floor(wy);
        const map = state.pixels;
        // 按行分片写入，避免大图一次性导入卡死界面；每帧预算 24ms，更快完成
        els.importStatus.style.display = 'block';
        let row = 0;
        (function slice() {
          const t0 = performance.now();
          while (row < h && performance.now() - t0 < 24) {
            const y = oy + row;
            const rowOff = row * w;
            for (let x = 0; x < w; x++) {
              const i = (rowOff + x) * 4;
              const a = data[i + 3];
              if (a === 0) continue; // 完全透明跳过
              map.set((ox + x) + ',' + y, rgbaToHex(data[i], data[i + 1], data[i + 2], a));
            }
            row++;
          }
          if (row < h) {
            els.importStatus.textContent = '正在导入图片… ' + Math.round(row / h * 100) + '%';
            requestAnimationFrame(slice);
            return;
          }
          els.importStatus.style.display = 'none';
          markDirtyRect(ox, oy, ox + w - 1, oy + h - 1);
          clearHistory(); // 导入图片不可撤销
          requestRender();
          alert('已导入 ' + w + '×' + h + ' 图片，放置在屏幕中心。');
        })();
      } catch (err) {
        alert('导入失败：图片可能超出浏览器画布尺寸上限（' + err.message + '）。');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { alert('图片加载失败。'); URL.revokeObjectURL(url); };
    img.src = url;
  }

  els.btnExportPng.addEventListener('click', function () { exportPNG(); }); // exportPNG 在 vector-canvas.js，点击时求值
  els.btnExportJson.addEventListener('click', function () {
    exportProject().catch(function (e) { alert('导出工程失败：' + e.message); });
  });
  els.btnImportJson.addEventListener('click', function () { els.fileInput.click(); });
  els.fileInput.addEventListener('change', function () {
    if (els.fileInput.files && els.fileInput.files[0]) importProject(els.fileInput.files[0]);
    els.fileInput.value = '';
  });
  els.btnImportImage.addEventListener('click', function () { els.imageInput.click(); });
  els.imageInput.addEventListener('change', function () {
    if (els.imageInput.files && els.imageInput.files[0]) importImage(els.imageInput.files[0]);
    els.imageInput.value = '';
  });

  // ---------- 初始化 ----------
  function resize() {
    const p = dpr();
    canvas.width = Math.round(cssW() * p);
    canvas.height = Math.round(cssH() * p);
    requestRender();
  }
  window.addEventListener('resize', resize);

// 顶部 / 右侧工具栏独立隐藏开关（与左侧 ▤ 同一模式；不互相影响）
// 状态记在 dataset.userHidden 上，updateUI（沉浸模式）会尊重它，画画不会强制显示回来
const topToggle = document.getElementById('topToggle');
const sideToggle = document.getElementById('sideToggle');
if (topToggle) topToggle.addEventListener('click', function () {
  const tb = document.getElementById('toolbar');
  const hidden = tb.dataset.userHidden === '1';
  tb.dataset.userHidden = hidden ? '' : '1';
  updateUI();
  topToggle.textContent = hidden ? '⤒' : '⤓';
  topToggle.title = hidden ? '隐藏顶部工具栏' : '显示顶部工具栏';
});
// 初始化：设置面板「自定义笔刷/自定义橡皮」选项显示当前笔刷名（刷新后保持）
if (typeof updateCustomBrushLabels === 'function') updateCustomBrushLabels();
if (sideToggle) sideToggle.addEventListener('click', function () {
  const st = document.getElementById('sideToolbar');
  const hidden = st.dataset.userHidden === '1';
  st.dataset.userHidden = hidden ? '' : '1';
  // 右侧工具栏隐藏时，底部提示一并隐藏（同样记在 dataset 上，沉浸模式不强制显示回来）
  const hintEl = document.getElementById('hint');
  if (hintEl) hintEl.dataset.userHidden = hidden ? '' : '1';
  updateUI();
  sideToggle.textContent = hidden ? '⤍' : '⤎';
  sideToggle.title = hidden ? '隐藏右侧工具栏' : '显示右侧工具栏';
});

// ---------- 画笔插件通用 API（供「画笔」等外部 JS 插件调用：实例化对象绘制像素） ----------
// 主程序只提供通用接口，绘制逻辑（落笔/抬笔/颜色/粗细/擦除等节点）全部由插件 JS 实现。
state.penCells = new Map(); // 对象索引 → 该对象所有实例绘制过的格子集合（供「全部擦除节点」使用）
window.penAPI = {
  // 当前笔刷大小（像素）与当前颜色
  brushSize: function () { return state.brushSize; },
  color: function () { return state.color; },
  activeLayer: function () { return state.activeLayer; },
  // 以 (x, y) 为中心画 size×size 方块到当前图层，并记录到该对象的绘制记录（可擦除）
  drawAt: function (objIdx, x, y, size, color) {
    const li = state.activeLayer;
    const r = Math.max(1, Math.floor((size || 1) / 2));
    let cells = state.penCells.get(objIdx);
    if (!cells) { cells = new Set(); state.penCells.set(objIdx, cells); }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = Math.round(x) + dx, gy = Math.round(y) + dy;
        const key = gx + ',' + gy;
        paintCellRaw(key, color, li);
        cells.add(key);
      }
    }
  },
  // 擦除该对象所有实例绘制过的像素（「全部擦除节点」用）
  eraseObject: function (objIdx) {
    const cells = state.penCells.get(objIdx);
    if (!cells) return;
    for (const key of cells) paintCellRaw(key, null);
    state.penCells.delete(objIdx);
  },
  // 通用实例步进钩子：主程序每帧更新完每个实例后调用（画笔等插件注册绘制/逻辑用）
  _stepHooks: [],
  onStep: function (fn) { window.penAPI._stepHooks.push(fn); },
  runStepHooks: function (obj, inst) {
    for (const fn of window.penAPI._stepHooks) { try { fn(obj, inst); } catch (e) { /* 插件钩子错误忽略 */ } }
  },
};
