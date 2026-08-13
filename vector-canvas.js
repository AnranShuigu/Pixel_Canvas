// ===================================================================
// 图层系统与应用初始化（vector-canvas.js）
// 依赖 pixel-canvas.js（状态、渲染、工具、撤销等），必须在其之后加载
// ===================================================================
'use strict';

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

  // 右侧工具栏：工具切换
  // 画笔/橡皮（点击展开选择）
  els.rToolBrush.addEventListener('click', function (e) {
    e.stopPropagation();
    els.brushMenu.classList.toggle('open');
    if (els.brushMenu.classList.contains('open')) raiseSidePanel(els.brushMenu);
  });
  els.brushMenu.querySelectorAll('.tool-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTool(btn.getAttribute('data-brush'));
      els.brushMenu.classList.remove('open');
    });
  });
  document.addEventListener('click', function (e) {
    if (els.brushMenu && !els.brushMenu.contains(e.target) && e.target !== els.rToolBrush) {
      els.brushMenu.classList.remove('open');
    }
  });
  els.rToolShape.addEventListener('click', function (e) {
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
  els.btnLayerDel.addEventListener('click', deleteLayer);
  // 矢量图模式切换按钮已从界面移除
  function hasPixelContent() {
    for (const L of state.layers) if (L.visible && L.pixels.size > 0) return true;
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
    }
    return { minX, minY, maxX, maxY };
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
      out.toBlob(function (blob) {
        if (blob) downloadBlob(blob, 'pixel-image-' + ts() + '.png');
        else alert('导出失败。');
      }, 'image/png');
    })();
  }

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
    // 图层系统：同步活动图层引用并渲染面板
    syncActiveLayerRefs();
    renderLayerPanel();
    initPalette();
  })();