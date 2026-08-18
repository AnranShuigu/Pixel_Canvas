// ===================================================================
// 图层系统与应用初始化（vector-canvas.js）
// 依赖 pixel-canvas.js（状态、渲染、工具、撤销等），必须在其之后加载
// ===================================================================
'use strict';

  let dragLayerIdx = -1; // 正在拖动的图层索引（拖拽排序用）
  const selectedLayers = new Set(); // 批量选中的图层索引（Shift 范围选择 / 批量隐藏用）
  let shiftAnchor = -1;   // Shift 范围选择的锚点
  let eyeDragPainting = null; // 隐藏按钮拖动批量切换中：{ currentVisible: 0|1 } 记录按下时的可见状态
  let eyeDragMoved = false;   // 隐藏按钮拖动批量切换中是否已移动过（用于抑制拖动后的 click）

  // 图层面板右键菜单（隐藏按钮右键触发）
  let layerCtxTarget = -1;
  function openLayerCtxMenu(x, y, idx) {
    layerCtxTarget = idx;
    const m = document.getElementById('layerCtxMenu');
    if (!m) return;
    m.style.display = 'block';
    m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 8) + 'px';
  }
  function closeLayerCtxMenu() {
    const m = document.getElementById('layerCtxMenu');
    if (m) m.style.display = 'none';
    layerCtxTarget = -1;
  }
  // 批量重命名：把指定图层按 1、2、3…（从下到上）命名；未指定时重命名所有图层
  function batchRenameLayers(indices) {
    if (indices && indices.length) {
      const sorted = indices.slice().sort(function (a, b) { return a - b; }); // 从下到上
      for (let k = 0; k < sorted.length; k++) state.layers[sorted[k]].name = String(k + 1);
    } else {
      for (let i = 0; i < state.layers.length; i++) state.layers[i].name = String(i + 1);
    }
    renderLayerPanel();
    requestRender();
  }
  // 右键菜单动作
  function layerCtxAction(act) {
    const target = layerCtxTarget; // 先保存目标索引（closeLayerCtxMenu 会重置）
    closeLayerCtxMenu();
    if (target < 0 || target >= state.layers.length) return;
    if (act === 'obj') {
      createObjectFromLayer(target);
    } else if (act === 'rename') {
      // 多选时：批量重命名选中图层（1,2,3…从下到上）；单选时：行内重命名该图层
      if (selectedLayers.size > 0) {
        batchRenameLayers(Array.from(selectedLayers));
      } else {
        const item = els.layersList.querySelector('[data-layer-idx="' + target + '"]');
        const nameEl = item ? item.querySelector('.name') : null;
        if (nameEl) renameLayer(target, nameEl);
      }
    }
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
      item.className = 'layer-item' +
        (i === state.activeLayer ? ' active' : '') +
        (selectedLayers.has(i) ? ' multi-sel' : '');
      item.dataset.layerIdx = i;
      item.draggable = true; // 支持拖拽排序
      // 隐藏按钮：有实例时橙色提示、已作为对象时绿色提示；右键弹菜单
      const eyeIcon = L.visible ? '👁' : '🙈';
      const eyeExtra = (hasLayerInstances(i) ? ' has-inst' : '') + (hasLayerObject(i) ? ' has-object' : '');
      const eyeHtml = '<span class="eye' + eyeExtra + '" title="' +
        (L.visible ? '隐藏此图层' : '显示此图层') + '（右键：菜单）">' + eyeIcon + '</span>';
      item.innerHTML = eyeHtml + '<span class="name">' + escapeHtml(L.name) + '</span>';

      const eyeBtn = item.querySelector('.eye');
      // 隐藏按钮：mousedown 记录拖动批量切换的起始状态（不立即切换）
      eyeBtn.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        if (e.button !== 0) return;
        // 记录按下时该图层的可见性，作为拖动批量切换的目标状态
        eyeDragPainting = { currentVisible: L.visible ? 1 : 0 };
        eyeDragMoved = false;
        e.preventDefault(); // 阻止整行拖拽排序
      });
      // 隐藏按钮：click（mouseup 后）→ 切换可见性（若有多选则批量切换所有选中图层）
      eyeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (eyeDragMoved) { eyeDragMoved = false; return; } // 拖动过则本次点击不切换
        const targets = selectedLayers.size > 0 ? Array.from(selectedLayers) : [i];
        if (!targets.includes(i)) targets.push(i);
        for (const li of targets) state.layers[li].visible = !state.layers[li].visible;
        renderLayerPanel();
        requestRender();
      });
      // 隐藏按钮：右键 → 图层菜单
      eyeBtn.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openLayerCtxMenu(e.clientX, e.clientY, i);
      });
      // 隐藏按钮：拖动批量切换（鼠标按住经过的图层应用相同的可见性状态）
      eyeBtn.addEventListener('mouseenter', function (e) {
        if (!eyeDragPainting) return;
        // 仅当鼠标按住（左键）时才批量切换
        if (e.buttons & 1) {
          if (state.layers[i].visible !== eyeDragPainting.currentVisible) {
            state.layers[i].visible = eyeDragPainting.currentVisible;
            eyeDragMoved = true;
            // 只更新当前图层的 eye 图标（不重建整个列表，保证拖动连续不闪烁）
            const cur = item.querySelector('.eye');
            if (cur) {
              cur.textContent = state.layers[i].visible ? '👁' : '🙈';
              cur.title = (state.layers[i].visible ? '隐藏此图层' : '显示此图层') + '（右键：菜单）';
            }
            requestRender();
          }
        }
      });
      // 图层项：单击 → 选中；Shift+单击 → 范围选择
      item.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        if (e.shiftKey) {
          e.preventDefault(); e.stopPropagation();
          // Shift+点击：选中锚点到该图层之间的所有图层
          if (shiftAnchor < 0) shiftAnchor = state.activeLayer;
          const a = shiftAnchor, b = i;
          const lo = Math.min(a, b), hi = Math.max(a, b);
          selectedLayers.clear();
          for (let li = lo; li <= hi; li++) selectedLayers.add(li);
          setActiveLayer(i);
          return;
        }
        // 普通点击：清除批量选择，设为活动层（轻量选择，不重建列表，保证双击重命名正常）
        if (!e.shiftKey) {
          selectedLayers.clear();
          shiftAnchor = i;
        }
        selectLayerLight(i);
      });
      // 名称：双击重命名
      const nameEl = item.querySelector('.name');
      nameEl.addEventListener('dblclick', function (e) {
        e.preventDefault(); e.stopPropagation();
        renameLayer(i, nameEl);
      });
      // 拖拽排序（保留）
      let dragSuppressClick = false;
      item.addEventListener('dragstart', function (e) {
        dragSuppressClick = true;
        dragLayerIdx = i;
        item.classList.add('drag-src');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', String(i)); } catch (err) {}
        }
      });
      item.addEventListener('dragend', function () {
        dragSuppressClick = false;
        dragLayerIdx = -1;
        eyeDragPainting = null; // 拖拽排序结束清除批量切换状态
        item.classList.remove('drag-src');
        els.layersList.querySelectorAll('.layer-item.drag-over').forEach(function (el) { el.classList.remove('drag-over'); });
        renderLayerPanel();
      });
      item.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (dragLayerIdx >= 0 && dragLayerIdx !== i) item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', function () { item.classList.remove('drag-over'); });
      item.addEventListener('drop', function (e) {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (dragLayerIdx < 0 || dragLayerIdx === i) return;
        moveLayer(dragLayerIdx, i);
        dragLayerIdx = -1;
        eyeDragPainting = null;
      });
      item.addEventListener('click', function () {
        if (dragSuppressClick) return; // 拖拽结束后不触发点击选中
        // 单击已被 mousedown 处理；这里无需额外操作（mousedown 已 setActiveLayer）
      });
      els.layersList.appendChild(item);
    }
    // 图层列表外的 mouseup：结束隐藏按钮批量切换
    els.layersToggle.classList.toggle('active', state.layersPanelVisible);
    els.layersPanel.classList.toggle('open', state.layersPanelVisible);
  }
  // 全局 mouseup：结束隐藏按钮拖动批量切换
  document.addEventListener('mouseup', function () {
    if (eyeDragPainting && eyeDragMoved) {
      // 拖动批量切换结束：统一重建列表，确保所有图层图标/高亮同步
      renderLayerPanel();
      requestRender();
    }
    eyeDragPainting = null;
  });
  function setActiveLayer(i) {
    state.activeLayer = i;
    syncActiveLayerRefs();
    renderLayerPanel();
    requestRender();
  }
  // 轻量选中：更新活动图层与高亮 class，不重建列表（保证双击重命名时 DOM 稳定）
  function selectLayerLight(i) {
    if (i < 0 || i >= state.layers.length) return;
    state.activeLayer = i;
    syncActiveLayerRefs();
    const items = els.layersList.querySelectorAll('.layer-item');
    for (const it of items) {
      const idx = +it.getAttribute('data-layer-idx');
      it.classList.toggle('active', idx === i);
      it.classList.toggle('multi-sel', selectedLayers.has(idx));
    }
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
    // 图片 LOD：原图模式图层复制时一并复制原图与 overlay（基底懒加载，副本独立）
    const si = srcImages.get(src);
    if (si) srcImages.set(copy, { img: si.img, w: si.w, h: si.h, ox: si.ox, oy: si.oy, base: null, baseHex: null, baseBusy: false, bbox: null, overlay: null, overlayDirty: false });
    state.layers.splice(state.activeLayer + 1, 0, copy);
    selectedLayers.clear(); shiftAnchor = -1;
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
    selectedLayers.clear(); // 索引变化后批量选择失效
    shiftAnchor = -1;
    renderLayerPanel();
    requestRender();
  }
  // 批量删除图层：删除指定的多个图层（按索引），同步清理实例 / 对象引用 / 图层块缓存
  function deleteLayers(indices) {
    const idxSet = new Set(indices);
    if (!idxSet.size) return;
    if (state.layers.length - idxSet.size < 1) { alert('至少需要保留一个图层。'); return; }
    // 按索引从大到小删除，保证后续索引不受影响
    const sorted = Array.from(idxSet).sort(function (a, b) { return b - a; });
    for (const li of sorted) {
      if (li < 0 || li >= state.layers.length) continue;
      state.layers.splice(li, 1);
      layerChunks.splice(li, 1);
      // 删除该图层的实例，并把其后图层的实例索引前移
      state.instances = state.instances.filter(function (it) { return (it.layerIdx === undefined ? 0 : it.layerIdx) !== li; });
      state.instances.forEach(function (it) {
        const l = it.layerIdx === undefined ? 0 : it.layerIdx;
        if (l > li) it.layerIdx = l - 1;
      });
      // 对象 srcLayer 引用修正
      state.objects.forEach(function (o) {
        if (o.srcLayer === li) o.srcLayer = -1; // 该图层对象失效（不删除对象本身）
        else if (o.srcLayer > li) o.srcLayer--;
      });
    }
    state.activeLayer = Math.min(state.activeLayer, state.layers.length - 1);
    syncActiveLayerRefs();
    clearHistory();
    selectedLayers.clear();
    shiftAnchor = -1;
    renderLayerPanel();
    requestRender();
  }

  // 拖动图层排序：把图层 fromIdx 移动到 toIdx，同步更新所有引用图层索引的地方
  // （活动图层 activeLayer、实例 layerIdx、节点对象 srcLayer、图层块缓存 layerChunks）
  function moveLayer(fromIdx, toIdx) {
    if (fromIdx === toIdx || fromIdx < 0 || fromIdx >= state.layers.length) return;
    const li = fromIdx, ni = toIdx;
    // 移动图层对象
    const [moved] = state.layers.splice(li, 1);
    state.layers.splice(ni, 0, moved);
    // 同步图层块缓存
    const chunk = layerChunks[li];
    layerChunks.splice(li, 1);
    layerChunks.splice(ni, 0, chunk);
    // 同步活动图层索引
    if (state.activeLayer === li) state.activeLayer = ni;
    else if (state.activeLayer > li && state.activeLayer <= ni) state.activeLayer--;
    else if (state.activeLayer < li && state.activeLayer >= ni) state.activeLayer++;
    // 同步实例 layerIdx
    state.instances.forEach(function (it) {
      const l = it.layerIdx === undefined ? 0 : it.layerIdx;
      if (l === li) it.layerIdx = ni;
      else if (l > li && l <= ni) it.layerIdx = l - 1;
      else if (l < li && l >= ni) it.layerIdx = l + 1;
    });
    // 同步节点对象 srcLayer（图层做成对象的引用）
    state.objects.forEach(function (o) {
      if (o.srcLayer === li) o.srcLayer = ni;
      else if (o.srcLayer > li && o.srcLayer <= ni) o.srcLayer--;
      else if (o.srcLayer < li && o.srcLayer >= ni) o.srcLayer++;
    });
    syncActiveLayerRefs();
    clearHistory(); // 图层顺序变化后历史作废
    selectedLayers.clear(); // 图层顺序变化后批量选择索引失效
    shiftAnchor = -1;
    renderLayerPanel();
    requestRender();
  }

  // 右侧工具栏：工具切换
  // 打开画笔/橡皮设置面板（右键选择栏中的「画笔」或「橡皮」触发）
  // 与工具栏其他选择栏一致：用 raiseSidePanel 管理层级（先打开的在下，后打开的在上）
  function openBrushPanel(e, btn) {
    const brush = btn.getAttribute('data-brush');
    setTool(brush); // 先选中该工具，设置面板针对当前工具生效
    // 在隐藏选择栏之前获取坐标（隐藏后 getBoundingClientRect 返回全 0，会导致面板定位到左上角）
    const r = (btn || els.rToolBrush).getBoundingClientRect();
    els.brushMenu.classList.remove('open');
    const p = els.brushPanel;
    if (!p) return;
    p.style.display = 'block';
    raiseSidePanel(p); // 后打开的显示在上层
    // 定位到按钮旁：优先用鼠标事件坐标（更直观），否则用按钮位置
    let lx = e && e.clientX ? e.clientX : r.left;
    let ly = e && e.clientY ? e.clientY : r.top;
    lx = Math.max(4, lx - p.offsetWidth - 8);
    ly = Math.max(4, Math.min(ly, window.innerHeight - p.offsetHeight - 8));
    p.style.left = lx + 'px';
    p.style.top = ly + 'px';
    syncModeUI(); syncSizeUI(); syncColorInputs();
  }
  // 画笔按钮：左键直接选择画笔工具；右键展开画笔/橡皮选择栏
  els.rToolBrush.addEventListener('click', function (e) {
    e.stopPropagation();
    setTool('brush');
  });
  els.rToolBrush.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    els.brushMenu.classList.toggle('open');
    if (els.brushMenu.classList.contains('open')) raiseSidePanel(els.brushMenu);
  });
  // 画笔/橡皮选择栏：左键选工具；右键打开设置面板
  els.brushMenu.querySelectorAll('.tool-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTool(btn.getAttribute('data-brush'));
      els.brushMenu.classList.remove('open');
    });
    btn.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openBrushPanel(e, btn);
    });
  });
  document.addEventListener('click', function (e) {
    if (els.brushMenu && !els.brushMenu.contains(e.target) && e.target !== els.rToolBrush) {
      els.brushMenu.classList.remove('open');
    }
  });
  // 封闭图形按钮：左键直接选择矩形工具；右键展开形状选择栏
  els.rToolShape.addEventListener('click', function (e) {
    e.stopPropagation();
    setTool('rect');
  });
  els.rToolShape.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    els.shapeMenu.classList.toggle('open');
    if (els.shapeMenu.classList.contains('open')) raiseSidePanel(els.shapeMenu);
  });
  els.rToolMove.addEventListener('click', function () { setTool('move'); });
  els.rToolSelect.addEventListener('click', function () { setTool('sel'); });
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
    if (els.moreMenu.classList.contains('open')) raiseSidePanel(els.moreMenu);
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
  // 图片像素化网站（新标签页打开）
  const btnOpenPixelator = document.getElementById('btnOpenPixelator');
  if (btnOpenPixelator) btnOpenPixelator.addEventListener('click', function () {
    els.moreMenu.classList.remove('open');
    window.open('../图片像素化/图片像素化.html', '_blank');
  });
  // 无限矢量画图网站（新标签页打开）
  const btnOpenVectorEditor = document.getElementById('btnOpenVectorEditor');
  if (btnOpenVectorEditor) btnOpenVectorEditor.addEventListener('click', function () {
    els.moreMenu.classList.remove('open');
    window.open('../无限矢量画图/无限矢量画图.html', '_blank');
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
  els.btnLayerDel.addEventListener('click', function () {
    // 有批量选中图层时：一键删除所有选中图层；否则删除当前活动图层
    if (selectedLayers.size > 0) {
      deleteLayers(Array.from(selectedLayers));
    } else {
      deleteLayer();
    }
  });
  // 批量重命名按钮已移除：批量重命名通过右键菜单「重命名」在多选时触发

  // 图层右键菜单
  const layerCtxMenu = document.getElementById('layerCtxMenu');
  if (layerCtxMenu) {
    layerCtxMenu.querySelectorAll('.lctx-item').forEach(function (el) {
      el.addEventListener('click', function () { layerCtxAction(el.getAttribute('data-act')); });
    });
    document.addEventListener('mousedown', function (e) {
      if (layerCtxMenu.style.display === 'block' && !layerCtxMenu.contains(e.target)) closeLayerCtxMenu();
    });
    document.addEventListener('wheel', closeLayerCtxMenu);
  }
  // 矢量图模式切换按钮已从界面移除
  function hasPixelContent() {
    for (const L of state.layers) {
      if (!L.visible) continue;
      if (L.pixels.size > 0) return true;
      if (srcImages.has(L)) return true; // 图片 LOD 原图模式也算有内容
      if (L.shapes && L.shapes.length > 0) return true; // 矢量形状也算内容
    }
    return false;
  }
  function hasContent() { return hasPixelContent() || state.objects.length > 0 || state.instances.length > 0; }

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
      // 图片 LOD 原图模式图层：按原图覆盖范围参与边界计算
      const si = srcImages.get(L);
      if (si) {
        const x0 = si.ox, y0 = si.oy, x1 = si.ox + si.w - 1, y1 = si.oy + si.h - 1;
        if (x0 < minX) minX = x0; if (x1 > maxX) maxX = x1;
        if (y0 < minY) minY = y0; if (y1 > maxY) maxY = y1;
      }
    }
    return { minX, minY, maxX, maxY };
  }

  // 导出图片：按格式导出。静态格式（PNG/JPG/WebP）合并所有可见图层为单帧；
  // 动态格式（GIF/APNG）每个可见图层单独为一帧（从下到上），分片执行避免大图卡死
  function exportImage(fmt) {
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
    // 逐块绘制单个图层到目标 canvas（从 0 开始，只画指定图层）
    function drawLayerTo(ctx, li) {
      const L = state.layers[li];
      const si = srcImages.get(L);
      if (si) {
        // 图片 LOD：原图 + overlay 合成直接绘制（无需栅格化，超大图导出不卡）
        ctx.drawImage(si.img, pad + (si.ox - b.minX), pad + (si.oy - b.minY), si.w, si.h);
        if (si.bbox) {
          if (si.overlayDirty) rebuildOverlay(li);
          if (si.overlay) {
            const bb = si.bbox;
            ctx.drawImage(si.overlay, pad + (bb.x0 - b.minX), pad + (bb.y0 - b.minY), bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1);
          }
        }
        return;
      }
      const cx0 = b.minX >> 5, cx1 = b.maxX >> 5, cy0 = b.minY >> 5, cy1 = b.maxY >> 5;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cx + ',' + cy;
          const c = layerCache(li);
          if (!c.map.has(key)) buildChunk(cx, cy, li);
          c.dirty.delete(key);
          ctx.drawImage(c.map.get(key), pad + (cx * CHUNK - b.minX), pad + (cy * CHUNK - b.minY));
        }
      }
    }
    const visLayers = [];
    for (let li = 0; li < state.layers.length; li++) if (state.layers[li].visible) visLayers.push(li);
    if (!visLayers.length) { alert('没有可见图层。'); return; }

    // 动态格式：GIF / APNG —— 每个可见图层一帧（从下到上）
    if (fmt === 'gif' || fmt === 'apng') {
      const frames = visLayers.map(function (li, idx) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d');
        cx.clearRect(0, 0, w, h);
        drawLayerTo(cx, li);
        // 帧延迟：单帧 200ms（可用性优先，简单固定）
        return { canvas: c, delay: 200 };
      });
      // 生成动图（异步分片：先同步生成全部帧数据，再一次性编码）
      const enc = (fmt === 'gif' ? window.encodeGIF : window.encodeAPNG);
      if (!enc) { alert('该格式编码器不可用。'); return; }
      try {
        const bytes = enc(frames);
        const blob = new Blob([bytes], { type: fmt === 'gif' ? 'image/gif' : 'image/apng' });
        downloadBlob(blob, 'pixel-image-' + ts() + '.' + (fmt === 'apng' ? 'apng' : 'gif'));
      } catch (e) {
        alert('动图导出失败：' + e.message);
      }
      return;
    }

    // 静态格式：合并所有可见图层绘制
    const mime = fmt === 'jpg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    const ext = fmt === 'jpg' ? 'jpg' : fmt === 'webp' ? 'webp' : 'png';
    const cx0 = b.minX >> 5, cx1 = b.maxX >> 5, cy0 = b.minY >> 5, cy1 = b.maxY >> 5;
    let cy = cy0, cx = cx0;
    (function slice() {
      const t0 = performance.now();
      while (cy <= cy1 && performance.now() - t0 < 16) {
        const key = cx + ',' + cy;
        for (const li of visLayers) {
          const c = layerCache(li);
          if (!c.map.has(key)) buildChunk(cx, cy, li);
          c.dirty.delete(key);
          octx.drawImage(c.map.get(key), pad + (cx * CHUNK - b.minX), pad + (cy * CHUNK - b.minY));
        }
        cx++;
        if (cx > cx1) { cx = cx0; cy++; }
      }
      if (cy <= cy1) { requestAnimationFrame(slice); return; }
      out.toBlob(function (blob) {
        if (blob) downloadBlob(blob, 'pixel-image-' + ts() + '.' + ext);
        else alert('导出失败。');
      }, mime, fmt === 'jpg' ? 0.92 : undefined);
    })();
  }
  // 兼容旧调用：exportPNG() 默认 PNG
  function exportPNG() { exportImage('png'); }

  // ---------------- 调色板 ----------------
  // 默认 20 色库；支持单击取色、双击改色、导出/导入调色板、多调色库切换与重命名、
  // localStorage 持久化；工具按钮只显示图标，悬停（title）才显示说明
  const PALETTE_LIBS_KEY = 'grid-palette-libs';
  const DEFAULT_PALETTE = ['#000000', '#444444', '#8a8f9a', '#d5d7de', '#ffffff',
    '#e34c4c', '#e67e22', '#f5c518', '#27ae60', '#16a085',
    '#3498db', '#3b82f6', '#7f6cf0', '#9b59b6', '#e84393',
    '#ff7f50', '#a0522d', '#556b2f', '#8b0000', '#00008b'];
  let paletteLibs = null; // { 库名: [颜色...] }
  let currentLib = null;

  function savePalettes() {
    try { localStorage.setItem(PALETTE_LIBS_KEY, JSON.stringify(paletteLibs)); } catch (e) {}
  }

  // 调色板默认隐藏；切换 / 新建 / 导入调色库时自动展开显示
  function showPalette() {
    const grid = document.getElementById('paletteGrid');
    const toggle = document.getElementById('paletteToggle');
    if (!grid) return;
    grid.classList.remove('hidden');
    if (toggle) toggle.textContent = '🙈';
  }

  function syncPaletteActive() {
    const grid = document.getElementById('paletteGrid');
    if (!grid) return;
    for (const s of grid.children) s.classList.toggle('active', s.dataset.color === state.color);
  }

  function renderPaletteLibMenu() {
    const menu = document.getElementById('paletteLibMenu');
    if (!menu) return;
    menu.innerHTML = '';
    for (const name of Object.keys(paletteLibs)) {
      const item = document.createElement('div');
      item.className = 'lib-item' + (name === currentLib ? ' active' : '');
      const nm = document.createElement('span');
      nm.textContent = name;
      item.appendChild(nm);
      const rn = document.createElement('span');
      rn.className = 'lib-rename';
      rn.textContent = '✏️';
      rn.title = '重命名调色库';
      rn.addEventListener('click', function (e) {
        e.stopPropagation();
        const newName = prompt('重命名调色库', name);
        if (newName && newName.trim() && newName.trim() !== name) {
          const colors = paletteLibs[name];
          delete paletteLibs[name];
          paletteLibs[newName.trim()] = colors;
          if (currentLib === name) currentLib = newName.trim();
          savePalettes();
          renderPaletteLibMenu();
          renderPalette();
        }
      });
      item.appendChild(rn);
      // 删除调色库（删光时重置为默认库）
      const del = document.createElement('span');
      del.className = 'lib-del';
      del.textContent = '🗑';
      del.title = '删除调色库';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('删除调色库「' + name + '」？')) return;
        delete paletteLibs[name];
        if (!Object.keys(paletteLibs).length) paletteLibs['默认调色板'] = DEFAULT_PALETTE.slice();
        if (currentLib === name) currentLib = Object.keys(paletteLibs)[0];
        savePalettes();
        renderPaletteLibMenu();
        renderPalette();
      });
      item.appendChild(del);
      item.addEventListener('click', function () {
        if (name !== currentLib) { currentLib = name; renderPalette(); }
        menu.classList.add('hidden');
        showPalette(); // 切换调色库时自动展开色板
      });
      menu.appendChild(item);
    }
  }

  function renderPalette() {
    const grid = document.getElementById('paletteGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const colors = paletteLibs[currentLib] || [];
    colors.forEach(function (c, idx) {
      const sw = document.createElement('div');
      sw.className = 'pal-swatch';
      sw.style.background = c;
      sw.dataset.color = c;
      sw.title = c + '（单击取色 · 双击调整）';
      // 单击取色
      sw.addEventListener('click', function () {
        state.color = c;
        syncColorInputs();
        syncPaletteActive();
      });
      // 双击改色：弹出原生颜色选择器修改该色块
      sw.addEventListener('dblclick', function () {
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.value = c;
        picker.addEventListener('input', function () {
          const newC = picker.value;
          colors[idx] = newC;
          sw.style.background = newC;
          sw.dataset.color = newC;
          sw.title = newC + '（单击取色 · 双击调整）';
          if (state.color === c) { state.color = newC; syncColorInputs(); }
          savePalettes();
        });
        picker.click();
      });
      grid.appendChild(sw);
    });
    syncPaletteActive();
    const libBtn = document.getElementById('btnPaletteLib');
    if (libBtn) libBtn.title = '调色库：' + currentLib + '（点击切换 / 重命名）';
    renderPaletteLibMenu();
  }

  function initPalette() {
    const grid = document.getElementById('paletteGrid');
    const toggle = document.getElementById('paletteToggle');
    const libBtn = document.getElementById('btnPaletteLib');
    const libMenu = document.getElementById('paletteLibMenu');
    const exportBtn = document.getElementById('btnPaletteExport');
    const importBtn = document.getElementById('btnPaletteImport');
    const fileInput = document.getElementById('paletteFileInput');
    if (!grid || !toggle) return;
    // 载入本地保存的调色库（含默认库）
    try {
      const saved = JSON.parse(localStorage.getItem(PALETTE_LIBS_KEY));
      paletteLibs = (saved && typeof saved === 'object' && Object.keys(saved).length)
        ? saved : { '默认调色板': DEFAULT_PALETTE.slice() };
    } catch (e) {
      paletteLibs = { '默认调色板': DEFAULT_PALETTE.slice() };
    }
    if (!Object.keys(paletteLibs).length) paletteLibs['默认调色板'] = DEFAULT_PALETTE.slice();
    currentLib = Object.keys(paletteLibs)[0];
    renderPalette();
    // 像图层一样可隐藏：🙈 点击隐藏，👁 点击恢复
    toggle.addEventListener('click', function () {
      grid.classList.toggle('hidden');
      toggle.textContent = grid.classList.contains('hidden') ? '👁' : '🙈';
    });
    // 新建调色库：以默认 20 色起步，重名则提示
    const newBtn = document.getElementById('btnPaletteNew');
    if (newBtn) newBtn.addEventListener('click', function () {
      const name = prompt('新建调色库名称', '调色板' + (Object.keys(paletteLibs).length + 1));
      if (!name || !name.trim()) return;
      if (paletteLibs[name.trim()]) { alert('已存在同名调色库「' + name.trim() + '」。'); return; }
      paletteLibs[name.trim()] = DEFAULT_PALETTE.slice();
      currentLib = name.trim();
      savePalettes();
      renderPalette();
      showPalette();
    });
    // 导出当前调色板（JSON，含库名）
    if (exportBtn) exportBtn.addEventListener('click', function () {
      const out = { app: 'grid-palette', version: 1, name: currentLib, colors: paletteLibs[currentLib] };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
      a.download = 'palette-' + currentLib + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
    // 导入调色板：加入调色库并切换到它
    if (importBtn) importBtn.addEventListener('click', function () { fileInput.click(); });
    if (fileInput) fileInput.addEventListener('change', function () {
      const f = fileInput.files && fileInput.files[0];
      if (f) {
        const fr = new FileReader();
        fr.onload = function () {
          try {
            const data = JSON.parse(String(fr.result).replace(/^\uFEFF/, ''));
            if (!data || !Array.isArray(data.colors)) { alert('不是有效的调色板文件（缺少 colors 数组）。'); return; }
            const colors = data.colors.map(function (c) { return String(c); })
              .filter(function (c) { return /^#[0-9a-f]{6}$/i.test(c) || /^#[0-9a-f]{8}$/i.test(c); });
            if (!colors.length) { alert('调色板里没有有效的颜色。'); return; }
            const name = (data.name && String(data.name).trim()) ||
              f.name.replace(/\.json$/i, '') || ('调色板' + (Object.keys(paletteLibs).length + 1));
            paletteLibs[name] = colors;
            currentLib = name;
            savePalettes();
            renderPalette();
            showPalette();
            alert('已导入调色板「' + name + '」（' + colors.length + ' 色）。');
          } catch (e) { alert('导入失败：' + (e && e.message ? e.message : '未知原因')); }
        };
        fr.readAsText(f);
      }
      fileInput.value = '';
    });
    // 调色库切换：按钮只显示图标，悬停 title 显示当前库名；点击弹出库列表
    if (libBtn && libMenu) {
      libBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        libMenu.classList.toggle('hidden');
        renderPaletteLibMenu();
      });
      document.addEventListener('click', function () { libMenu.classList.add('hidden'); });
    }
    // 拾色器 / 颜色选择器等其他取色方式变化时同步高亮
    document.addEventListener('colorchange', syncPaletteActive);
  }

  (function init() {
    // 恢复上次保存的设置（工具/笔刷/颜色/网格/导出格式等），再同步 UI
    if (typeof loadSettings === 'function') loadSettings();
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
    if (els.settingsExportImageFormat) els.settingsExportImageFormat.value = state.exportImageFormat || 'png';
    els.settingsUndoSteps.value = state.maxUndoSteps;
    els.settingsUndoStepsVal.textContent = state.maxUndoSteps;
    updateUndoUI();
    // 噪声生成器：初始随机种子
    els.noiseSeed.value = Math.floor(Math.random() * 900000) + 100000;
    // 图层系统：同步活动图层引用并渲染面板
    syncActiveLayerRefs();
    renderLayerPanel();
    initPalette();
  })();