// ===================================================================
// 矢量画布与图层（vector-canvas.js）
// 矢量模式切换 / 矢量对象 / 矢量画笔 / 图层系统 / SVG 导出 / 应用初始化
// 依赖 pixel-canvas.js（状态、渲染、工具、撤销等），必须在其之后加载
// ===================================================================
'use strict';

  // ---------- 矢量图绘制模式 ----------
  // 矢量模式：界面入口已移除（脚本保留，供以后恢复）
  // 切换按钮与 SVG 导出按钮不再渲染，此函数仅做防御性兼容
  function syncVectorModeUI() {
    if (!els.btnVectorMode || !els.btnExportSvg) return;
    const on = state.vectorMode;
    els.btnVectorMode.textContent = on ? '✒ 矢量画布' : '⬚ 像素画布';
    els.btnVectorMode.classList.toggle('active', on);
    els.btnVectorMode.title = on
      ? '当前为矢量图模式（图形工具生成矢量对象，可导出 SVG），点击切换回像素绘制'
      : '当前为像素绘制模式，点击切换为矢量图模式';
    els.btnExportSvg.style.display = on ? '' : 'none';
  }
  let gridStateBeforeVector = null; // 进入矢量模式前的网格显示状态（退出时恢复）
  function setVectorMode(on) {
    state.vectorMode = on;
    if (on) {
      // 矢量模式自动隐藏网格线（矢量绘制无需网格对齐）
      if (gridStateBeforeVector === null) gridStateBeforeVector = state.showGrid;
      state.showGrid = false;
    } else {
      if (gridStateBeforeVector !== null) {
        state.showGrid = gridStateBeforeVector;
        gridStateBeforeVector = null;
      }
    }
    els.settingsGrid.classList.toggle('active', state.showGrid); // 同步设置面板网格按钮
    syncVectorModeUI();
    requestRender();
  }

  // ---------- 图层系统 ----------
  // 活动图层的像素/矢量快捷引用同步
  function syncActiveLayerRefs() {
    const L = state.layers[state.activeLayer];
    if (!L) return;
    state.pixels = L.pixels;
    state.vectorShapes = L.shapes;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 该图层是否已创建为对象（节点系统，node-system.js）
  function hasLayerObject(li) {
    return state.objects.some(function (o) { return o.kind === 'layer' && o.srcLayer === li; });
  }
  // 该图层是否有实例（隐藏图层会同时隐藏并停止其实例）
  function hasLayerInstances(li) {
    return state.instances.some(function (it) { return (it.layerIdx === undefined ? 0 : it.layerIdx) === li; });
  }
  // 双击图层名 → 行内重命名
  function renameLayer(i, el) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = state.layers[i].name;
    input.className = 'layer-name-input';
    el.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = function () {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (v) state.layers[i].name = v;
      renderLayerPanel();
    };
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') { done = true; renderLayerPanel(); }
    });
    input.addEventListener('blur', commit);
  }
  function renderLayerPanel() {
    els.layersList.innerHTML = '';
    for (let i = state.layers.length - 1; i >= 0; i--) { // 顶部图层显示在最上方
      const L = state.layers[i];
      const item = document.createElement('div');
      item.className = 'layer-item' + (i === state.activeLayer ? ' active' : '');
      item.innerHTML = '<span class="eye">' + (L.visible ? '👁' : '🙈') + '</span>' +
        '<span class="objbtn" title="把此图层的像素做成对象（节点编辑器中可加行为节点、实例化）">📦</span>' +
        '<span class="instbtn" title="此图层上有实例（隐藏图层会同时隐藏并停止实例）">⚙</span>' +
        '<span class="renamebtn" title="重命名图层">✏️</span>' +
        '<span class="name">' + escapeHtml(L.name) + '</span>';
      item.querySelector('.eye').addEventListener('click', function (e) {
        e.stopPropagation();
        toggleLayerVisible(i);
      });
      const objBtn = item.querySelector('.objbtn');
      if (hasLayerObject(i)) objBtn.classList.add('on'); // 已添加过节点的图层显示高亮图标
      objBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        createObjectFromLayer(i);
      });
      const instBtn = item.querySelector('.instbtn');
      if (hasLayerInstances(i)) instBtn.classList.add('on'); // 有实例的图层显示高亮图标
      instBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        els.nodePanel.classList.add('open');
        fillNodeCatSelect();
        renderNodePanel();
      });
      const nameEl = item.querySelector('.name');
      const renameBtn = item.querySelector('.renamebtn');
      renameBtn.addEventListener('click', function (e) {
        e.stopPropagation(); // 避免触发 setActiveLayer 重建列表，保证行内编辑正常
        renameLayer(i, nameEl);
      });
      item.addEventListener('click', function () { setActiveLayer(i); });
      els.layersList.appendChild(item);
    }
    els.layersToggle.classList.toggle('active', state.layersPanelVisible);
    els.layersPanel.classList.toggle('open', state.layersPanelVisible);
  }
  function setActiveLayer(i) {
    state.activeLayer = i;
    syncActiveLayerRefs();
    renderLayerPanel();
    requestRender();
  }
  function toggleLayerVisible(i) {
    state.layers[i].visible = !state.layers[i].visible;
    renderLayerPanel();
    requestRender();
  }
  function addLayer() {
    state.layers.push({ name: '图层 ' + (state.layers.length + 1), visible: true, pixels: new Map(), shapes: [] });
    setActiveLayer(state.layers.length - 1);
  }
  function duplicateLayer() {
    const src = state.layers[state.activeLayer];
    const copy = {
      name: src.name + ' 副本',
      visible: true,
      pixels: new Map(src.pixels),
      shapes: src.shapes.map(function (s) { return JSON.parse(JSON.stringify(s)); }),
    };
    state.layers.splice(state.activeLayer + 1, 0, copy);
    setActiveLayer(state.activeLayer + 1);
  }
  function deleteLayer() {
    if (state.layers.length <= 1) { alert('至少需要保留一个图层。'); return; }
    const li = state.activeLayer;
    state.layers.splice(li, 1);
    layerChunks.splice(li, 1);
    // 节点系统：连带删除该图层的实例，并把其后图层的实例索引前移
    state.instances = state.instances.filter(function (it) { return (it.layerIdx === undefined ? 0 : it.layerIdx) !== li; });
    state.instances.forEach(function (it) {
      const l = it.layerIdx === undefined ? 0 : it.layerIdx;
      if (l > li) it.layerIdx = l - 1;
    });
    state.activeLayer = Math.min(state.activeLayer, state.layers.length - 1);
    syncActiveLayerRefs();
    clearHistory(); // 图层结构变化后历史作废
    renderLayerPanel();
    requestRender();
  }

  // 矢量模式下图形工具松手：创建矢量对象（而不是像素化）
  function commitVectorShape() {
    const s0 = shapeStart, s1 = shapeEnd;
    if (!s0 || !s1) return;
    const x0 = Math.min(s0.x, s1.x), x1 = Math.max(s0.x, s1.x);
    const y0 = Math.min(s0.y, s1.y), y1 = Math.max(s0.y, s1.y);
    let shape = null;
    if (state.tool === 'rect') {
      shape = { type: 'rect', x0: x0, y0: y0, x1: x1, y1: y1, color: state.color, size: state.brushSize };
    } else if (state.tool === 'circle') {
      shape = {
        type: 'circle',
        cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
        rx: Math.max(0.5, (x1 - x0 + 1) / 2), ry: Math.max(0.5, (y1 - y0 + 1) / 2),
        color: state.color, size: state.brushSize,
      };
    } else if (state.tool === 'triangle') {
      shape = { type: 'triangle', pts: trianglePoints(s0, s1), color: state.color, size: state.brushSize };
    } else if (state.tool === 'line') {
      shape = { type: 'line', x0: s0.x, y0: s0.y, x1: s1.x, y1: s1.y, color: state.color, size: state.brushSize };
    }
    if (shape) {
      state.vectorShapes.push(shape);
      undoStack.push({ kind: 'vector', layerIdx: state.activeLayer, action: 'add', shape: shape });
      if (undoStack.length > state.maxUndoSteps) undoStack.shift();
      redoStack.length = 0;
      updateUndoUI();
    }
    requestRender();
  }

  // 矢量画笔松手：提交自由路径
  function commitVectorPath() {
    const pts = vectorPath ? vectorPath.points : null;
    vectorPath = null;
    if (pts && pts.length >= 2) {
      const shape = { type: 'path', points: pts, color: state.color, size: state.brushSize };
      state.vectorShapes.push(shape);
      undoStack.push({ kind: 'vector', layerIdx: state.activeLayer, action: 'add', shape: shape });
      if (undoStack.length > state.maxUndoSteps) undoStack.shift();
      redoStack.length = 0;
      updateUndoUI();
    }
    requestRender();
  }

  // 渲染矢量对象（叠加在像素层之上，随视图缩放保持清晰）
  function drawVectorShapes(p) {
    const s = state.scale;
    const X = function (gx) { return gx * s + state.offsetX; };
    const Y = function (gy) { return gy * s + state.offsetY; };
    ctx.setTransform(p, 0, 0, p, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // 按图层顺序（底→顶）绘制所有可见图层的矢量对象
    for (let li = 0; li < state.layers.length; li++) {
      if (!state.layers[li].visible) continue;
      const shapes = state.layers[li].shapes;
      for (const sh of shapes) {
        ctx.strokeStyle = sh.color;
        ctx.lineWidth = Math.max(1, sh.size * s);
        ctx.beginPath();
        if (sh.type === 'rect') {
          ctx.rect(X(sh.x0), Y(sh.y0), (sh.x1 - sh.x0 + 1) * s, (sh.y1 - sh.y0 + 1) * s);
        } else if (sh.type === 'circle') {
          ctx.ellipse(X(sh.cx), Y(sh.cy), sh.rx * s, sh.ry * s, 0, 0, Math.PI * 2);
        } else if (sh.type === 'triangle') {
          const pt = sh.pts;
          ctx.moveTo(X(pt[0][0]) + s / 2, Y(pt[0][1]) + s / 2);
          ctx.lineTo(X(pt[1][0]) + s / 2, Y(pt[1][1]) + s / 2);
          ctx.lineTo(X(pt[2][0]) + s / 2, Y(pt[2][1]) + s / 2);
          ctx.closePath();
        } else if (sh.type === 'line') {
          ctx.moveTo(X(sh.x0) + s / 2, Y(sh.y0) + s / 2);
          ctx.lineTo(X(sh.x1) + s / 2, Y(sh.y1) + s / 2);
        } else if (sh.type === 'path') {
          // 矢量画笔：自由路径（折线）
          if (sh.points.length >= 2) {
            ctx.moveTo(X(sh.points[0][0]) + s / 2, Y(sh.points[0][1]) + s / 2);
            for (let k = 1; k < sh.points.length; k++) {
              ctx.lineTo(X(sh.points[k][0]) + s / 2, Y(sh.points[k][1]) + s / 2);
            }
          }
        }
        ctx.stroke();
      }
    }
  }

  // 拾色器：矢量模式下优先命中矢量对象（从最上层往下），否则取像素颜色
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function pointOnShape(gx, gy, sh) {
    const px = gx + 0.5, py = gy + 0.5;
    const tol = sh.size / 2;
    if (sh.type === 'rect') {
      return distToSeg(px, py, sh.x0, sh.y0, sh.x1, sh.y0) <= tol ||
             distToSeg(px, py, sh.x1, sh.y0, sh.x1, sh.y1) <= tol ||
             distToSeg(px, py, sh.x1, sh.y1, sh.x0, sh.y1) <= tol ||
             distToSeg(px, py, sh.x0, sh.y1, sh.x0, sh.y0) <= tol;
    }
    if (sh.type === 'circle') {
      const d = Math.sqrt(((px - sh.cx) / sh.rx) * ((px - sh.cx) / sh.rx) +
                          ((py - sh.cy) / sh.ry) * ((py - sh.cy) / sh.ry));
      return Math.abs(d - 1) * Math.min(sh.rx, sh.ry) <= tol;
    }
    if (sh.type === 'triangle') {
      const pt = sh.pts;
      return distToSeg(px, py, pt[0][0], pt[0][1], pt[1][0], pt[1][1]) <= tol ||
             distToSeg(px, py, pt[1][0], pt[1][1], pt[2][0], pt[2][1]) <= tol ||
             distToSeg(px, py, pt[2][0], pt[2][1], pt[0][0], pt[0][1]) <= tol;
    }
    if (sh.type === 'line') {
      return distToSeg(px, py, sh.x0, sh.y0, sh.x1, sh.y1) <= tol;
    }
    return false;
  }
  // 右侧工具栏：工具切换
  els.rToolShape.addEventListener('click', function (e) {
    e.stopPropagation();
    els.shapeMenu.classList.toggle('open');
  });
  els.rToolFill.addEventListener('click', function () { setTool('fill'); });
  els.rToolLine.addEventListener('click', function () { setTool('line'); });
  els.rToolMove.addEventListener('click', function () { setTool('move'); });
  els.rToolSelect.addEventListener('click', function (e) {
    e.stopPropagation();
    els.selectMenu.classList.toggle('open');
    els.moreMenu.classList.remove('open');
    els.shapeMenu.classList.remove('open');
  });
  els.selectMenu.querySelectorAll('[data-sel]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTool(btn.getAttribute('data-sel'));
      els.selectMenu.classList.remove('open');
    });
  });
  // 封闭图形子菜单：矩形 / 圆形 / 三角形
  els.shapeMenu.querySelectorAll('.tool-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTool(btn.getAttribute('data-shape'));
      els.shapeMenu.classList.remove('open');
    });
  });
  document.addEventListener('click', function (e) {
    if (!els.shapeMenu.contains(e.target) && e.target !== els.rToolShape) {
      els.shapeMenu.classList.remove('open');
    }
  });

  // 更多工具菜单
  els.rToolMore.addEventListener('click', function (e) {
    e.stopPropagation();
    els.moreMenu.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    if (!els.moreMenu.contains(e.target) && e.target !== els.rToolMore) {
      els.moreMenu.classList.remove('open');
    }
  });
  els.btnOpenPicker.addEventListener('click', function () {
    els.moreMenu.classList.remove('open');
    setTool('picker');
  });

  // 噪声生成面板
  els.btnOpenNoise.addEventListener('click', function () {
    els.moreMenu.classList.remove('open');
    els.noisePanel.classList.add('open');
  });
  els.btnCloseNoise.addEventListener('click', function () {
    els.noisePanel.classList.remove('open');
  });
  // 数学方程图像面板
  els.btnOpenMath.addEventListener('click', function () {
    els.moreMenu.classList.remove('open');
    els.mathPanel.classList.add('open');
  });
  els.btnRandomSeed.addEventListener('click', function () {
    els.noiseSeed.value = Math.floor(Math.random() * 900000) + 100000;
  });
  els.noiseMode.addEventListener('change', function () {
    els.noiseThField.style.display = els.noiseMode.value === 'bw' ? '' : 'none';
  });
  els.btnGenNoise.addEventListener('click', generateNoise);

  // 图层面板：显示/隐藏 + 新建 / 复制 / 删除
  els.layersToggle.addEventListener('click', function () {
    state.layersPanelVisible = !state.layersPanelVisible;
    renderLayerPanel();
  });
  els.btnLayerAdd.addEventListener('click', addLayer);
  els.btnLayerDup.addEventListener('click', duplicateLayer);
  els.btnLayerDel.addEventListener('click', deleteLayer);
  // 矢量图模式切换按钮已从界面移除（脚本保留：恢复时取消注释下面两行并加回 HTML 按钮）
  // els.btnVectorMode.addEventListener('click', function () { setVectorMode(!state.vectorMode); });
  // els.btnExportSvg.addEventListener('click', exportSVG);
  function hasPixelContent() {
    for (const L of state.layers) if (L.visible && L.pixels.size > 0) return true;
    return false;
  }
  function hasVectorContent() {
    for (const L of state.layers) if (L.visible && L.shapes.length > 0) return true;
    return false;
  }
  function hasContent() { return hasPixelContent() || hasVectorContent() || state.objects.length > 0 || state.instances.length > 0; }

  function bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // 像素范围（所有可见图层）
    for (const L of state.layers) {
      if (!L.visible) continue;
      for (const key of L.pixels.keys()) {
        const i = key.indexOf(',');
        const x = +key.slice(0, i), y = +key.slice(i + 1);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    // 矢量对象范围（含描边粗细，所有可见图层）
    const padShape = function (bx0, by0, bx1, by1, size) {
      if (bx0 - size < minX) minX = Math.floor(bx0 - size);
      if (by0 - size < minY) minY = Math.floor(by0 - size);
      if (bx1 + size > maxX) maxX = Math.ceil(bx1 + size);
      if (by1 + size > maxY) maxY = Math.ceil(by1 + size);
    };
    for (const L of state.layers) {
      if (!L.visible) continue;
      for (const sh of L.shapes) {
        if (sh.type === 'rect') padShape(sh.x0, sh.y0, sh.x1, sh.y1, sh.size);
        else if (sh.type === 'circle') padShape(sh.cx - sh.rx, sh.cy - sh.ry, sh.cx + sh.rx, sh.cy + sh.ry, sh.size);
        else if (sh.type === 'triangle') {
          let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
          for (const pt of sh.pts) {
            if (pt[0] < tx0) tx0 = pt[0]; if (pt[0] > tx1) tx1 = pt[0];
            if (pt[1] < ty0) ty0 = pt[1]; if (pt[1] > ty1) ty1 = pt[1];
          }
          padShape(tx0, ty0, tx1, ty1, sh.size);
        } else if (sh.type === 'line') padShape(sh.x0, sh.y0, sh.x1, sh.y1, sh.size);
        else if (sh.type === 'path') {
          for (const pt of sh.points) {
            if (pt[0] < minX) minX = Math.floor(pt[0] - sh.size);
            if (pt[0] > maxX) maxX = Math.ceil(pt[0] + sh.size);
            if (pt[1] < minY) minY = Math.floor(pt[1] - sh.size);
            if (pt[1] > maxY) maxY = Math.ceil(pt[1] + sh.size);
          }
        }
      }
    }
    return { minX, minY, maxX, maxY };
  }

  // 在指定画布上按世界坐标绘制矢量对象（导出用，坐标系 = 世界坐标平移后的像素）
  function drawVectorShapesOn(octx, ox, oy, sizeScale) {
    const k = sizeScale || 1;
    octx.lineJoin = 'round';
    octx.lineCap = 'round';
    // 遍历所有可见图层的矢量对象
    for (let li = 0; li < state.layers.length; li++) {
      if (!state.layers[li].visible) continue;
      for (const sh of state.layers[li].shapes) {
        octx.strokeStyle = sh.color;
        octx.lineWidth = Math.max(1, sh.size * k);
        octx.beginPath();
        if (sh.type === 'rect') {
          octx.rect(ox + sh.x0, oy + sh.y0, sh.x1 - sh.x0 + 1, sh.y1 - sh.y0 + 1);
        } else if (sh.type === 'circle') {
          octx.ellipse(ox + sh.cx, oy + sh.cy, sh.rx, sh.ry, 0, 0, Math.PI * 2);
        } else if (sh.type === 'triangle') {
          const pt = sh.pts;
          octx.moveTo(ox + pt[0][0], oy + pt[0][1]);
          octx.lineTo(ox + pt[1][0], oy + pt[1][1]);
          octx.lineTo(ox + pt[2][0], oy + pt[2][1]);
          octx.closePath();
        } else if (sh.type === 'line') {
          octx.moveTo(ox + sh.x0, oy + sh.y0);
          octx.lineTo(ox + sh.x1, oy + sh.y1);
        } else if (sh.type === 'path') {
          if (sh.points.length >= 2) {
            octx.moveTo(ox + sh.points[0][0], oy + sh.points[0][1]);
            for (let p2 = 1; p2 < sh.points.length; p2++) {
              octx.lineTo(ox + sh.points[p2][0], oy + sh.points[p2][1]);
            }
          }
        }
        octx.stroke();
      }
    }
  }

  // 导出 PNG：透明背景，分片执行 + 复用块缓存，避免大图导出卡死界面
  function exportPNG() {
    if (!hasContent()) {
      alert('画布是空的，没有内容可导出。'); return;
    }
    const b = bounds();
    const pad = 8; // 四周透明留白（像素）
    const w = (b.maxX - b.minX + 1) + pad * 2;
    const h = (b.maxY - b.minY + 1) + pad * 2;
    if (w > 16384 || h > 16384) {
      alert('内容过大（' + w + '×' + h + 'px），超过浏览器上限。请缩小内容后重试。');
      return;
    }
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    // 逐块导出：按图层顺序绘制所有可见图层的块缓存（缺失的块就地生成），分片执行不阻塞
    const cx0 = b.minX >> 5, cx1 = b.maxX >> 5, cy0 = b.minY >> 5, cy1 = b.maxY >> 5;
    let cy = cy0, cx = cx0;
    (function slice() {
      const t0 = performance.now();
      while (cy <= cy1 && performance.now() - t0 < 16) {
        const key = cx + ',' + cy;
        for (let li = 0; li < state.layers.length; li++) {
          if (!state.layers[li].visible) continue;
          const c = layerCache(li);
          if (!c.map.has(key)) buildChunk(cx, cy, li);
          c.dirty.delete(key); // 导出后即视为已缓存
          octx.drawImage(c.map.get(key), pad + (cx * CHUNK - b.minX), pad + (cy * CHUNK - b.minY));
        }
        cx++;
        if (cx > cx1) { cx = cx0; cy++; }
      }
      if (cy <= cy1) { requestAnimationFrame(slice); return; }
      // 矢量层叠加绘制（所有可见图层）
      if (hasVectorContent()) drawVectorShapesOn(octx, pad - b.minX, pad - b.minY);
      out.toBlob(function (blob) {
        if (blob) downloadBlob(blob, 'pixel-image-' + ts() + '.png');
        else alert('导出失败。');
      }, 'image/png');
    })();
  }

  // 导出矢量图（SVG）：矢量对象输出为真正的矢量元素（rect/ellipse/polygon/line），
  // 像素层以 PNG data URL 嵌入 <image>，两者叠加保持所见即所得
  function renderPixelsToDataURL(b) {
    const w = b.maxX - b.minX + 1, h = b.maxY - b.minY + 1;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    const cx0 = b.minX >> 5, cx1 = b.maxX >> 5, cy0 = b.minY >> 5, cy1 = b.maxY >> 5;
    for (let cy = cy0; cy <= cy1; cy++)
      for (let x = cx0; x <= cx1; x++) {
        const key = x + ',' + cy;
        for (let li = 0; li < state.layers.length; li++) {
          if (!state.layers[li].visible) continue;
          const c2 = layerCache(li);
          if (!c2.map.has(key)) buildChunk(x, cy, li);
          cx.drawImage(c2.map.get(key), x * CHUNK - b.minX, cy * CHUNK - b.minY);
        }
      }
    return c.toDataURL('image/png');
  }
  function exportSVG() {
    if (!hasContent()) {
      alert('画布是空的，没有内容可导出。'); return;
    }
    const b = bounds();
    const pad = 8;
    const w = b.maxX - b.minX + 1 + pad * 2;
    const h = b.maxY - b.minY + 1 + pad * 2;
    if (w * h > 100000000) {
      if (!confirm('内容较大（' + w + '×' + h + 'px），生成的 SVG 文件会很大，是否继续？')) return;
    }
    const ox = pad - b.minX, oy = pad - b.minY;
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">');
    if (hasPixelContent()) {
      const dataUrl = renderPixelsToDataURL(b);
      parts.push('<image x="' + pad + '" y="' + pad + '" width="' + (b.maxX - b.minX + 1) +
        '" height="' + (b.maxY - b.minY + 1) + '" href="' + dataUrl + '"/>');
    }
    for (let li = 0; li < state.layers.length; li++) {
      if (!state.layers[li].visible) continue;
      for (const sh of state.layers[li].shapes) {
        const attrs = 'stroke="' + sh.color + '" stroke-width="' + Math.max(1, sh.size) +
          '" fill="none" stroke-linejoin="round" stroke-linecap="round"';
        if (sh.type === 'rect') {
          parts.push('<rect x="' + (ox + sh.x0) + '" y="' + (oy + sh.y0) + '" width="' +
            (sh.x1 - sh.x0 + 1) + '" height="' + (sh.y1 - sh.y0 + 1) + '" ' + attrs + '/>');
        } else if (sh.type === 'circle') {
          parts.push('<ellipse cx="' + (ox + sh.cx) + '" cy="' + (oy + sh.cy) + '" rx="' +
            sh.rx + '" ry="' + sh.ry + '" ' + attrs + '/>');
        } else if (sh.type === 'triangle') {
          const pts = sh.pts.map(function (pt) { return (ox + pt[0]) + ',' + (oy + pt[1]); }).join(' ');
          parts.push('<polygon points="' + pts + '" ' + attrs + '/>');
        } else if (sh.type === 'line') {
          parts.push('<line x1="' + (ox + sh.x0) + '" y1="' + (oy + sh.y0) + '" x2="' +
            (ox + sh.x1) + '" y2="' + (oy + sh.y1) + '" ' + attrs + '/>');
        } else if (sh.type === 'path') {
          if (sh.points.length >= 2) {
            const d = sh.points.map(function (pt, idx) {
              return (idx === 0 ? 'M' : 'L') + (ox + pt[0]) + ' ' + (oy + pt[1]);
            }).join(' ');
            parts.push('<path d="' + d + '" ' + attrs + '/>');
          }
        }
      }
    }
    parts.push('</svg>');
    downloadBlob(new Blob([parts.join('')], { type: 'image/svg+xml' }), 'vector-image-' + ts() + '.svg');
  }
  (function init() {
    state.offsetX = cssW() / 2;
    state.offsetY = cssH() / 2;
    resize();
    updateZoomLabel();
    syncToolUI();
    syncModeUI();
    syncSizeUI();
    syncColorInputs();
    updateUI();
    // 同步设置面板的网格 / 压缩 / 撤销状态
    els.settingsGrid.classList.toggle('active', state.showGrid);
    els.settingsAxis.classList.toggle('active', state.showAxis);
    els.settingsGridStep.value = state.gridStep === 'auto' ? 'auto' : String(state.gridStep);
    els.settingsCompressLevel.value = state.compressLevel;
    els.settingsCompressLevelVal.textContent = state.compressLevel;
    els.settingsExportFormat.value = state.exportFormat;
    updateExportFormatUI();
    els.settingsUndoSteps.value = state.maxUndoSteps;
    els.settingsUndoStepsVal.textContent = state.maxUndoSteps;
    updateUndoUI();
    // 噪声生成器：初始随机种子
    els.noiseSeed.value = Math.floor(Math.random() * 900000) + 100000;
    syncVectorModeUI();
    // 图层系统：同步活动图层引用并渲染面板
    syncActiveLayerRefs();
    renderLayerPanel();
  })();