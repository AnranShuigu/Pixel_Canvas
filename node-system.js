// ===================================================================
// 节点系统（node-system.js）——Blender 几何节点式：节点 + 连线组合数据流
// 对象模板 / 实例 / 节点注册表 / 节点图求值引擎 / 节点编辑器 / 全屏模式
// 依赖 pixel-canvas.js（state、els、requestRender、撤销栈等），必须在其之后加载；
// vector-canvas.js 依赖本文件。
//
// 扩展节点（含「其他节点」插件目录）：
//   registerNodeType('类型名', 定义对象) 即可，注册后自动出现在编辑器下拉/分类中。
//   定义对象：
//     name/category/desc
//     sockets 端口：[{ key, dir:'in'|'out', type:'vec'|'num', label }]（连线类型必须一致）
//     params  参数：[{ key, label, type:'number'|'select', min,max,step,def, options:()=>[{v,label}] }]
//     value(inputs, inst, p, st)  数据节点：返回 vec={x,y} 或 num（有输出端口时调用）
//     run(inputs, inst, p, st)    动作节点：每帧执行（无输出端口时调用），改 inst.x/inst.y 移动
//   每个对象的节点图 = graph:{ nodes:[{id,type,p,x,y}], conns:[{from,fromSock,to,toSock}] }
//   数据流沿连线从输出端口流向输入端口，动作节点最终驱动实例移动。
// ===================================================================
'use strict';

// ===================================================================
// 节点类型注册表（扩展接口）
// ===================================================================
const NODE_TYPES = {};
const NODE_DEF_SRC = {}; // 类型 id → 可编辑的注册源码（右键编辑用）
const deletedNodeIds = new Set(); // 用户删除的节点 id（含内置；持久化后重启仍跳过注册）
function registerNodeType(type, def) {
  if (deletedNodeIds.has(type)) return; // 用户已删除此节点（保存过），跳过注册
  NODE_TYPES[type] = def;
  NODE_DEF_SRC[type] = buildNodeSrc(type, def);
}
// 把任意值序列化为 JS 源码（函数用 toString，支持嵌套对象/数组）
function jsonSrc(v, ind) {
  if (typeof v === 'function') return v.toString();
  if (Array.isArray(v)) return '[' + v.map(function (x) { return jsonSrc(x, ind + 1); }).join(', ') + ']';
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (!ks.length) return '{}';
    const pad1 = new Array(ind * 2 + 2).join(' '), pad2 = new Array(ind * 2).join(' ');
    return '{\n' + ks.map(function (k) { return pad1 + JSON.stringify(k) + ': ' + jsonSrc(v[k], ind + 1); }).join(',\n') + '\n' + pad2 + '}';
  }
  return JSON.stringify(v);
}
function buildNodeSrc(type, def) {
  const L = [];
  L.push("registerNodeType('" + type + "', {");
  L.push('  name: ' + JSON.stringify(def.name) + ',');
  L.push('  category: ' + JSON.stringify(def.category) + ',');
  if (def.desc) L.push('  desc: ' + JSON.stringify(def.desc) + ',');
  if (def.flowIn) L.push('  flowIn: true,');
  if (def.flowOut) L.push('  flowOut: true,');
  if (def.sockets) L.push('  sockets: ' + jsonSrc(def.sockets, 1) + ',');
  if (def.params) L.push('  params: ' + jsonSrc(def.params, 1) + ',');
  if (def.value) L.push('  value: ' + def.value.toString() + ',');
  if (def.run) L.push('  run: ' + def.run.toString() + ',');
  L.push('});');
  return L.join('\n');
}
// ---------- 自制节点在线编辑（localStorage 持久化） ----------
const CUSTOM_NODES_KEY = 'nd-custom-nodes';
const customNodeCodes = {}; // 内存表：id → 代码（新增/编辑的自制节点）
function loadCustomNodes() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(CUSTOM_NODES_KEY) || '{}'); } catch (e) { raw = {}; }
  // 新格式 { nodes:{id:code}, deleted:[...] }；旧格式 { id:code } 兼容
  const nodes = raw.nodes || raw;
  for (const id of Object.keys(nodes)) customNodeCodes[id] = nodes[id];
  if (Array.isArray(raw.deleted)) raw.deleted.forEach(function (id) { deletedNodeIds.add(id); });
  for (const id of Object.keys(customNodeCodes)) {
    try { (0, eval)(customNodeCodes[id]); } catch (e) { console.warn('自制节点加载失败: ' + id + ' · ' + e.message); }
  }
  customBaseline = new Set(Object.keys(customNodeCodes)); // 记录本次会话开始时已保存的自制节点
}
// 立即持久化全部状态（新增/编辑/删除后自动调用）
function persistCustomNodes() {
  localStorage.setItem(CUSTOM_NODES_KEY, JSON.stringify({ nodes: customNodeCodes, deleted: Array.from(deletedNodeIds) }));
}
let customBaseline = new Set();       // 本次会话开始时已保存的自制节点 id（用于统计“本次新增”）
let newCustomNodesThisSession = new Set(); // 本次会话新增的自制节点 id
let deletedThisSession = new Set();        // 本次会话删除的节点 id
function saveCustomNode(id, code) {
  const isNew = !customBaseline.has(id);
  customNodeCodes[id] = code;
  deletedNodeIds.delete(id); // 保存 = 恢复该 id（若曾删除）
  if (isNew) newCustomNodesThisSession.add(id); // 新增的自制节点计入本次保存
  // 注意：只更新内存，不写入 localStorage——点「💾 保存」按钮才持久化（重启后保留）
}
function deleteCustomNode(id) {
  delete customNodeCodes[id];
  deletedNodeIds.add(id); // 含内置节点：点「💾 保存」后重启不再注册
  deletedThisSession.add(id); // 本次删除计入保存提示
}
// 【保存】按钮：手动把当前新增/删除状态写入 localStorage（重启后保留）
function saveAllCustomNodes() {
  persistCustomNodes();
  const info = [];
  const nNew = newCustomNodesThisSession.size;
  const nDel = deletedThisSession.size;
  if (nNew) info.push('已保存 ' + nNew + ' 个自制节点');
  if (nDel) info.push('已记录 ' + nDel + ' 个被删除的节点（重启后不再出现）');
  // 已保存的本次变更清零，下次保存只显示新一轮的新增/删除
  newCustomNodesThisSession = new Set();
  deletedThisSession = new Set();
  customBaseline = new Set(Object.keys(customNodeCodes));
  return info.join('；') || '没有新增/删除内容';
}
function defaultParams(def) {
  const p = {};
  if (def.params) for (const prm of def.params) p[prm.key] = prm.def;
  return p;
}
function hasOutput(def) { return def.sockets && def.sockets.some(function (s) { return s.dir === 'out'; }); }
// 分类顺序：事件/运动/控制/侦测/运算/变量/自制（Scratch 式）→ 常量/输入/动作（Blender 基础）
// 右侧工具栏弹出面板层级：谁先点击谁显示在最下面，后点击的永远显示在最上面
let sidePanelZ = 30;
function raiseSidePanel(el) { if (el) { sidePanelZ++; el.style.zIndex = sidePanelZ; } }
const NODE_CATS = {
  '事件': '#ffd500', '运动': '#4c97ff', '控制': '#ffab19', '侦测': '#0fbd8c',
  '运算': '#59c059', '变量': '#ff8c1a', '自制': '#ff6680',
  '声音': '#a855f7',
  '常量': '#9aa0ab', '输入': '#7aa2ff', '插件': '#22d3ee',
};
// 按键下拉选项（当按下/键盘按下等节点使用）
const KEY_OPTIONS = [
  { v: 'ArrowUp', label: '↑ 上' }, { v: 'ArrowDown', label: '↓ 下' },
  { v: 'ArrowLeft', label: '← 左' }, { v: 'ArrowRight', label: '→ 右' },
  { v: 'KeyW', label: 'W' }, { v: 'KeyA', label: 'A' },
  { v: 'KeyS', label: 'S' }, { v: 'KeyD', label: 'D' },
  { v: 'Space', label: '空格' },
];

// ---------- 键盘状态（供「键盘输入」等节点使用） ----------
const keys = new Set();
window.addEventListener('keydown', function (e) {
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  keys.add(e.code);
});
window.addEventListener('keyup', function (e) { keys.delete(e.code); });
window.addEventListener('blur', function () { keys.clear(); });

// ===================================================================
// 基础节点集（常量 / 输入 / 运算 / 动作）
// 组合示例：
//   键盘移动：键盘输入 → 移动
//   随机漫游：随机向量 → 移动
//   追踪目标：目标位置 ⊖ 自身位置 → 向量单位化 → 向量缩放 → 移动
//   鼠标跟随：鼠标位置 ⊖ 自身位置 → 向量单位化 → 向量缩放 → 移动
// ===================================================================

// ---- 常量 ----
registerNodeType('constVec', {
  name: '常量向量', category: '常量',
  desc: '输出一个固定向量',
  sockets: [{ key: 'out', dir: 'out', type: 'vec', label: '向量' }],
  params: [
    { key: 'x', label: 'X', type: 'number', min: -1000, max: 1000, step: 1, def: 1 },
    { key: 'y', label: 'Y', type: 'number', min: -1000, max: 1000, step: 1, def: 0 },
  ],
  value: function (inputs, inst, p) { return { x: p.x, y: p.y }; },
});
registerNodeType('constNum', {
  name: '常量数字', category: '常量',
  desc: '输出一个固定数字',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '数字' }],
  params: [{ key: 'v', label: '值', type: 'number', min: -1000, max: 1000, step: 0.1, def: 1 }],
  value: function (inputs, inst, p) { return p.v; },
});
registerNodeType('constStr', {
  name: '字符串', category: '常量',
  desc: '输出一段固定文本（字符串常量，可输入任意文字）',
  sockets: [{ key: 'out', dir: 'out', type: 'str', label: '文本' }],
  params: [{ key: 's', label: '文本', type: 'text', def: 'Hello' }],
  value: function (inputs, inst, p) { return p.s; },
});
registerNodeType('constArrItem', {
  name: '常量数组值', category: '常量',
  desc: '选择「变量」分类中添加的数组，输出指定组/索引的常量值（把数组当作固定常量数据源）',
  sockets: [
    { key: 'grp', dir: 'in', type: 'num', label: '组' },
    { key: 'idx', dir: 'in', type: 'num', label: '索引' },
    { key: 'out', dir: 'out', type: 'num', label: '值' },
  ],
  params: [{ key: 'arr', label: '数组', type: 'select', def: '', options: arrOptions }],
  value: function (inputs, inst, p) {
    if (!p.arr) return 0;
    const a = ensureInstArr(inst, p.arr);
    const cap = arrSizeOf(state.objects[inst.objectIdx], p.arr);
    const g = (inputs.grp === null || inputs.grp === undefined) ? 0 : Math.floor(inputs.grp);
    const i = (inputs.idx === null || inputs.idx === undefined) ? 0 : Math.floor(inputs.idx);
    if (g < 0 || i < 0 || i >= cap) return 0;
    const row = a[g];
    const v = Array.isArray(row) ? row[i] : 0;
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
  },
});

// ---- 输入 ----
registerNodeType('keyInput', {
  name: '键盘输入', category: '输入',
  desc: '方向键 / WASD 按下的方向向量（×速度）',
  sockets: [{ key: 'out', dir: 'out', type: 'vec', label: '方向' }],
  params: [{ key: 'speed', label: '速度(格/帧)', type: 'number', min: 0.1, max: 10, step: 0.1, def: 1.5 }],
  value: function (inputs, inst, p) {
    let dx = 0, dy = 0;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
    if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1;
    if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1;
    if (dx === 0 && dy === 0) return { x: 0, y: 0 };
    const d = Math.hypot(dx, dy);
    return { x: dx / d * p.speed, y: dy / d * p.speed };
  },
});
registerNodeType('mousePos', {
  name: '鼠标位置', category: '输入',
  desc: '鼠标指针的世界坐标',
  sockets: [{ key: 'out', dir: 'out', type: 'vec', label: '位置' }],
  value: function () {
    return {
      x: (state.mouseX - state.offsetX) / state.scale,
      y: (state.mouseY - state.offsetY) / state.scale,
    };
  },
});
registerNodeType('selfPos', {
  name: '自身位置', category: '输入',
  desc: '本实例的中心位置',
  sockets: [{ key: 'out', dir: 'out', type: 'vec', label: '位置' }],
  value: function (inputs, inst) {
    const obj = state.objects[inst.objectIdx];
    return { x: inst.x + (obj ? obj.w / 2 : 0), y: inst.y + (obj ? obj.h / 2 : 0) };
  },
});
registerNodeType('targetPos', {
  name: '目标位置', category: '输入',
  desc: '另一对象第一个实例的中心位置',
  sockets: [{ key: 'out', dir: 'out', type: 'vec', label: '位置' }],
  params: [{
    key: 'target', label: '目标', type: 'select', num: true, def: -1,
    options: function () {
      const opts = [{ v: -1, label: '（无）' }];
      state.objects.forEach(function (o, i) { opts.push({ v: i, label: o.name }); });
      return opts;
    },
  }],
  value: function (inputs, inst, p) {
    if (p.target < 0 || !state.objects[p.target]) return { x: 1e9, y: 1e9 };
    for (const it of state.instances) {
      if (it.objectIdx === p.target && it !== inst) {
        const obj = state.objects[p.target];
        return { x: it.x + obj.w / 2, y: it.y + obj.h / 2 };
      }
    }
    return { x: 1e9, y: 1e9 }; // 无目标实例：返回远离坐标，避免距离比较(null→0)误判为"很近"
  },
});
registerNodeType('randomVec', {
  name: '随机向量', category: '输入',
  desc: '每隔一段时间换一个随机单位方向',
  sockets: [{ key: 'out', dir: 'out', type: 'vec', label: '方向' }],
  params: [{ key: 'interval', label: '换向间隔(帧)', type: 'number', min: 10, max: 600, step: 10, def: 90 }],
  value: function (inputs, inst, p, st) {
    if (st.t === undefined || st.t <= 0) {
      st.ang = Math.random() * Math.PI * 2;
      st.t = Math.round(p.interval * (0.5 + Math.random() * 0.5));
    }
    st.t--;
    return { x: Math.cos(st.ang), y: Math.sin(st.ang) };
  },
});
registerNodeType('time', {
  name: '帧计数', category: '输入',
  desc: '自运行以来的帧数（数字）',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '帧数' }],
  value: function () { return frameCount; },
});

// ---- 运算 ----
registerNodeType('vecAdd', {
  name: '向量相加', category: '运算',
  desc: 'A + B',
  sockets: [
    { key: 'a', dir: 'in', type: 'vec', label: 'A' },
    { key: 'b', dir: 'in', type: 'vec', label: 'B' },
    { key: 'out', dir: 'out', type: 'vec', label: '和' },
  ],
  value: function (inputs) {
    if (!inputs.a || !inputs.b) return null;
    return { x: inputs.a.x + inputs.b.x, y: inputs.a.y + inputs.b.y };
  },
});
registerNodeType('vecSub', {
  name: '向量相减', category: '运算',
  desc: 'A - B',
  sockets: [
    { key: 'a', dir: 'in', type: 'vec', label: 'A' },
    { key: 'b', dir: 'in', type: 'vec', label: 'B' },
    { key: 'out', dir: 'out', type: 'vec', label: '差' },
  ],
  value: function (inputs) {
    if (!inputs.a || !inputs.b) return null;
    return { x: inputs.a.x - inputs.b.x, y: inputs.a.y - inputs.b.y };
  },
});
registerNodeType('vecScale', {
  name: '向量缩放', category: '运算',
  desc: '向量 × 数字',
  sockets: [
    { key: 'v', dir: 'in', type: 'vec', label: '向量' },
    { key: 'n', dir: 'in', type: 'num', label: '倍数' },
    { key: 'out', dir: 'out', type: 'vec', label: '结果' },
  ],
  value: function (inputs) {
    if (!inputs.v || inputs.n === null || inputs.n === undefined) return null;
    return { x: inputs.v.x * inputs.n, y: inputs.v.y * inputs.n };
  },
});
registerNodeType('vecNorm', {
  name: '向量单位化', category: '运算',
  desc: '长度归一为 1（零向量返回零向量）',
  sockets: [
    { key: 'v', dir: 'in', type: 'vec', label: '向量' },
    { key: 'out', dir: 'out', type: 'vec', label: '单位向量' },
  ],
  value: function (inputs) {
    if (!inputs.v) return null;
    const d = Math.hypot(inputs.v.x, inputs.v.y);
    if (d === 0) return { x: 0, y: 0 };
    return { x: inputs.v.x / d, y: inputs.v.y / d };
  },
});
registerNodeType('vecLen', {
  name: '向量长度', category: '运算',
  desc: '输出向量的长度（数字）',
  sockets: [
    { key: 'v', dir: 'in', type: 'vec', label: '向量' },
    { key: 'out', dir: 'out', type: 'num', label: '长度' },
  ],
  value: function (inputs) {
    if (!inputs.v) return null;
    return Math.hypot(inputs.v.x, inputs.v.y);
  },
});
registerNodeType('vecClamp', {
  name: '限制长度', category: '运算',
  desc: '向量长度限制在 max 内，方向不变',
  sockets: [
    { key: 'v', dir: 'in', type: 'vec', label: '向量' },
    { key: 'max', dir: 'in', type: 'num', label: '上限' },
    { key: 'out', dir: 'out', type: 'vec', label: '结果' },
  ],
  value: function (inputs) {
    if (!inputs.v) return null;
    const max = inputs.max === null || inputs.max === undefined ? Infinity : inputs.max;
    const d = Math.hypot(inputs.v.x, inputs.v.y);
    if (d === 0) return { x: 0, y: 0 };
    if (d <= max) return { x: inputs.v.x, y: inputs.v.y };
    const k = max / d;
    return { x: inputs.v.x * k, y: inputs.v.y * k };
  },
});

// ---- 动作 ----
registerNodeType('move', {
  name: '移动', category: '运动', flowIn: true, flowOut: true,
  desc: '每帧把位移向量加到实例位置上',
  sockets: [{ key: 'vec', dir: 'in', type: 'vec', label: '位移' }],
  run: function (inputs, inst) {
    if (!inputs.vec) return;
    inst.x += inputs.vec.x;
    inst.y += inputs.vec.y;
  },
});
registerNodeType('setPos', {
  name: '设置位置', category: '运动', flowIn: true, flowOut: true,
  desc: '把实例中心设置到目标位置',
  sockets: [{ key: 'vec', dir: 'in', type: 'vec', label: '位置' }],
  run: function (inputs, inst) {
    if (!inputs.vec) return;
    const obj = state.objects[inst.objectIdx];
    inst.x = inputs.vec.x - (obj ? obj.w / 2 : 0);
    inst.y = inputs.vec.y - (obj ? obj.h / 2 : 0);
  },
});

// ===================================================================
// 扩展节点集（Scratch 式六大类，转为数据流节点）
// ===================================================================

// ---- 事件（黄）----
registerNodeType('whenStart', {
  name: '当开始运行', category: '事件',
  hat: 'start', flowOut: true, // 帽子节点：每帧执行一次右侧连出的执行链
  desc: '执行起点：每帧从右侧连接点开始执行后续链',
  run: function () {},
});
registerNodeType('whenKey', {
  name: '当按下(键)时', category: '事件',
  hat: 'key', flowOut: true, // 帽子节点：按键按下瞬间触发执行链
  desc: '按键按下瞬间从右侧连接点执行一次后续链（边沿检测）',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '按下?' }],
  params: [{ key: 'key', label: '键', type: 'key', def: 'Space' }],
  value: function (inputs, inst, p, st) {
    const down = keys.has(p.key);
    const prev = !!st.keyPrev;
    st.keyPrev = down;
    return (down && !prev) ? 1 : 0;
  },
});

// 当对象被点击时（事件帽子：实例被点击瞬间执行一次链）
registerNodeType('whenClicked', {
  name: '当对象被点击时', category: '事件',
  hat: 'click', flowOut: true,
  desc: '对象（实例）被鼠标点击的瞬间，从右侧连接点执行一次后续链',
});

// ---- 事件：当(音量/计时器)>A / 消息广播 / 计时器 ----
let sceneTimer = 0;      // 全局计时器（秒，节点系统运行期间持续累加）
let volumeLevel = 0;     // 麦克风响度 0-100
let micInited = false;
function ensureMic() {
  if (micInited) return;
  micInited = true;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      (function volLoop() {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        volumeLevel = Math.min(100, Math.sqrt(sum / buf.length) * 100);
        requestAnimationFrame(volLoop);
      })();
    }).catch(function () { volumeLevel = 0; });
  } catch (e) { volumeLevel = 0; }
}
function getVolume() { ensureMic(); return volumeLevel; }
// 广播消息：恢复所有等待该消息的实例，并同步触发所有「当接受到(消息)」链（同步执行 = 广播并等待）
function broadcastMsg(m) {
  for (const it of state.instances) { if (it.st.waitMsg === m) it.st.waitMsgGot = true; }
  for (const it of state.instances) {
    const og = state.objects[it.objectIdx];
    if (!og || !og.graph) continue;
    for (const nd of og.graph.nodes) {
      const dd = NODE_TYPES[nd.type];
      if (dd && dd.hat === 'msg' && (nd.p || {}).msg === m) execFlow(og.graph, nd.id, it, 0);
    }
  }
}
registerNodeType('whenCond', {
  name: '当(音量/计时器)>A', category: '事件', hat: 'cond', flowOut: true,
  desc: '音量（麦克风响度 0-100）或计时器（秒）超过阈值 A 的瞬间触发一次后续链（条件从假变真）',
  params: [
    { key: 'source', label: '来源', type: 'select', def: 'volume', options: function () { return [{ v: 'volume', label: '音量' }, { v: 'timer', label: '计时器' }]; } },
    { key: 'th', label: '阈值', type: 'number', def: 10 },
  ],
  run: function () {},
});
registerNodeType('whenMsg', {
  name: '当接受到(消息B)', category: '事件', hat: 'msg', flowOut: true,
  desc: '当任何「广播(消息B)」执行时，触发一次后续链',
  params: [{ key: 'msg', label: '消息', type: 'text', def: '开始' }],
  run: function () {},
});
registerNodeType('broadcastMsg', {
  name: '广播(消息B)', category: '事件', flowIn: true, flowOut: true,
  desc: '向所有实例广播消息：触发所有「当接受到(消息B)」链，并恢复等待该消息的实例',
  params: [{ key: 'msg', label: '消息', type: 'text', def: '开始' }],
  run: function (inputs, inst, p) { broadcastMsg(p.msg); },
});
registerNodeType('broadcastMsgWait', {
  name: '广播(消息B)并等待', category: '事件', flowIn: true, flowOut: true, flowBlock: 'waitSec',
  desc: '广播消息：触发所有「当接受到(消息B)」链，并等待「等待时间」秒后继续本链（0/不填 = 接收方执行完立即继续）',
  sockets: [{ key: 'sec', dir: 'in', type: 'num', label: '等待时间' }],
  params: [
    { key: 'msg', label: '消息', type: 'text', def: '开始' },
    { key: 'sec2', label: '等待时间', type: 'number', port: 'sec', min: 0, max: 60, step: 0.1, def: 0 },
  ],
  run: function (inputs, inst, p) {
    broadcastMsg(p.msg);
    const v = (inputs.sec === null || inputs.sec === undefined) ? (p.sec2 || 0) : inputs.sec;
    if (v > 0) inst.st.waitUntil = performance.now() + v * 1000;
  },
});
registerNodeType('timerVal', {
  name: '计时器', category: '事件', flowIn: true, flowOut: true, flowBlock: 'waitTimer',
  desc: '等待计时器到达「等待时间」秒后继续本链（计时器从节点系统开始运行起累加；0/不填 = 立即继续）',
  sockets: [{ key: 'sec', dir: 'in', type: 'num', label: '等待时间' }],
  params: [{ key: 'sec2', label: '等待时间', type: 'number', port: 'sec', min: 0, max: 3600, step: 0.1, def: 0 }],
  value: function () { return sceneTimer; },
  run: function () {},
});
// ---- 控制：等待秒 / 等待事件 ----
registerNodeType('waitSec', {
  name: '等待A秒', category: '控制', flowIn: true, flowOut: true, flowBlock: 'waitSec',
  desc: '暂停执行链 A 秒后继续（A 支持连线输入；0 = 不等待）',
  sockets: [{ key: 'sec', dir: 'in', type: 'num', label: '秒' }],
  params: [{ key: 'sec2', label: '秒', type: 'number', port: 'sec', min: 0, max: 60, step: 0.1, def: 1 }],
  run: function (inputs, inst, p) {
    const v = (inputs.sec === null || inputs.sec === undefined) ? (p.sec2 || 0) : inputs.sec;
    if (!inst.st.waitUntil) inst.st.waitUntil = performance.now() + Math.max(0, v) * 1000;
  },
});
registerNodeType('waitMsg', {
  name: '等待(事件A)', category: '控制', flowIn: true, flowOut: true, flowBlock: 'waitMsg',
  desc: '暂停执行链，直到收到消息 A 的广播后继续',
  params: [{ key: 'msg', label: '消息', type: 'text', def: '开始' }],
  run: function (inputs, inst, p) { inst.st.waitMsg = p.msg; inst.st.waitMsgGot = false; },
});

// ---- 节点组引用（组 = 打包好的子图；运行时递归执行组内逻辑） ----
function groupOptions() {
  const opts = [{ v: '', label: '（选择节点组）' }];
  for (const name of Object.keys(GROUPS)) opts.push({ v: name, label: name });
  return opts;
}
registerNodeType('groupRef', {
  name: '节点组', category: '节点组',
  flowIn: true, flowOut: true,
  desc: '引用已保存的节点组：输入/输出端口由组内未连接端口自动生成；运行时每帧递归执行组内逻辑；双击节点可展开编辑组内图',
  params: [{ key: 'group', label: '组', type: 'select', def: '', options: groupOptions }],
  run: function () { /* 组内逻辑已由 evalGraph 顶部统一执行 */ },
});

// ---- 运动（蓝）----
registerNodeType('moveSteps', {
  name: '移动 N 步', category: '运动', flowIn: true, flowOut: true,
  desc: '按当前方向移动 N 步（方向由「左转/右转/面向角度」改变，初始 90°=右）',
  sockets: [{ key: 'n', dir: 'in', type: 'num', label: '步数' }],
  run: function (inputs, inst) {
    const v = inputs.n === null || inputs.n === undefined ? 0 : inputs.n;
    const st = inst.st;
    if (st.dir === undefined) st.dir = 90;
    const rad = st.dir * Math.PI / 180;
    inst.x += Math.sin(rad) * v;
    inst.y -= Math.cos(rad) * v;
  },
});
registerNodeType('turnL', {
  name: '左转', category: '运动', flowIn: true, flowOut: true,
  desc: '方向逆时针转 N 度',
  sockets: [{ key: 'n', dir: 'in', type: 'num', label: '度数' }],
  run: function (inputs, inst) {
    const v = inputs.n === null || inputs.n === undefined ? 0 : inputs.n;
    const st = inst.st;
    if (st.dir === undefined) st.dir = 90;
    st.dir = ((st.dir - v) % 360 + 360) % 360;
  },
});
registerNodeType('turnR', {
  name: '右转', category: '运动', flowIn: true, flowOut: true,
  desc: '方向顺时针转 N 度',
  sockets: [{ key: 'n', dir: 'in', type: 'num', label: '度数' }],
  run: function (inputs, inst) {
    const v = inputs.n === null || inputs.n === undefined ? 0 : inputs.n;
    const st = inst.st;
    if (st.dir === undefined) st.dir = 90;
    st.dir = ((st.dir + v) % 360 + 360) % 360;
  },
});
registerNodeType('changeX', {
  name: 'x 坐标增加', category: '运动', flowIn: true, flowOut: true,
  desc: '把实例 x 坐标增加一个数值（默认用节点上的数值，连了「数值」端口则优先用连线值）',
  sockets: [{ key: 'n', dir: 'in', type: 'num', label: '数值' }],
  params: [{ key: 'v', label: '数值', type: 'number', port: 'n', min: -100, max: 100, step: 1, def: 1 }],
  run: function (inputs, inst, p) {
    const v = inputs.n === null || inputs.n === undefined ? p.v : inputs.n;
    inst.x += v;
  },
});
registerNodeType('changeY', {
  name: 'y 坐标增加', category: '运动', flowIn: true, flowOut: true,
  desc: '把实例 y 坐标增加一个数值（默认用节点上的数值，连了「数值」端口则优先用连线值）',
  sockets: [{ key: 'n', dir: 'in', type: 'num', label: '数值' }],
  params: [{ key: 'v', label: '数值', type: 'number', port: 'n', min: -100, max: 100, step: 1, def: 1 }],
  run: function (inputs, inst, p) {
    const v = inputs.n === null || inputs.n === undefined ? p.v : inputs.n;
    inst.y += v;
  },
});
registerNodeType('setX', {
  name: 'x 坐标设为', category: '运动', flowIn: true, flowOut: true,
  desc: '把实例 x 坐标设为 N',
  sockets: [{ key: 'n', dir: 'in', type: 'num', label: '数值' }],
  run: function (inputs, inst) {
    inst.x = inputs.n === null || inputs.n === undefined ? 0 : inputs.n;
  },
});
registerNodeType('setY', {
  name: 'y 坐标设为', category: '运动', flowIn: true, flowOut: true,
  desc: '把实例 y 坐标设为 N',
  sockets: [{ key: 'n', dir: 'in', type: 'num', label: '数值' }],
  run: function (inputs, inst) {
    inst.y = inputs.n === null || inputs.n === undefined ? 0 : inputs.n;
  },
});
registerNodeType('goRandom', {
  name: '移到随机位置', category: '运动', flowIn: true, flowOut: true,
  desc: '把实例移到可视区域内的随机位置',
  run: function (inputs, inst) {
    const obj = state.objects[inst.objectIdx];
    const w = obj ? obj.w : 1, h = obj ? obj.h : 1;
    const gx0 = Math.floor((0 - state.offsetX) / state.scale);
    const gx1 = Math.floor((cssW() - state.offsetX) / state.scale);
    const gy0 = Math.floor((0 - state.offsetY) / state.scale);
    const gy1 = Math.floor((cssH() - state.offsetY) / state.scale);
    if (gx1 - w > gx0) inst.x = gx0 + Math.random() * (gx1 - w - gx0);
    if (gy1 - h > gy0) inst.y = gy0 + Math.random() * (gy1 - h - gy0);
  },
});
registerNodeType('pointDir', {
  name: '面向角度', category: '运动', flowIn: true, flowOut: true,
  desc: '设置方向为 N 度（0=上，90=右，顺时针）',
  sockets: [{ key: 'n', dir: 'in', type: 'num', label: '角度' }],
  run: function (inputs, inst) {
    const v = inputs.n === null || inputs.n === undefined ? 90 : inputs.n;
    inst.st.dir = ((v) % 360 + 360) % 360;
  },
});
registerNodeType('pointMouse', {
  name: '面向鼠标', category: '运动', flowIn: true, flowOut: true,
  desc: '设置方向朝向鼠标指针',
  run: function (inputs, inst) {
    const obj = state.objects[inst.objectIdx];
    const mx = (state.mouseX - state.offsetX) / state.scale;
    const my = (state.mouseY - state.offsetY) / state.scale;
    const cx = inst.x + (obj ? obj.w / 2 : 0), cy = inst.y + (obj ? obj.h / 2 : 0);
    inst.st.dir = Math.atan2(mx - cx, cy - my) * 180 / Math.PI;
  },
});

// ---- 控制（橙）----
registerNodeType('ifElse', {
  name: '选择(如果/否则)', category: '控制',
  desc: '条件(非0为真)为真时输出 A，否则输出 B',
  sockets: [
    { key: 'cond', dir: 'in', type: 'num', label: '条件' },
    { key: 'a', dir: 'in', type: 'vec', label: 'A' },
    { key: 'b', dir: 'in', type: 'vec', label: 'B' },
    { key: 'out', dir: 'out', type: 'vec', label: '结果' },
  ],
  value: function (inputs) {
    const a = inputs.a, b = inputs.b;
    const cond = inputs.cond === null || inputs.cond === undefined ? 0 : inputs.cond;
    if (cond) return a || { x: 0, y: 0 };
    return b || { x: 0, y: 0 };
  },
});
registerNodeType('repeat', {
  name: '重复执行', category: '控制',
  flow: 'repeat', flowIn: true, flowOut: true,
  desc: '重复执行右侧连出的链：次数未连接=无限（每帧执行一次循环体）；次数已连接=本帧内循环执行 N 次',
  sockets: [{ key: 'n', dir: 'in', type: 'num', label: '次数' }],
});
registerNodeType('ifCond', {
  name: '条件判断', category: '控制',
  flow: 'ifCond', flowIn: true, flowOut: true,
  desc: '任一条件为真时执行右侧连出的链；点节点上的「➕ 条件」可添加更多条件端口',
});
registerNodeType('throttle', {
  name: '节流(每N帧)', category: '控制',
  desc: '每隔 N 帧输出一次输入向量，其余帧输出 0（等效「等待 N 帧」）',
  sockets: [
    { key: 'v', dir: 'in', type: 'vec', label: '输入' },
    { key: 'n', dir: 'in', type: 'num', label: '间隔帧' },
    { key: 'out', dir: 'out', type: 'vec', label: '输出' },
  ],
  value: function (inputs, inst, p, st) {
    const n = Math.max(1, Math.round(inputs.n === null || inputs.n === undefined ? 1 : inputs.n));
    if (st.t === undefined) { st.t = n; return inputs.v || { x: 0, y: 0 }; } // 第 1 帧立即输出
    st.t--;
    if (st.t <= 0) { st.t = n; return inputs.v || { x: 0, y: 0 }; }         // 每 N 帧输出一次
    return { x: 0, y: 0 };
  },
});

// ---- 侦测（蓝绿，输出 0/1）----
registerNodeType('touchEdge', {
  name: '碰到边缘?', category: '侦测',
  desc: '实例超出可视区域时输出 1，否则 0',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '结果' }],
  value: function (inputs, inst) {
    const obj = state.objects[inst.objectIdx];
    const w = obj ? obj.w : 1, h = obj ? obj.h : 1;
    const gx0 = Math.floor((0 - state.offsetX) / state.scale);
    const gx1 = Math.floor((cssW() - state.offsetX) / state.scale);
    const gy0 = Math.floor((0 - state.offsetY) / state.scale);
    const gy1 = Math.floor((cssH() - state.offsetY) / state.scale);
    return (inst.x < gx0 || inst.x + w > gx1 || inst.y < gy0 || inst.y + h > gy1) ? 1 : 0;
  },
});
registerNodeType('randomBool', {
  name: '随机 概率%?', category: '侦测',
  desc: '以给定概率输出 1，否则输出 0',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '结果' }],
  params: [{ key: 'prob', label: '概率%', type: 'number', min: 0, max: 100, step: 1, def: 50 }],
  value: function (inputs, inst, p) { return Math.random() * 100 < p.prob ? 1 : 0; },
});
registerNodeType('mouseNear', {
  name: '鼠标距离<N?', category: '侦测',
  desc: '与鼠标距离小于 N 时输出 1，否则 0',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '结果' }],
  params: [{ key: 'n', label: '距离', type: 'number', min: 1, max: 500, step: 1, def: 20 }],
  value: function (inputs, inst, p) {
    const obj = state.objects[inst.objectIdx];
    const mx = (state.mouseX - state.offsetX) / state.scale;
    const my = (state.mouseY - state.offsetY) / state.scale;
    const cx = inst.x + (obj ? obj.w / 2 : 0), cy = inst.y + (obj ? obj.h / 2 : 0);
    return Math.hypot(mx - cx, my - cy) < p.n ? 1 : 0;
  },
});
registerNodeType('keyDown', {
  name: '键盘按下?', category: '侦测',
  desc: '指定键按住时输出 1，否则 0',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '结果' }],
  params: [{ key: 'key', label: '键', type: 'key', def: 'Space' }],
  value: function (inputs, inst, p) { return keys.has(p.key) ? 1 : 0; },
});

// ---- 运算（绿，数字运算）----
function numOpDef(type, label, fn) {
  registerNodeType(type, {
    name: label, category: '运算',
    desc: '数字运算（未连线的输入按 0）',
    sockets: [
      { key: 'a', dir: 'in', type: 'num', label: 'A' },
      { key: 'b', dir: 'in', type: 'num', label: 'B' },
      { key: 'out', dir: 'out', type: 'num', label: '结果' },
    ],
    value: function (inputs) {
      const a = inputs.a === null || inputs.a === undefined ? 0 : inputs.a;
      const b = inputs.b === null || inputs.b === undefined ? 0 : inputs.b;
      return fn(a, b);
    },
  });
}
numOpDef('numAdd', 'A + B', function (a, b) { return a + b; });
numOpDef('numSub', 'A - B', function (a, b) { return a - b; });
numOpDef('numMul', 'A × B', function (a, b) { return a * b; });
numOpDef('numDiv', 'A ÷ B', function (a, b) { return b === 0 ? 0 : a / b; });
numOpDef('numRand', '随机数 A-B', function (a, b) { return a + Math.random() * (b - a); });
numOpDef('numGt', 'A > B ?', function (a, b) { return a > b ? 1 : 0; });
numOpDef('numLt', 'A < B ?', function (a, b) { return a < b ? 1 : 0; });
numOpDef('numEq', 'A = B ?', function (a, b) { return a === b ? 1 : 0; });
numOpDef('numAnd', 'A 且 B ?', function (a, b) { return (a !== 0 && b !== 0) ? 1 : 0; });
numOpDef('numOr', 'A 或 B ?', function (a, b) { return (a !== 0 || b !== 0) ? 1 : 0; });
// 单目数学（B 忽略）：cos / sin / tan / 平方根 / 绝对值
numOpDef('numCos', 'cos(A)', function (a) { return Math.cos(a); });
numOpDef('numSin', 'sin(A)', function (a) { return Math.sin(a); });
numOpDef('numTan', 'tan(A)', function (a) { return Math.tan(a); });
numOpDef('numSqrt', '√A', function (a) { return Math.sqrt(Math.max(0, a)); });
numOpDef('numAbs', '|A|', function (a) { return Math.abs(a); });

// ---- 变量（橙红）：变量本身是「数字」，通过节点读写，每个实例的值独立 ----
function varOptions() {
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  const opts = [{ v: '', label: '（选择变量）' }];
  if (obj && obj.vars) for (const v of obj.vars) {
    const nm = (v && v.name) || v;
    opts.push({ v: nm, label: nm });
  }
  return opts;
}
registerNodeType('varGet', {
  name: '变量', category: '变量',
  desc: '输出变量当前值（数字或字符串；布尔用 0/1）。左侧【值】入口连接运算节点等输入可改变变量值',
  sockets: [
    { key: 'v', dir: 'in', type: 'num', label: '值' },
    { key: 'out', dir: 'out', type: 'num', label: '值' },
  ],
  params: [{ key: 'var', label: '变量', type: 'select', def: '', options: varOptions }],
  value: function (inputs, inst, p) {
    if (!p.var) return 0;
    if (!inst.st.vars) inst.st.vars = {};
    // 左侧【值】入口有连线输入 → 写入变量（通过运算节点等改变变量值）
    if (inputs.v !== null && inputs.v !== undefined) inst.st.vars[p.var] = inputs.v;
    const v = inst.st.vars[p.var];
    return (typeof v === 'number') ? v : (typeof v === 'string' ? v : 0);
  },
});
registerNodeType('varSet', {
  name: '设置变量', category: '变量', flowIn: true, flowOut: true,
  desc: '把输入值存入变量',
  sockets: [{ key: 'v', dir: 'in', type: 'num', label: '值' }],
  params: [{ key: 'var', label: '变量', type: 'select', def: '', options: varOptions }],
  run: function (inputs, inst, p) {
    if (!p.var) return;
    if (!inst.st.vars) inst.st.vars = {};
    inst.st.vars[p.var] = inputs.v === null || inputs.v === undefined ? 0 : inputs.v;
  },
});
registerNodeType('varChange', {
  name: '变量增加', category: '变量', flowIn: true, flowOut: true,
  desc: '把输入值加到变量上',
  sockets: [{ key: 'v', dir: 'in', type: 'num', label: '增量' }],
  params: [{ key: 'var', label: '变量', type: 'select', def: '', options: varOptions }],
  run: function (inputs, inst, p) {
    if (!p.var) return;
    if (!inst.st.vars) inst.st.vars = {};
    const cur = inst.st.vars[p.var];
    inst.st.vars[p.var] = (typeof cur === 'number' && isFinite(cur) ? cur : 0) +
      (inputs.v === null || inputs.v === undefined ? 0 : inputs.v);
  },
});
// ---- 数组（变量类型：添加数组后可用） ----
function arrOptions() {
  const opts = [{ v: '', label: '（选择数组）' }];
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (obj && obj.arrs) for (const a of obj.arrs) opts.push({ v: (a && a.name) || a, label: (a && a.name) || a });
  return opts;
}
// 取得数组容量（数量），未设置默认 64
function arrSizeOf(obj, name) {
  if (obj && obj.arrs) {
    for (const a of obj.arrs) if ((a && a.name) === name) return (a.size && a.size > 0) ? a.size : 64;
  }
  return 64;
}
// 实例数组：确保存在（从对象初始值复制）
function ensureInstArr(inst, name) {
  if (!inst.st.arrs) inst.st.arrs = {};
  if (!Array.isArray(inst.st.arrs[name])) {
    inst.st.arrs[name] = [];
    const obj = state.objects[inst.objectIdx];
    if (obj && obj.arrs) {
      for (const a of obj.arrs) if ((a && a.name) === name && Array.isArray(a.values)) {
        // 嵌套 [组][索引] 逐组复制（每个实例独立副本）
        inst.st.arrs[name] = a.values.map(function (g) { return Array.isArray(g) ? g.slice() : g; });
      }
    }
  }
  return inst.st.arrs[name];
}
registerNodeType('arrGet', {
  name: '数组值', category: '变量',
  desc: '输出数组指定组/索引的值（数字；未连线组=0、索引=0；不超过容量）',
  sockets: [
    { key: 'grp', dir: 'in', type: 'num', label: '组' },
    { key: 'idx', dir: 'in', type: 'num', label: '索引' },
    { key: 'out', dir: 'out', type: 'num', label: '值' },
  ],
  params: [{ key: 'arr', label: '数组', type: 'select', def: '', options: arrOptions }],
  value: function (inputs, inst, p) {
    if (!p.arr) return 0;
    const a = ensureInstArr(inst, p.arr);
    const cap = arrSizeOf(state.objects[inst.objectIdx], p.arr);
    const g = (inputs.grp === null || inputs.grp === undefined) ? 0 : Math.floor(inputs.grp);
    const i = (inputs.idx === null || inputs.idx === undefined) ? 0 : Math.floor(inputs.idx);
    if (g < 0 || i < 0 || i >= cap) return 0;
    const row = a[g];
    const v = Array.isArray(row) ? row[i] : 0;
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
  },
});
registerNodeType('arrSet', {
  name: '设置数组', category: '变量', flowIn: true, flowOut: true,
  desc: '把值写入数组的指定组/索引（不超过容量；空位填 0）',
  sockets: [
    { key: 'grp', dir: 'in', type: 'num', label: '组' },
    { key: 'idx', dir: 'in', type: 'num', label: '索引' },
    { key: 'v', dir: 'in', type: 'num', label: '值' },
  ],
  params: [{ key: 'arr', label: '数组', type: 'select', def: '', options: arrOptions }],
  run: function (inputs, inst, p) {
    if (!p.arr) return;
    const a = ensureInstArr(inst, p.arr);
    const cap = arrSizeOf(state.objects[inst.objectIdx], p.arr);
    const g = (inputs.grp === null || inputs.grp === undefined) ? 0 : Math.floor(inputs.grp);
    const i = (inputs.idx === null || inputs.idx === undefined) ? 0 : Math.floor(inputs.idx);
    if (g < 0 || i < 0 || i >= cap) return; // 超出容量不写入
    if (!Array.isArray(a[g])) a[g] = [];
    while (a[g].length <= i) a[g].push(0);
    a[g][i] = (inputs.v === null || inputs.v === undefined) ? 0 : inputs.v;
  },
});
registerNodeType('arrLen', {
  name: '数组长度', category: '变量',
  desc: '输出数组的元素个数（不超过容量）',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '长度' }],
  params: [{ key: 'arr', label: '数组', type: 'select', def: '', options: arrOptions }],
  value: function (inputs, inst, p) {
    if (!p.arr) return 0;
    const a = ensureInstArr(inst, p.arr);
    return Array.isArray(a) ? a.length : 0;
  },
});
// 变量监控绘制：由 pixel-canvas.js 的 render() 每帧调用（画布与舞台预览都会显示）
function drawVarMonitors(p) {
  if (!state.instances.length) return;
  ctx.save();
  ctx.setTransform(p, 0, 0, p, 0, 0); // 屏幕像素坐标（文字大小不随画布缩放变化）
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const padX = 6;
  for (const inst of state.instances) {
    const st = inst.st;
    if (!st || !st.showVars || !st.showVars.size) continue;
    const li = inst.layerIdx === undefined ? 0 : inst.layerIdx;
    if (!state.layers[li] || !state.layers[li].visible) continue; // 隐藏图层的实例不显示
    // 实例左上角的世界坐标 → 屏幕坐标
    const sx = inst.x * state.scale + state.offsetX;
    const sy = inst.y * state.scale + state.offsetY;
    let y = sy - 6; // 从实例上方开始，多个变量向上堆叠
    for (const name of st.showVars) {
      const raw = st.vars ? st.vars[name] : undefined;
      const val = (typeof raw === 'number' && isFinite(raw))
        ? (Number.isInteger(raw) ? String(raw) : String(+raw.toFixed(2)))
        : (raw === undefined ? '0' : String(raw));
      const text = name + ' = ' + val;
      const tw = ctx.measureText(text).width;
      const x = sx + 2;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - padX, y - 9, tw + padX * 2, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, x, y);
      y -= 20;
    }
  }
  ctx.restore();
}

// ===================================================================
// 声音（紫）：导入外部音频为「声音A」，节点播放 / 停止 / 控制音量与音调
// 声音文件不随工程 JSON 保存，刷新页面后需重新导入
// ===================================================================
const SOUND_LIB = {};              // 声音名 -> { name, buffer, duration }
const ACTIVE_SOUNDS = new Set();   // 所有正在播放的 AudioBufferSourceNode
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    try { const rp = audioCtx.resume(); if (rp && rp.catch) rp.catch(function () {}); } catch (e) {}
  }
  return audioCtx;
}

// 每实例独立的声音状态 st.sound = { volume, pitch, name, src, gain, playing }
function initInstSound(inst) {
  if (!inst.st.sound) inst.st.sound = { volume: 100, pitch: 100, name: null, src: null, gain: null, playing: false };
  return inst.st.sound;
}

// 播放（同一声音已在播放则不重新开始）；音量/音调取实例当前值
function playSound(inst, name) {
  if (!name) return;
  const clip = SOUND_LIB[name];
  if (!clip) return;
  // 音乐编辑器导入的工程（kind='song'）：走音序调度播放
  if (clip.kind === 'song') { playSong(inst, name, clip); return; }
  const ctx = getAudioCtx();
  if (!ctx) return;
  const s = initInstSound(inst);
  if (s.playing && s.name === name) return;
  const src = ctx.createBufferSource();
  src.buffer = clip.buffer;
  src.playbackRate.value = Math.max(0.01, s.pitch / 100);
  const gain = ctx.createGain();
  gain.gain.value = Math.max(0, Math.min(100, s.volume)) / 100;
  src.connect(gain);
  gain.connect(ctx.destination);
  s.name = name; s.src = src; s.gain = gain; s.playing = true;
  ACTIVE_SOUNDS.add(src);
  src.onended = function () {
    ACTIVE_SOUNDS.delete(src);
    if (s.src === src) {
      s.src = null; s.gain = null; s.playing = false;
      // 「播放声音A等待播放完毕」：播放结束 → 从恢复点继续执行被暂停的链
      const r = s.resume;
      s.resume = null;
      if (r) {
        if (r.inst) r.inst.st.flowPaused = null;
        if (r.nodeId) {
          try {
            if (r.isGroup) execGroupFlow(r.grp, r.nodeId, r.inst, r.ext, 0);
            else execFlow(r.graph, r.nodeId, r.inst, 0);
          } catch (e) { /* 恢复执行失败忽略 */ }
        }
      }
    }
  };
  try { src.start(); } catch (e) {
    ACTIVE_SOUNDS.delete(src);
    s.playing = false; s.src = null; s.gain = null; s.name = null; s.resume = null;
    if (inst.st) inst.st.flowPaused = null;
  }
}

// 停止全部实例正在播放的声音（同时清除「等待播放完毕」的挂起状态）
function stopAllSounds() {
  for (const src of Array.from(ACTIVE_SOUNDS)) { try { src.stop(); } catch (e) {} }
  ACTIVE_SOUNDS.clear();
  for (const inst of state.instances) {
    const s = inst.st && inst.st.sound;
    if (s) { s.playing = false; s.src = null; s.gain = null; s.name = null; s.resume = null; }
    if (inst.st) inst.st.flowPaused = null;
  }
}

// 音量 0~100，音调默认 100（= 原速），即时应用到正在播放的声音
function setInstVolume(inst, v) {
  const s = initInstSound(inst);
  s.volume = Math.max(0, Math.min(100, v));
  if (s.gain) s.gain.gain.value = s.volume / 100;
}
function changeInstVolume(inst, d) { setInstVolume(inst, (inst.st.sound ? inst.st.sound.volume : 100) + d); }
function setInstPitch(inst, v) {
  const s = initInstSound(inst);
  s.pitch = Math.max(1, Math.min(400, v));
  if (s.src) s.src.playbackRate.value = s.pitch / 100;
}
function changeInstPitch(inst, d) { setInstPitch(inst, (inst.st.sound ? inst.st.sound.pitch : 100) + d); }

// 「声音A」下拉选项（节点参数）
function soundOptions() {
  const names = Object.keys(SOUND_LIB);
  const opts = [{ v: '', label: names.length ? '（选择声音）' : '（未导入声音）' }];
  for (const name of names) opts.push({ v: name, label: name });
  return opts;
}

// ---- 声音节点 ----
registerNodeType('soundPlayWait', {
  name: '播放声音A等待播放完毕', category: '声音', flowIn: true, flowOut: true, blockSound: true,
  desc: '播放选中的声音，等它播放完毕后才继续执行后续节点',
  params: [{ key: 'sound', label: '声音A', type: 'select', def: '', options: soundOptions }],
  run: function (inputs, inst, p) { playSound(inst, p.sound); },
});
registerNodeType('soundPlay', {
  name: '播放声音A', category: '声音', flowIn: true, flowOut: true,
  desc: '播放选中的声音（若该声音已在播放则不会重新开始）',
  params: [{ key: 'sound', label: '声音A', type: 'select', def: '', options: soundOptions }],
  run: function (inputs, inst, p) { playSound(inst, p.sound); },
});
registerNodeType('soundStopAll', {
  name: '停止所有声音', category: '声音', flowIn: true, flowOut: true,
  desc: '立即停止所有实例正在播放的声音',
  run: function () { stopAllSounds(); },
});
registerNodeType('soundVolUp', {
  name: '将音量增加B', category: '声音', flowIn: true, flowOut: true,
  desc: '把本实例的音量增加 B（音量范围 0~100）',
  sockets: [{ key: 'b', dir: 'in', type: 'num', label: 'B' }],
  params: [{ key: 'v', label: 'B', type: 'number', port: 'b', min: -100, max: 100, step: 1, def: 10 }],
  run: function (inputs, inst, p) {
    changeInstVolume(inst, inputs.b === null || inputs.b === undefined ? p.v : inputs.b);
  },
});
registerNodeType('soundVolSet', {
  name: '将音量设置为B', category: '声音', flowIn: true, flowOut: true,
  desc: '把本实例的音量设置为 B（音量范围 0~100）',
  sockets: [{ key: 'b', dir: 'in', type: 'num', label: 'B' }],
  params: [{ key: 'v', label: 'B', type: 'number', port: 'b', min: 0, max: 100, step: 1, def: 100 }],
  run: function (inputs, inst, p) {
    setInstVolume(inst, inputs.b === null || inputs.b === undefined ? p.v : inputs.b);
  },
});
registerNodeType('soundPitchSet', {
  name: '将音调设置为B', category: '声音', flowIn: true, flowOut: true,
  desc: '把本实例的音调设置为 B（默认 100 = 原速，越大音调越高/播放越快）',
  sockets: [{ key: 'b', dir: 'in', type: 'num', label: 'B' }],
  params: [{ key: 'v', label: 'B', type: 'number', port: 'b', min: 1, max: 400, step: 1, def: 100 }],
  run: function (inputs, inst, p) {
    setInstPitch(inst, inputs.b === null || inputs.b === undefined ? p.v : inputs.b);
  },
});
registerNodeType('soundPitchUp', {
  name: '将音调增加B', category: '声音', flowIn: true, flowOut: true,
  desc: '把本实例的音调增加 B',
  sockets: [{ key: 'b', dir: 'in', type: 'num', label: 'B' }],
  params: [{ key: 'v', label: 'B', type: 'number', port: 'b', min: -100, max: 400, step: 1, def: 10 }],
  run: function (inputs, inst, p) {
    changeInstPitch(inst, inputs.b === null || inputs.b === undefined ? p.v : inputs.b);
  },
});

// 导入外部音频文件（mp3 / wav / ogg / m4a 等）为「声音A」
function importSoundFile(file) {
  if (!/^audio\//i.test(file.type) && !/\.(mp3|wav|ogg|oga|m4a|aac|flac|webm)$/i.test(file.name)) {
    alert('请选择音频文件（mp3 / wav / ogg / m4a / flac 等）。');
    return;
  }
  const name = file.name.replace(/\.[^.]+$/, '') || ('声音' + (Object.keys(SOUND_LIB).length + 1));
  const fr = new FileReader();
  fr.onload = function () {
    const ctx = getAudioCtx();
    if (!ctx) { alert('当前浏览器不支持 Web Audio，无法导入声音。'); return; }
    ctx.decodeAudioData(fr.result).then(function (buffer) {
      // 重名覆盖：先停止所有正在播放旧声音的实例，避免旧音频继续播 / 继续阻塞等待节点
      if (SOUND_LIB[name]) {
        for (const inst of state.instances) {
          const s = inst.st && inst.st.sound;
          if (s && s.name === name && s.src) {
            try { s.src.stop(); } catch (e) {}
            s.playing = false; s.src = null; s.gain = null; s.name = null; s.resume = null;
            if (inst.st) inst.st.flowPaused = null;
          }
        }
      }
      SOUND_LIB[name] = { name: name, buffer: buffer, duration: buffer.duration };
      renderSoundUI();
      renderNodeGraph();
      alert('已导入声音「' + name + '」（' + buffer.duration.toFixed(1) + ' 秒）。\n可在「声音」分类节点的「声音A」下拉中选择；声音不随工程文件保存，刷新后需重新导入。');
    }).catch(function () {
      alert('解码失败：' + file.name + '（请换成 mp3 / wav / ogg 等常见格式）。');
    });
  };
  fr.onerror = function () { alert('读取文件失败。'); };
  fr.readAsArrayBuffer(file);
}

// 删除声音（同时停止正在播放它的实例）
function deleteSound(name) {
  if (!SOUND_LIB[name]) return;
  for (const inst of state.instances) {
    const s = inst.st && inst.st.sound;
    if (s && s.name === name && s.src) {
      try { s.src.stop(); } catch (e) {}
      s.playing = false; s.src = null; s.gain = null; s.name = null; s.resume = null;
      if (inst.st) inst.st.flowPaused = null;
    }
  }
  delete SOUND_LIB[name];
  renderSoundUI();
  renderNodeGraph();
}

// ===================================================================
// 音乐编辑器工程（歌曲）支持：
// 「🎵 导入音频工程」导入音乐编辑器（所有网页/音乐编辑器/音乐编辑器.html）导出的
// JSON 工程文件，注册进 SOUND_LIB（kind='song'）。播放时按工程 BPM 用合成器实时
// 调度音符（不渲染成 AudioBuffer），与普通声音一样用「播放声音A」等节点触发。
// 合成器移植自音乐编辑器内置乐器（piano / synth8 / bass / drums）。
// ===================================================================
const SONG_SYNTHS = {
  piano: function (ctx, dest, trk, row, when, vel, srcs) {
    const f = 440 * Math.pow(2, ((trk.startOctave + 1) * 12 + row - 69) / 12);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = songEnvGain(ctx, when, 0.42 * vel, 0.42);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + 0.5);
    srcs.push(o);
  },
  synth8: function (ctx, dest, trk, row, when, vel, srcs) {
    const f = 440 * Math.pow(2, ((trk.startOctave + 1) * 12 + row - 69) / 12);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const g = songEnvGain(ctx, when, 0.28 * vel, 0.18);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + 0.22);
    srcs.push(o);
  },
  bass: function (ctx, dest, trk, row, when, vel, srcs) {
    const f = 440 * Math.pow(2, ((trk.startOctave + 1) * 12 + row - 69) / 12);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 900;
    const g = songEnvGain(ctx, when, 0.35 * vel, 0.28);
    o.connect(filt); filt.connect(g); g.connect(dest);
    o.start(when); o.stop(when + 0.35);
    srcs.push(o);
  },
  drums: function (ctx, dest, trk, row, when, vel, srcs) {
    const t = when;
    switch (row) {
      case 0: { // Kick
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(150, t);
        o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
        const g = songEnvGain(ctx, t, 0.9 * vel, 0.24);
        o.connect(g); g.connect(dest);
        o.start(t); o.stop(t + 0.3);
        srcs.push(o);
        break;
      }
      case 1: { // Snare
        const n = songNoiseSource(ctx, t, 0.18);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
        const g = songEnvGain(ctx, t, 0.55 * vel, 0.16);
        n.connect(bp); bp.connect(g); g.connect(dest);
        srcs.push(n);
        break;
      }
      case 2: { // HiHat
        const n = songNoiseSource(ctx, t, 0.05);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 7000;
        const g = songEnvGain(ctx, t, 0.28 * vel, 0.045);
        n.connect(hp); hp.connect(g); g.connect(dest);
        srcs.push(n);
        break;
      }
      case 3: { // Open HiHat
        const n = songNoiseSource(ctx, t, 0.3);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 6500;
        const g = songEnvGain(ctx, t, 0.22 * vel, 0.24);
        n.connect(hp); hp.connect(g); g.connect(dest);
        srcs.push(n);
        break;
      }
      case 4: { // Clap
        for (let i = 0; i < 3; i++) {
          const wt = t + i * 0.012;
          const n = songNoiseSource(ctx, wt, 0.08);
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 1.2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, wt);
          g.gain.exponentialRampToValueAtTime(0.4 * vel, wt + 0.005);
          g.gain.exponentialRampToValueAtTime(0.0001, wt + 0.05);
          n.connect(bp); bp.connect(g); g.connect(dest);
          srcs.push(n);
        }
        break;
      }
      case 5: { // Tom
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(110, t + 0.2);
        const g = songEnvGain(ctx, t, 0.5 * vel, 0.26);
        o.connect(g); g.connect(dest);
        o.start(t); o.stop(t + 0.32);
        srcs.push(o);
        break;
      }
    }
  },
};

let songNoiseBuf = null;
function getSongNoise(ctx) {
  if (!songNoiseBuf) {
    const len = ctx.sampleRate * 2;
    songNoiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = songNoiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return songNoiseBuf;
}
function songNoiseSource(ctx, when, dur) {
  const src = ctx.createBufferSource();
  src.buffer = getSongNoise(ctx);
  src.loop = true;
  src.start(when);
  src.stop(when + dur);
  return src;
}
function songEnvGain(ctx, when, peak, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  return g;
}

// 静音时钟缓冲：作为歌曲总时长的结束信号（onended → 恢复等待链 / 清理状态）
function makeSilentBuffer(ctx, dur) {
  const len = Math.max(1, Math.ceil(ctx.sampleRate * Math.max(0.05, dur)));
  return ctx.createBuffer(1, len, ctx.sampleRate); // 全 0，静音
}

// 按工程 BPM 实时调度音符播放（每实例独立音量/音调；音调 = 播放速度）
function playSong(inst, name, clip) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const s = initInstSound(inst);
  if (s.playing && s.name === name) return;
  const speed = Math.max(0.01, s.pitch / 100);
  const stepD = 60 / clip.song.bpm / 4 / speed;
  const steps = clip.song.beatsPerBar * clip.song.bars * 4;
  const dur = steps * stepD;
  const t0 = ctx.currentTime + 0.06;
  const gain = ctx.createGain();
  gain.gain.value = s.volume / 100;
  gain.connect(ctx.destination);
  const clock = ctx.createBufferSource();
  clock.buffer = makeSilentBuffer(ctx, dur);
  clock.connect(gain); // 静音：仅作为结束时钟
  ACTIVE_SOUNDS.add(clock);
  const anySolo = clip.song.tracks.some(function (t) { return t.solo; });
  for (const trk of clip.song.tracks) {
    if (trk.muted) continue;
    if (anySolo && !trk.solo) continue;
    const def = SONG_SYNTHS[trk.instrument];
    if (!def) continue;
    const trkCells = trk.cells || [];
    for (const key of trkCells) {
      const parts = String(key).split(',');
      if (parts.length < 2) continue;
      const r = parseInt(parts[0], 10);
      const st = parseInt(parts[1], 10);
      if (isNaN(r) || isNaN(st) || st < 0 || st >= steps) continue;
      const srcs = [];
      def(ctx, gain, trk, r, t0 + st * stepD, 0.9, srcs);
      for (const src of srcs) ACTIVE_SOUNDS.add(src);
    }
  }
  s.name = name; s.src = clock; s.gain = gain; s.playing = true;
  clock.onended = function () {
    ACTIVE_SOUNDS.delete(clock);
    if (s.src === clock) {
      s.src = null; s.gain = null; s.playing = false;
      // 「播放声音A等待播放完毕」：歌曲结束 → 从恢复点继续执行被暂停的链
      const r = s.resume;
      s.resume = null;
      if (r) {
        if (r.inst) r.inst.st.flowPaused = null;
        if (r.nodeId) {
          try {
            if (r.isGroup) execGroupFlow(r.grp, r.nodeId, r.inst, r.ext, 0);
            else execFlow(r.graph, r.nodeId, r.inst, 0);
          } catch (e) { /* 恢复执行失败忽略 */ }
        }
      }
    }
  };
  try { clock.start(t0); } catch (e) {
    ACTIVE_SOUNDS.delete(clock);
    s.playing = false; s.src = null; s.gain = null; s.name = null; s.resume = null;
    if (inst.st) inst.st.flowPaused = null;
  }
}

// 导入音乐编辑器导出的 JSON 工程：自动用 OfflineAudioContext 渲染成 WAV（AudioBuffer），
// 以普通声音（kind='buffer'）注册，播放行为与导入的 mp3/wav 文件完全一致
// （音调 playbackRate 变速变调、等待播放完毕等）。渲染失败时降级为实时合成（kind='song'）。
function importSongFile(file) {
  const fr = new FileReader();
  fr.onload = function () {
    let data;
    try { data = JSON.parse(String(fr.result).replace(/^\uFEFF/, '')); } catch (e) { alert('不是有效的 JSON 文件。'); return; }
    if (!data || data.app !== 'music-editor' || !Array.isArray(data.tracks)) {
      alert('不是音乐编辑器导出的工程文件（缺少 app: "music-editor"）。\n请先在音乐编辑器中编辑并「📄 导出工程」，再导入此 JSON。');
      return;
    }
    const name = file.name.replace(/\.json$/i, '') || ('歌曲' + (Object.keys(SOUND_LIB).length + 1));
    const bpm = clamp(parseInt(data.bpm, 10) || 120, 40, 240);
    const beatsPerBar = parseInt(data.beatsPerBar, 10) || 4;
    const bars = clamp(parseInt(data.bars, 10) || 2, 1, 4);
    const steps = beatsPerBar * bars * 4;
    const tracks = [];
    for (const t of data.tracks) {
      if (!SONG_SYNTHS[t.instrument]) continue;
      const cells = [];
      for (const key of t.cells || []) {
        const parts = String(key).split(',');
        if (parts.length === 2) cells.push(parts[0] + ',' + parts[1]);
      }
      tracks.push({
        name: t.name || '', instrument: t.instrument,
        startOctave: t.startOctave || 3, octaves: t.octaves || 2,
        muted: !!t.muted, solo: !!t.solo, cells: cells,
      });
    }
    if (!tracks.length) { alert('工程里没有可播放的轨道（乐器类型不被支持）。'); return; }
    const song = { bpm: bpm, beatsPerBar: beatsPerBar, bars: bars, tracks: tracks };
    // 自动转码为 WAV 后再导入
    renderSongToBuffer(song, data.volume).then(function (buf) {
      stopInstancesOf(name);
      SOUND_LIB[name] = { name: name, buffer: buf, duration: buf.duration, src: 'song' };
      renderSoundUI();
      renderNodeGraph();
      alert('已导入音频工程「' + name + '」（自动转码为 WAV：' + buf.duration.toFixed(1) + ' 秒 · ' + tracks.length + ' 轨）。\n可在「声音」分类节点的「声音A」下拉中选择；声音不随工程文件保存，刷新后需重新导入。');
    }).catch(function (err) {
      // 降级：浏览器不支持离线渲染 → 注册为实时合成歌曲
      const duration = steps * (60 / bpm / 4);
      stopInstancesOf(name);
      SOUND_LIB[name] = { name: name, kind: 'song', song: song, duration: duration };
      renderSoundUI();
      renderNodeGraph();
      alert('已导入音频工程「' + name + '」（' + tracks.length + ' 轨 · ' + duration.toFixed(1) + ' 秒）。\n离线转码不可用（' + (err && err.message ? err.message : '未知原因') + '），已改用实时合成播放。');
    });
  };
  fr.onerror = function () { alert('读取文件失败。'); };
  fr.readAsText(file);
}

// 停止所有正在播放名为 name 的声音/歌曲的实例（重名覆盖前调用）
function stopInstancesOf(name) {
  if (!SOUND_LIB[name]) return;
  for (const inst of state.instances) {
    const s = inst.st && inst.st.sound;
    if (s && s.name === name && s.src) {
      try { s.src.stop(); } catch (e) {}
      s.playing = false; s.src = null; s.gain = null; s.name = null; s.resume = null;
      if (inst.st) inst.st.flowPaused = null;
    }
  }
}

// 用 OfflineAudioContext 把工程渲染为 AudioBuffer（= WAV 数据）；
// 音乐编辑器里的音量设置烘焙进波形，音符按 BPM 调度到离线路由
function renderSongToBuffer(song, volume) {
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC) return Promise.reject(new Error('浏览器不支持 OfflineAudioContext'));
  try {
    const sr = 44100;
    const stepD = 60 / song.bpm / 4;
    const steps = song.beatsPerBar * song.bars * 4;
    const dur = steps * stepD;
    const tail = 0.5; // 尾部留白，避免最后一个音符被截断
    const off = new AC(2, Math.ceil(sr * (dur + tail)), sr);
    const master = off.createGain();
    master.gain.value = clamp(parseInt(volume, 10) || 80, 0, 100) / 100;
    master.connect(off.destination);
    const anySolo = song.tracks.some(function (t) { return t.solo; });
    for (const trk of song.tracks) {
      if (trk.muted) continue;
      if (anySolo && !trk.solo) continue;
      const def = SONG_SYNTHS[trk.instrument];
      if (!def) continue;
      for (const key of trk.cells) {
        const parts = String(key).split(',');
        if (parts.length < 2) continue;
        const r = parseInt(parts[0], 10);
        const st = parseInt(parts[1], 10);
        if (isNaN(r) || isNaN(st) || st < 0 || st >= steps) continue;
        def(off, master, trk, r, 0.05 + st * stepD, 0.9, []);
      }
    }
    return off.startRendering().then(function (buffer) { return buffer; });
  } catch (e) {
    // 渲染过程任何同步错误都不静默：转为 reject，由调用方降级并提示原因
    return Promise.reject(e);
  }
}

// 渲染小面板 / 全屏编辑器里的声音列表
function renderSoundUI() {
  const names = Object.keys(SOUND_LIB);
  for (const listEl of [soundListEl, scratchSoundListEl]) {
    listEl.innerHTML = '';
    if (!names.length) {
      const note = document.createElement('span');
      note.className = 'n-note';
      note.style.fontSize = '11px'; // 空列表提示用小号字，弱化视觉
      note.textContent = '（未导入声音）';
      listEl.appendChild(note);
      continue;
    }
    for (const name of names) {
      const clip = SOUND_LIB[name];
      const item = document.createElement('div');
      item.className = 'sound-item';
      const nm = document.createElement('span');
      nm.textContent = (clip.kind === 'song' || clip.src === 'song' ? '🎵 ' : '🔊 ') + name + '（' + clip.duration.toFixed(1) + 's）';
      nm.title = (clip.kind === 'song' || clip.src === 'song' ? '歌曲：' : '声音：') + name + '（' + clip.duration.toFixed(1) + ' 秒）'; // 名称超宽省略时悬浮显示全名
      item.appendChild(nm);
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '×';
      del.title = '删除声音「' + name + '」';
      del.addEventListener('click', (function (n) { return function () { deleteSound(n); }; })(name));
      item.appendChild(del);
      listEl.appendChild(item);
    }
  }
}
const soundListEl = document.getElementById('soundList');
const scratchSoundListEl = document.getElementById('scratchSoundList');
const soundFileInput = document.getElementById('soundFileInput');

// ===================================================================
// 对象模板
// ===================================================================
let nextObjId = 1, nextInstId = 1, nextNodeId = 1;
const objCanvases = new Map(); // 对象 id -> 模板像素渲染缓存 canvas

function ensureGraph(obj) {
  if (!obj.graph) obj.graph = { nodes: [], conns: [], flows: [] }; // flows: 执行流连线（from→to）
  return obj.graph;
}

// ===================================================================
// 节点组（子图）系统：把一组已连线的节点打包为可复用「节点组」，
// 可整体作为一个节点使用、可展开编辑、可导出/导入为 JS 文件
// ===================================================================
let GROUPS = {};            // 组名 → { name, graph, inputs, outputs }
let selNodeSet = new Set(); // 节点多选集合（框选打包用）
let graphSelStart = null, graphSelEnd = null; // 框选矩形（屏幕坐标）
let graphEditGroup = null;  // 正在展开编辑的组名（null = 主图）

// 注册节点组（供 JS 文件 registerNodeGroup(...) 调用，也用于打包）
function registerNodeGroup(name, def) {
  if (!def || !def.graph) return;
  const io = deriveGroupIO(def.graph);
  GROUPS[name] = { name: name, graph: def.graph, inputs: io.inputs, outputs: io.outputs };
}
// 组接口自动推导：
//  inputs  = 组内未被内部连线覆盖的输入端口（对外输入）
//  outputs = 组内未被任何连线消费的输出端口（对外输出）
// 每个端口用外部唯一键 i0/i1… / o0/o1…（组内可能多个同名端口）
function deriveGroupIO(g) {
  const inputs = [], outputs = [];
  const consumed = new Set();
  for (const c of (g.conns || [])) consumed.add(c.from + '::' + c.fromSock);
  for (const n of g.nodes) {
    const def = NODE_TYPES[n.type];
    if (!def) continue;
    for (const s of (def.sockets || [])) {
      if (s.dir === 'in') {
        if (!findConn(g, n.id, s.key)) inputs.push({ extKey: 'i' + inputs.length, nodeId: n.id, sockKey: s.key, type: s.type, label: (def.name || '') + '·' + s.label });
      } else if (s.dir === 'out') {
        if (!consumed.has(n.id + '::' + s.key)) outputs.push({ extKey: 'o' + outputs.length, nodeId: n.id, sockKey: s.key, type: s.type, label: (def.name || '') + '·' + s.label });
      }
    }
  }
  return { inputs: inputs, outputs: outputs };
}
// 当前正在编辑的图（展开组编辑时返回组内图，否则返回对象主图）
function currentGraph() {
  if (graphEditGroup && GROUPS[graphEditGroup]) return GROUPS[graphEditGroup].graph;
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  return obj ? ensureGraph(obj) : null;
}

// ---- 组执行引擎（在组内图求值，与主图同构，未连线输入端口用外部输入 ext） ----
// ext = { 'nodeId::sockKey': 值 }（组节点外部连线注入）
function groupNodeInputs(grp, nodeId, inst, ext, cache, visiting) {
  const g = grp.graph;
  const inputs = {};
  const node = g.nodes.find(function (n) { return n.id === nodeId; });
  if (!node) return inputs;
  const def = NODE_TYPES[node.type];
  if (def && def.sockets) {
    for (const sock of def.sockets) {
      if (sock.dir !== 'in') continue;
      const src = findConn(g, nodeId, sock.key);
      if (src) inputs[sock.key] = groupNodeValue(grp, src.from, inst, ext, cache, visiting, src.fromSock);
      else if (ext && ext[nodeId + '::' + sock.key] !== undefined) inputs[sock.key] = ext[nodeId + '::' + sock.key];
      else inputs[sock.key] = null;
    }
  }
  if (node.type === 'ifCond' && node.p && node.p.conds) {
    for (const ck of node.p.conds) {
      const src = findConn(g, nodeId, ck);
      if (src) inputs[ck] = groupNodeValue(grp, src.from, inst, ext, cache, visiting, src.fromSock);
      else if (ext && ext[nodeId + '::' + ck] !== undefined) inputs[ck] = ext[nodeId + '::' + ck];
      else inputs[ck] = null;
    }
  }
  return inputs;
}
function groupNodeValue(grp, nodeId, inst, ext, cache, visiting, fromSock) {
  if (cache.has(nodeId)) return cache.get(nodeId);
  if (visiting.has(nodeId)) return null;
  const g = grp.graph;
  const node = g.nodes.find(function (n) { return n.id === nodeId; });
  if (!node) { cache.set(nodeId, null); return null; }
  const def = NODE_TYPES[node.type];
  if (!def || !def.value) { cache.set(nodeId, null); return null; }
  visiting.add(nodeId);
  const inputs = groupNodeInputs(grp, nodeId, inst, ext, cache, visiting);
  let val = null;
  try { val = def.value(inputs, inst, node.p || {}, inst.st, fromSock); } catch (e) { val = null; }
  visiting.delete(nodeId);
  cache.set(nodeId, val);
  if (def.displayVal) updateNodeDisplay(node, val);
  return val;
}
function execGroupFlow(grp, nodeId, inst, ext, depth) {
  if (depth > 500) return;
  const g = grp.graph;
  const node = g.nodes.find(function (n) { return n.id === nodeId; });
  if (!node) return;
  const def = NODE_TYPES[node.type];
  if (!def) return;
  const cache = new Map(), visiting = new Set();
  const inputs = groupNodeInputs(grp, nodeId, inst, ext, cache, visiting);
  if (def.run) { try { def.run(inputs, inst, node.p || {}, inst.st); } catch (e) { /* 节点错误跳过 */ } }
  // 【显示值】类节点挂在动作链上：显示输入值
  if (def.displayVal) updateNodeDisplay(node, inputs.v);
  // 阻塞节点（组内「播放声音A等待播放完毕」）：暂停组内链，播完由 onended 恢复
  if (def.blockSound) {
    const s = inst.st.sound;
    const want = (node.p || {}).sound;
    if (want && s && s.name === want && s.playing) {
      inst.st.flowPaused = { graph: grp.graph, nodeId: findFlow(g, node.id), inst: inst, isGroup: true, grp: grp, ext: ext };
      s.resume = inst.st.flowPaused;
      return;
    }
  }
  const next = findFlow(g, node.id);
  if (def.flow === 'repeat') {
    const raw = inputs.n;
    const n = (raw === null || raw === undefined) ? Infinity : Math.max(0, Math.round(raw));
    if (!isFinite(n)) { if (next) execGroupFlow(grp, next, inst, ext, depth + 1); }
    else { for (let i = 0; i < n; i++) { if (next) execGroupFlow(grp, next, inst, ext, depth + 1); } }
  } else if (def.flow === 'ifCond') {
    let any = false;
    for (const ck of (node.p.conds || [])) { if (inputs[ck]) { any = true; break; } }
    if (any && next) execGroupFlow(grp, next, inst, ext, depth + 1);
  } else if (next) {
    execGroupFlow(grp, next, inst, ext, depth + 1);
  }
}
// 执行组内图（与 evalGraph 同构）：组内 hats 每帧触发 / 无流时执行全部动作节点
function evalGroupGraph(grp, ext, inst) {
  const g = grp.graph;
  if (!g) return;
  if (inst.st.flowPaused && inst.st.flowPaused.graph === g) return; // 「等待播放完毕」暂停中
  const hasFlow = g.flows && g.flows.length > 0;
  if (!hasFlow) {
    for (const node of g.nodes) {
      const def = NODE_TYPES[node.type];
      if (!def || !def.run) continue;
      try { def.run(groupNodeInputs(grp, node.id, inst, ext, new Map(), new Set()), inst, node.p || {}, inst.st); } catch (e) { /* 跳过 */ }
    }
    return;
  }
  for (const node of g.nodes) {
    const def = NODE_TYPES[node.type];
    if (!def || !def.hat) continue;
    if (def.hat === 'start') {
      execGroupFlow(grp, node.id, inst, ext, 0);
    } else if (def.hat === 'key') {
      const down = keys.has((node.p || {}).key);
      const prev = !!inst.st.hatKey;
      inst.st.hatKey = down;
      if (down && !prev) execGroupFlow(grp, node.id, inst, ext, 0);
    } else if (def.hat === 'click') {
      if (inst.st.clicked) { inst.st.clicked = false; execGroupFlow(grp, node.id, inst, ext, 0); }
    }
  }
}
// 收集组节点（groupRef）的外部输入：主图连线 → 组内 'nodeId::sockKey'
function groupExtInputs(grp, groupNode, inst, g) {
  const ext = {};
  for (const pin of grp.inputs) {
    const src = findConn(g, groupNode.id, pin.extKey);
    ext[pin.nodeId + '::' + pin.sockKey] = src ? nodeValue(g, src.from, inst, new Map(), new Set(), src.fromSock) : null;
  }
  return ext;
}
// 求组节点的某个输出端口值（外部连线消费组输出时调用）
function groupOutValue(grp, extKey, groupNode, inst, g) {
  const out = grp.outputs.find(function (o) { return o.extKey === extKey; });
  if (!out) return null;
  const ext = groupExtInputs(grp, groupNode, inst, g);
  return groupNodeValue(grp, out.nodeId, inst, ext, new Map(), new Set(), out.sockKey);
}
// 从图层提取矩形区域（含内容裁剪）：返回 { pixels: Map<"dx,dy",color>, w, h, ox, oy }
function extractRegion(li, x0, y0, x1, y1) {
  const src = state.layers[li].pixels;
  const list = [];
  for (const [key, col] of src) {
    const i = key.indexOf(',');
    const x = +key.slice(0, i), y = +key.slice(i + 1);
    if ((x0 === -Infinity || x >= x0) && (x1 === Infinity || x <= x1) &&
        (y0 === -Infinity || y >= y0) && (y1 === Infinity || y <= y1)) {
      list.push([x, y, col]);
    }
  }
  if (list.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of list) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  const rel = new Map();
  for (const p of list) rel.set((p[0] - minX) + ',' + (p[1] - minY), p[2]);
  return { pixels: rel, w: maxX - minX + 1, h: maxY - minY + 1, ox: minX, oy: minY };
}
function buildObjectCanvas(obj) {
  const c = document.createElement('canvas');
  c.width = obj.w; c.height = obj.h;
  const cc = c.getContext('2d');
  for (const [key, col] of obj.pixels) {
    const i = key.indexOf(',');
    cc.fillStyle = col;
    cc.fillRect(+key.slice(0, i), +key.slice(i + 1), 1, 1);
  }
  return c;
}
function createObject(obj) {
  // 新建对象时自动放一个「当开始运行」帽子节点（只在此处添加一次，打开编辑器不会重复生成）
  obj.graph = { nodes: [{ id: nextNodeId++, type: 'whenStart', p: {}, x: 30, y: 30 }], conns: [] };
  obj.vars = []; // 对象级变量列表（每个实例有独立的值）
  obj.arrs = []; // 对象级数组变量列表
  state.objects.push(obj);
  objCanvases.set(obj.id, buildObjectCanvas(obj));
  renderNodePanel();
  requestRender();
}

// 「框选添加节点」松手：剪切活动图层框选区域的像素 → 对象模板（可撤销）
function commitNodeSelect() {
  if (!nodeSelStart || !nodeSelEnd) return;
  const x0 = Math.min(nodeSelStart.x, nodeSelEnd.x), y0 = Math.min(nodeSelStart.y, nodeSelEnd.y);
  const x1 = Math.max(nodeSelStart.x, nodeSelEnd.x), y1 = Math.max(nodeSelStart.y, nodeSelEnd.y);
  const li = state.activeLayer;
  const reg = extractRegion(li, x0, y0, x1, y1);
  if (!reg) { alert('框选区域内没有像素。'); return; }
  const keysToDel = [];
  for (const key of state.layers[li].pixels.keys()) {
    const i = key.indexOf(',');
    const x = +key.slice(0, i), y = +key.slice(i + 1);
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) keysToDel.push(key);
  }
  beginStroke();
  for (const key of keysToDel) {
    recordCell(key, state.layers[li].pixels.get(key), null, li);
    state.layers[li].pixels.delete(key);
  }
  endStroke();
  markDirtyRect(x0, y0, x1, y1, li);
  const oid = nextObjId++;
  const idx = state.objects.length; // 新对象将 push 到末尾
  createObject({
    id: oid, name: '对象 ' + oid,
    kind: 'selection', srcLayer: li,
    w: reg.w, h: reg.h, srcX: reg.ox, srcY: reg.oy,
    pixels: reg.pixels,
  });
  fillNodeCatSelect();
  window.__nodeEditorOpen = true;
  els.nodePanel.classList.add('open');
  raiseSidePanel(els.nodePanel);
  selectObject(idx); // 自动选中新对象，方便直接加节点 / 建变量 / 实例化
  requestRender();
}

// 图层「添加节点」：把整个图层的像素内容做成对象模板（不剪切原图层）
function createObjectFromLayer(li) {
  if (!state.layers[li]) return;
  const existing = state.objects.find(function (o) { return o.kind === 'layer' && o.srcLayer === li; });
  if (existing) {
    selObjIdx = state.objects.indexOf(existing);
    fillNodeCatSelect();
    renderNodePanel();
    window.__nodeEditorOpen = true;
  els.nodePanel.classList.add('open');
  raiseSidePanel(els.nodePanel);
    return;
  }
  const reg = extractRegion(li, -Infinity, -Infinity, Infinity, Infinity);
  if (!reg) { alert('该图层没有像素内容。'); return; }
  createObject({
    id: nextObjId++, name: state.layers[li].name,
    kind: 'layer', srcLayer: li,
    w: reg.w, h: reg.h, srcX: reg.ox, srcY: reg.oy,
    pixels: reg.pixels,
  });
  selObjIdx = state.objects.length - 1;
  fillNodeCatSelect();
  window.__nodeEditorOpen = true;
  els.nodePanel.classList.add('open');
  raiseSidePanel(els.nodePanel);
  if (typeof renderLayerPanel === 'function') renderLayerPanel(); // 更新图层图标
}

// ===================================================================
// 实例（归属图层：实例化到当前活动图层；隐藏图层 → 实例停止且不渲染）
// ===================================================================
let selInstId = -1; // 画布/列表中选中的实例 id（-1 未选中）

function instantiateObject(objIdx) {
  const obj = state.objects[objIdx];
  if (!obj) return;
  const li = state.activeLayer;
  // 实例的 st 复制对象初始数组值与变量默认值（每个实例独立）
  const st = {};
  if (obj.vars && obj.vars.length) {
    st.vars = {};
    for (const v of obj.vars) if (v && (v.name || typeof v === 'string')) st.vars[(v.name || v)] = (v && v.value !== undefined) ? v.value : 0;
  }
  if (obj.arrs && obj.arrs.length) {
    st.arrs = {};
    for (const a of obj.arrs) if (a && a.name) st.arrs[a.name] = Array.isArray(a.values) ? a.values.map(function (g) { return Array.isArray(g) ? g.slice() : g; }) : [];
  }
  state.instances.push({
    id: nextInstId++, objectIdx: objIdx,
    x: obj.srcX, y: obj.srcY, st: st, layerIdx: li,
  });
  if (state.layers[li] && !state.layers[li].visible) { // 隐藏图层自动显示，保证实例可见
    state.layers[li].visible = true;
    if (typeof renderLayerPanel === 'function') renderLayerPanel();
  }
  selInstId = state.instances[state.instances.length - 1].id;
  renderNodePanel();
  requestRender();
}
function deleteInstance(id) {
  const i = state.instances.findIndex(function (it) { return it.id === id; });
  if (i >= 0) {
    // 删除实例时停止其正在播放的声音（并清除挂起的等待恢复）
    const s = state.instances[i].st && state.instances[i].st.sound;
    if (s && s.src) { try { s.src.stop(); } catch (e) {} s.playing = false; s.src = null; s.gain = null; s.resume = null; }
    state.instances.splice(i, 1);
  }
  if (selInstId === id) selInstId = -1;
  renderNodePanel();
  requestRender();
}
// 画布点击命中实例（pixel-canvas.js pointerdown 调用）：命中→选中并返回 true（拦截绘制）
function trySelectInstance(gx, gy) {
  for (let li = state.layers.length - 1; li >= 0; li--) {
    if (!state.layers[li].visible) continue;
    for (const inst of state.instances) {
    if ((inst.layerIdx === undefined ? 0 : inst.layerIdx) !== li) continue;
    const obj = state.objects[inst.objectIdx];
    if (!obj) continue;
      if (gx >= inst.x && gx < inst.x + obj.w && gy >= inst.y && gy < inst.y + obj.h) {
        selInstId = inst.id;
        if (inst.st) inst.st.clicked = true; // 触发「当对象被点击时」帽子
        renderNodePanel();
        requestRender();
        return true;
      }
    }
  }
  if (selInstId !== -1) { selInstId = -1; renderNodePanel(); requestRender(); }
  return false;
}

// 实例渲染（pixel-canvas.js 的 render() 调用）：只画可见图层的实例；选中实例画高亮框
function drawInstances(p, li) {
  if (state.instances.length === 0) return;
  // 保护：仅在像素画布环境（有 canvas/ctx）绘制；矢量画布等环境无像素画布时直接跳过，避免报错
  if (typeof canvas === 'undefined' || typeof ctx === 'undefined') return;
  const s = state.scale;
  ctx.setTransform(p * s, 0, 0, p * s, p * state.offsetX, p * state.offsetY);
  ctx.imageSmoothingEnabled = s < 1;
  for (const inst of state.instances) {
    const ili = inst.layerIdx === undefined ? 0 : inst.layerIdx;
    if (li !== undefined && li !== null && ili !== li) continue; // 按图层过滤：只画指定图层的实例
    if (!state.layers[ili] || !state.layers[ili].visible) continue; // 隐藏图层的实例不渲染
    const obj = state.objects[inst.objectIdx];
    if (!obj) continue;
    let img = objCanvases.get(obj.id);
    if (!img) { img = buildObjectCanvas(obj); objCanvases.set(obj.id, img); }
    const ix = Math.round(inst.x), iy = Math.round(inst.y);
    ctx.drawImage(img, ix, iy);
    if (inst.id === selInstId) { // 选中高亮框
      ctx.strokeStyle = 'rgba(30, 200, 120, .95)';
      ctx.lineWidth = 1.5 / s;
      ctx.setLineDash([3 / s, 2 / s]);
      ctx.strokeRect(ix - 0.5, iy - 0.5, obj.w + 1, obj.h + 1);
      ctx.setLineDash([]);
    }
  }
}

// ===================================================================
// 节点图求值引擎（DAG：沿连线从输出流向输入，递归求值 + 环保护）
// ===================================================================
function findConn(g, toNode, toSock) {
  for (const c of g.conns) if (c.to === toNode && c.toSock === toSock) return c;
  return null;
}
// 求某节点的全部数据输入（含 ifCond 动态条件端口）
function evalInputs(g, nodeId, inst, cache, visiting) {
  const node = g.nodes.find(function (n) { return n.id === nodeId; });
  const inputs = {};
  if (!node) return inputs;
  const def = NODE_TYPES[node.type];
  // 节点组（groupRef）：输入端口 = 组的接口输入（i0/i1…），从主图连线取值
  if (node.type === 'groupRef') {
    const grp = GROUPS[node.p && node.p.group];
    if (grp) {
      for (const pin of grp.inputs) {
        const src = findConn(g, nodeId, pin.extKey);
        inputs[pin.extKey] = src ? nodeValue(g, src.from, inst, cache, visiting, src.fromSock) : null;
      }
    }
    return inputs;
  }
  if (def && def.sockets) {
    for (const sock of def.sockets) {
      if (sock.dir !== 'in') continue;
      const src = findConn(g, nodeId, sock.key);
      if (src) {
        const sn = g.nodes.find(function (n) { return n.id === src.from; });
        if (sn && sn.type === 'groupRef') { // 消费组输出：递归求组内该输出端口的值
          const grp = GROUPS[sn.p && sn.p.group];
          inputs[sock.key] = grp ? groupOutValue(grp, src.fromSock, sn, inst, g) : null;
        } else {
          inputs[sock.key] = nodeValue(g, src.from, inst, cache, visiting, src.fromSock);
        }
      } else {
        inputs[sock.key] = null;
      }
    }
  }
  if (node.type === 'ifCond' && node.p && node.p.conds) { // 动态条件端口
    for (const ck of node.p.conds) {
      const src = findConn(g, nodeId, ck);
      if (src) {
        const sn = g.nodes.find(function (n) { return n.id === src.from; });
        if (sn && sn.type === 'groupRef') {
          const grp = GROUPS[sn.p && sn.p.group];
          inputs[ck] = grp ? groupOutValue(grp, src.fromSock, sn, inst, g) : null;
        } else {
          inputs[ck] = nodeValue(g, src.from, inst, cache, visiting, src.fromSock);
        }
      } else {
        inputs[ck] = null;
      }
    }
  }
  return inputs;
}
// 数据节点求值（缓存 + 环保护），数据链路与执行链共用
function nodeValue(g, nodeId, inst, cache, visiting, fromSock) {
  if (cache.has(nodeId)) return cache.get(nodeId);
  if (visiting.has(nodeId)) return null; // 环路保护
  const node = g.nodes.find(function (n) { return n.id === nodeId; });
  if (!node) { cache.set(nodeId, null); return null; }
  const def = NODE_TYPES[node.type];
  if (!def || !def.value) { cache.set(nodeId, null); return null; }
  visiting.add(nodeId);
  const inputs = evalInputs(g, nodeId, inst, cache, visiting);
  let val = null;
  try { val = def.value(inputs, inst, node.p || {}, inst.st, fromSock); } catch (e) { val = null; }
  visiting.delete(nodeId);
  cache.set(nodeId, val);
  if (def.displayVal) updateNodeDisplay(node, val); // 【显示值】类节点：节点上实时显示求值结果
  return val;
}
// ---- 执行流（Scratch 式：帽子节点 → 沿 flow 连线链式执行） ----
function findFlow(g, nodeId) {
  for (const c of (g.flows || [])) if (c.from === nodeId) return c.to;
  return null;
}
function execFlow(g, nodeId, inst, depth) {
  if (depth > 500) return; // 环保护
  const node = g.nodes.find(function (n) { return n.id === nodeId; });
  if (!node) return;
  const def = NODE_TYPES[node.type];
  if (!def) return;
  const cache = new Map();
  const visiting = new Set();
  const inputs = evalInputs(g, nodeId, inst, cache, visiting);
  if (def.run) { try { def.run(inputs, inst, node.p || {}, inst.st); } catch (e) { /* 节点错误跳过 */ } }
  // 阻塞节点：等待A秒 / 等待(事件A) —— 条件未满足时本帧暂停链，下帧继续
  if (def.flowBlock === 'waitSec') {
    if (!inst.st.waitUntil) inst.st.waitUntil = performance.now() + Math.max(0, (inputs.sec === null || inputs.sec === undefined ? ((node.p || {}).sec2 || 0) : inputs.sec)) * 1000;
    if (performance.now() < inst.st.waitUntil) return;
    inst.st.waitUntil = 0;
  } else if (def.flowBlock === 'waitMsg') {
    if (inst.st.waitMsg && !inst.st.waitMsgGot) return;
    inst.st.waitMsg = ''; inst.st.waitMsgGot = false;
  } else if (def.flowBlock === 'waitTimer') {
    // 等待计时器到达「等待时间」秒
    const t = (inputs.sec === null || inputs.sec === undefined) ? ((node.p || {}).sec2 || 0) : inputs.sec;
    if (sceneTimer < t) return;
  }
  // 阻塞节点（如「播放声音A等待播放完毕」）：对应声音还在播放时暂停执行链，
  // 挂起 resume 信息（恢复点 = 本节点的下一个节点），由 playSound 的 onended 在播放完毕时继续
  if (def.blockSound) {
    const s = inst.st.sound;
    const want = (node.p || {}).sound;
    if (want && s && s.name === want && s.playing) {
      inst.st.flowPaused = { graph: g, nodeId: findFlow(g, node.id), inst: inst };
      s.resume = inst.st.flowPaused;
      return;
    }
  }
  if (inst.st.stopSelf || !state.nodesRunning) return; // 停止当前脚本 / 停止全部执行：立即中断本链
  const next = findFlow(g, node.id);
  if (def.flow === 'repeat') {
    const raw = inputs.n;
    const n = (raw === null || raw === undefined) ? Infinity : Math.max(0, Math.round(raw));
    if (!isFinite(n)) { if (next) execFlow(g, next, inst, depth + 1); } // 次数未连=无限：每帧执行一次循环体
    else { for (let i = 0; i < n; i++) { if (next) execFlow(g, next, inst, depth + 1); } }
  } else if (def.flow === 'ifCond') {
    let any = false;
    for (const ck of (node.p.conds || [])) { if (inputs[ck]) { any = true; break; } }
    if (any && next) execFlow(g, next, inst, depth + 1);
  } else if (next) {
    execFlow(g, next, inst, depth + 1);
  }
}
function evalGraph(obj, inst) {
  const g = obj.graph;
  if (!g) return;
  if (inst.st.stopSelf) return; // 停止当前脚本：该实例不再执行任何链
  if (inst.st.flowPaused && inst.st.flowPaused.graph === g) return; // 「等待播放完毕」暂停中：声音播完后由 onended 恢复执行链
  // 节点组（groupRef）：递归执行被引用组的内图（组内 hats/动作照常）
  for (const node of g.nodes) {
    if (node.type !== 'groupRef') continue;
    const grp = GROUPS[node.p && node.p.group];
    if (grp) evalGroupGraph(grp, groupExtInputs(grp, node, inst, g), inst);
  }
  const hasFlow = g.flows && g.flows.length > 0;
  if (!hasFlow) { // 无执行流连线：保持旧行为（每帧执行所有动作节点）
    const cache = new Map();
    const visiting = new Set();
    for (const node of g.nodes) {
      const def = NODE_TYPES[node.type];
      if (!def || !def.run) continue;
      if (node.type === 'groupRef') continue; // 组已在上方递归执行
      const inputs = evalInputs(g, node.id, inst, cache, visiting);
      try { def.run(inputs, inst, node.p || {}, inst.st); } catch (e) { /* 节点错误跳过本帧 */ }
    }
    return;
  }
  // 有执行流：从帽子节点（事件）开始执行链
  for (const node of g.nodes) {
    const def = NODE_TYPES[node.type];
    if (!def || !def.hat) continue;
    if (def.hat === 'start') {
      execFlow(g, node.id, inst, 0);
    } else if (def.hat === 'key') {
      const down = keys.has((node.p || {}).key);
      const prev = !!inst.st.hatKey;
      inst.st.hatKey = down;
      if (down && !prev) execFlow(g, node.id, inst, 0); // 按下瞬间触发一次
    } else if (def.hat === 'click') {
      if (inst.st.clicked) { inst.st.clicked = false; execFlow(g, node.id, inst, 0); }
    } else if (def.hat === 'cond') {
      // 当(音量/计时器)>A：条件从假变真触发一次
      const np = node.p || {};
      const val = np.source === 'timer' ? sceneTimer : getVolume();
      const above = val > (np.th || 0);
      const prev = !!inst.st.condPrev;
      inst.st.condPrev = above;
      if (above && !prev) execFlow(g, node.id, inst, 0);
    }
  }
}

// ---------- 运行循环（RAF） ----------
let lastTick = 0;
let frameCount = 0;
function nodeTick(now) {
  requestAnimationFrame(nodeTick);
  if (!state.nodesRunning || state.instances.length === 0) return;
  lastTick = lastTick || now;
  const dt = Math.min(50, now - lastTick);
  lastTick = now;
  if (dt <= 0) return;
  sceneTimer += dt / 1000; // 全局计时器累加
  frameCount++;
  for (const inst of state.instances) {
    const li = inst.layerIdx === undefined ? 0 : inst.layerIdx;
    if (!state.layers[li] || !state.layers[li].visible) continue; // 隐藏图层：实例停止
    const obj = state.objects[inst.objectIdx];
    if (!obj) continue;
    try { evalGraph(obj, inst); } catch (e) { /* 节点执行出错跳过本帧 */ }
    // 通用实例步进钩子（画笔插件等：实例位置更新后自动绘制像素）
    if (window.penAPI && window.penAPI.runStepHooks) {
      try { window.penAPI.runStepHooks(obj, inst); } catch (e) { /* 钩子错误忽略 */ }
    }
  }
  requestRender();
}
requestAnimationFrame(nodeTick);

// ===================================================================
// 节点编辑器 UI
// ===================================================================
let selObjIdx = -1;   // 左侧选中的对象索引
let selNodeIdx = -1;  // 画布选中的节点 id
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function selectObject(i) { selObjIdx = i; selNodeIdx = -1; selInstId = -1; renderNodePanel(); }

// 删除对象：连同其实例、节点图、模板像素缓存一起删除
function deleteObject(idx) {
  if (idx < 0 || idx >= state.objects.length) return;
  if (!confirm('删除对象「' + state.objects[idx].name + '」？\n它的全部实例和节点图也会被删除。')) return;
  const oid = state.objects[idx].id;
  state.objects.splice(idx, 1);
  objCanvases.delete(oid);
  state.instances = state.instances.filter(function (it) { return it.objectIdx !== idx; });
  state.instances.forEach(function (it) { if (it.objectIdx > idx) it.objectIdx--; }); // 索引前移
  if (selObjIdx === idx) selObjIdx = -1;
  else if (selObjIdx > idx) selObjIdx--;
  selNodeIdx = -1;
  selInstId = -1;
  renderNodePanel();
  if (typeof renderVarUI === 'function') renderVarUI();
  requestRender();
}

function renderNodePanel() {
  // 左栏：对象列表
  els.nodeObjList.innerHTML = '';
  if (state.objects.length === 0) {
    els.nodeObjList.innerHTML = '<div class="n-note">还没有对象。<br>用「🔲 框选添加节点」框选像素，<br>或在图层面板点图层名旁的 📦。</div>';
  } else {
    state.objects.forEach(function (obj, i) {
      const item = document.createElement('div');
      item.className = 'node-obj' + (i === selObjIdx ? ' active' : '');
      item.innerHTML = '<span class="tag">' + (obj.kind === 'layer' ? '图层' : '框选') + '</span>' +
        '<span>' + escapeHtml(obj.name) + '</span>' +
        '<span class="layers-hint">' + obj.w + '×' + obj.h + '</span>' +
        '<span class="del" title="删除此对象及其实例">🗑</span>';
      item.addEventListener('click', function () { selectObject(i); });
      item.querySelector('.del').addEventListener('click', function (e) {
        e.stopPropagation();
        deleteObject(i);
      });
      els.nodeObjList.appendChild(item);
    });
  }
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  els.nodeNameInput.disabled = !obj;
  els.nodeNameInput.value = obj ? obj.name : '';
  els.btnNodeInstance.classList.toggle('disabled', !obj);
  renderInstList();
  renderVarUI();
  if (scratchModeOn) renderScratchSide(); // 全屏右下对象/实例同步
  renderNodeGraph();
  updateRunButton();
}

// 实例列表（当前选中对象的全部实例）
function renderInstList() {
  els.nodeInstList.innerHTML = '';
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (!obj) {
    els.nodeInstList.innerHTML = '<div class="n-note">选中对象后显示其实例</div>';
    return;
  }
  const insts = state.instances.filter(function (it) { return it.objectIdx === selObjIdx; });
  if (insts.length === 0) {
    els.nodeInstList.innerHTML = '<div class="n-note">该对象还没有实例（点「⬇ 实例化」放到当前图层）</div>';
    return;
  }
  for (const it of insts) {
    const div = document.createElement('div');
    div.className = 'node-inst' + (it.id === selInstId ? ' active' : '');
    const li = it.layerIdx === undefined ? 0 : it.layerIdx;
    const L = state.layers[li];
    div.innerHTML = '<span>#' + it.id + '</span>' +
      '<span class="layers-hint">(' + Math.round(it.x) + ',' + Math.round(it.y) + ')' +
      (L ? ' ' + escapeHtml(L.name) : '') + '</span>' +
      '<span class="del" title="删除此实例">🗑</span>';
    div.querySelector('.del').addEventListener('click', function (e) {
      e.stopPropagation();
      deleteInstance(it.id);
    });
    div.addEventListener('click', function () {
      selInstId = it.id;
      renderInstList();
      requestRender();
    });
    els.nodeInstList.appendChild(div);
  }
}

// ---------- 节点图画布（支持缩放/平移：graphView 视口变换） ----------
const svgNS = 'http://www.w3.org/2000/svg';
let curGraphArea = null;   // 当前节点画布渲染目标（小面板 #nodeCanvas 或全屏 #scratchCanvas）
let connSvg = null;        // 当前连线层 svg 引用
let connStart = null;      // 连线起点 { nodeId, sock, type }
let tempEnd = null;        // 临时线终点（世界坐标）
let dragNode = null;       // 拖动中的节点 { id, dx, dy }
let graphView = { s: 1, ox: 30, oy: 30 }; // 视口变换：屏幕 = 世界*s + ox/oy + 画布左上角
let graphPan = null;       // 画布空白处平移拖动 { x, y }

function graphTarget() { return curGraphArea || els.nodeCanvas; }
// 屏幕坐标 → 节点世界坐标（含画布缩放/平移）
function toWorld(clientX, clientY) {
  const r = graphTarget().getBoundingClientRect();
  return {
    x: (clientX - r.left - graphView.ox) / graphView.s,
    y: (clientY - r.top - graphView.oy) / graphView.s,
  };
}
function zoomGraph(factor) {
  const r = graphTarget().getBoundingClientRect();
  const mx = r.width / 2, my = r.height / 2;
  const s2 = Math.min(4, Math.max(0.15, graphView.s * factor));
  graphView.ox = mx - (mx - graphView.ox) * (s2 / graphView.s);
  graphView.oy = my - (my - graphView.oy) * (s2 / graphView.s);
  graphView.s = s2;
  renderNodeGraph();
}

let nodeValEls = new Map(); // 节点id → 值显示元素（renderNodeGraph 重建）
function updateNodeDisplay(node, val) {
  const el = nodeValEls.get(node.id);
  if (!el) return;
  let txt;
  if (val === null || val === undefined) txt = '—';
  else if (typeof val === 'string') txt = '"' + val + '"';
  else if (typeof val === 'boolean') txt = val ? '真(1)' : '假(0)';
  else txt = String(Math.round(val * 1000) / 1000);
  if (txt.length > 20) txt = txt.slice(0, 19) + '…';
  el.textContent = txt;
}
function renderNodeGraph() {
  const target = graphTarget();
  nodeValEls = new Map();
  target.innerHTML = '';
  connSvg = null;
  // 注意：不在这里清空 connStart/tempEnd——socket 按下起点后调用本函数重建 DOM 时，
  // 需要保留连线起点状态，最后由 drawTempConn() 基于 connStart 重画临时线。
  const g = currentGraph(); // 主图或展开编辑的组内图
  if (!g) {
    target.innerHTML = '<div class="n-note" style="padding:10px">' + (graphEditGroup ? '节点组不存在' : '先在左侧选择一个对象，或用「节点组」分类展开组') + '</div>';
    return;
  }
  // 视口层：所有节点与连线都在其中，随画布缩放/平移
  const vp = document.createElement('div');
  vp.className = 'graph-viewport';
  vp.style.transform = 'translate(' + graphView.ox + 'px,' + graphView.oy + 'px) scale(' + graphView.s + ')';
  vp.style.transformOrigin = '0 0';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'conn-layer');
  // svg 尺寸必须覆盖所有节点范围（viewport 世界坐标），否则连线会被 0×0 的 svg 裁剪不可见
  let gw = 800, gh = 600;
  for (const node of g.nodes) {
    gw = Math.max(gw, (node.x || 20) + 320);
    gh = Math.max(gh, (node.y || 20) + 220);
  }
  svg.setAttribute('width', gw);
  svg.setAttribute('height', gh);
  vp.appendChild(svg);
  connSvg = svg;
  for (const node of g.nodes) {
    const def = NODE_TYPES[node.type];
    if (!def) continue;
    const el = document.createElement('div');
    // 右键编辑 JS：仅「自制/插件」分类节点可编辑；节点定义加 noEdit:true 可锁定（不能右键编辑）
    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (NODE_DEF_SRC[node.type] && (def.category === '自制' || pluginNodeIds.has(node.type)) && !def.noEdit) {
        openNodeJsEditor(NODE_DEF_SRC[node.type], '编辑节点「' + def.name + '」的 JS');
      }
    });
    el.className = 'node-gnode' + (node.id === selNodeIdx || selNodeSet.has(node.id) ? ' sel' : '') + (node.type === 'groupRef' ? ' group' : '');
    el.style.left = (node.x || 20) + 'px';
    el.style.top = (node.y || 20) + 'px';
    const head = document.createElement('div');
    head.className = 'ng-head';
    // 节点头部按所属类型着色（如事件=黄、运动=蓝、控制=橙）
    const catCol = NODE_CATS[def.category];
    if (catCol) {
      head.style.background = catCol;
      head.style.borderColor = catCol;
      head.style.color = '#1c1e24'; // 分类色背景用深色文字保证可读
    }
    head.innerHTML = '<span>' + escapeHtml(def.name) + '</span><span class="ng-del" title="删除此节点">×</span>';
    // 执行流端口对称放节点顶部：左侧 = 入口（in，从上一步来），右侧 = 出口（out，去下一步）
    if (def.flowIn) head.insertBefore(flowEl(node.id, 'in'), head.firstChild);
    if (def.flowOut) head.insertBefore(flowEl(node.id, 'out'), head.querySelector('.ng-del'));
    head.querySelector('.ng-del').addEventListener('click', function (e) {
      e.stopPropagation();
      deleteGraphNode(node.id);
    });
    head.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const w = toWorld(e.clientX, e.clientY);
      // 框选多选时：拖动任一选中节点 → 全部选中节点一起移动
      if (selNodeSet.has(node.id) && selNodeSet.size > 1) {
        const g2 = currentGraph();
        const starts = {};
        for (const nid of selNodeSet) {
          const nn = g2.nodes.find(function (x) { return x.id === nid; });
          if (nn) starts[nid] = { x: nn.x, y: nn.y };
        }
        dragNode = { id: node.id, ids: Array.from(selNodeSet), starts: starts, w0x: w.x, w0y: w.y };
      } else {
        dragNode = { id: node.id, dx: w.x - (node.x || 20), dy: w.y - (node.y || 20) };
        selNodeSet = new Set([node.id]); // 未多选：按下即单选
        selNodeIdx = node.id;
        if (typeof renderVarUI === 'function') renderVarUI(); // 选中节点 → 变量/数组列表显示实例当前值预览
      }
    });
    // 节点组：双击展开编辑组内图
    if (node.type === 'groupRef') {
      head.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        enterGroupEdit(node.p && node.p.group);
      });
      head.title = '节点组：' + (node.p && node.p.group ? node.p.group : '（未选择组）') + '（双击展开编辑）';
    }
    el.appendChild(head);
    // 节点组：动态端口 = 组的接口输入/输出（i0/o0…）
    if (node.type === 'groupRef') {
      const grp = GROUPS[node.p && node.p.group];
      if (grp) {
        for (const pin of grp.inputs) el.appendChild(socketEl(node.id, { key: pin.extKey, type: pin.type, label: pin.label }, 'in'));
        for (const pout of grp.outputs) el.appendChild(socketEl(node.id, { key: pout.extKey, type: pout.type, label: pout.label }, 'out'));
      }
    }
    for (const sock of (def.sockets || [])) {
      if (sock.dir !== 'in') continue;
      el.appendChild(socketEl(node.id, sock, 'in'));
    }
    if (def.params) {
      for (const prm of def.params) {
        const row = document.createElement('div');
        row.className = 'ng-row';
        if (prm.type === 'number') {
          const label = document.createElement('label');
          label.textContent = prm.label;
          const inp = document.createElement('input');
          inp.type = 'number'; inp.min = prm.min; inp.max = prm.max; inp.step = prm.step;
          inp.value = node.p[prm.key] === undefined ? prm.def : node.p[prm.key];
          // 参数绑定的端口已连线时：禁用输入框并提示（连线值优先，避免"调了没反应"）
          const portConn = prm.port ? findConn(g, node.id, prm.port) : null;
          if (portConn) {
            inp.disabled = true;
            inp.title = '已连接「' + prm.label + '」端口，使用连线值；断开连线即可手动调整';
            label.style.opacity = '0.5';
          }
          inp.addEventListener('input', function () { node.p[prm.key] = +inp.value; });
          row.appendChild(label);
          row.appendChild(inp);
        } else if (prm.type === 'select') {
          const label = document.createElement('label');
          label.textContent = prm.label;
          const sel = document.createElement('select');
          if (def.category === '声音') sel.style.fontSize = '10px'; // 声音下拉（含「未导入声音」选项）调小
          const opts = prm.options ? prm.options() : [];
          for (const o of opts) {
            const opt = document.createElement('option');
            opt.value = o.v;
            opt.textContent = o.label;
            if (String(o.v) === String(node.p[prm.key])) opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', function () {
            node.p[prm.key] = prm.num ? +sel.value : sel.value; // num: 数字型下拉（如对象索引）
          });
          row.appendChild(label);
          row.appendChild(sel);
        } else if (prm.type === 'key') {
          const label = document.createElement('label');
          label.textContent = prm.label;
          const sel = document.createElement('select');
          for (const o of KEY_OPTIONS) {
            const opt = document.createElement('option');
            opt.value = o.v;
            opt.textContent = o.label;
            if (o.v === (node.p[prm.key] || prm.def)) opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', function () { node.p[prm.key] = sel.value; });
          row.appendChild(label);
          row.appendChild(sel);
        } else if (prm.type === 'color') {
          const label = document.createElement('label');
          label.textContent = prm.label;
          const inp = document.createElement('input');
          inp.type = 'color';
          inp.value = node.p[prm.key] === undefined ? (prm.def || '#000000') : node.p[prm.key];
          inp.style.width = '36px';
          inp.style.padding = '0';
          inp.addEventListener('input', function () { node.p[prm.key] = inp.value; });
          row.appendChild(label);
          row.appendChild(inp);
        } else if (prm.type === 'text') {
          const label = document.createElement('label');
          label.textContent = prm.label;
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.value = node.p[prm.key] === undefined ? (prm.def == null ? '' : prm.def) : node.p[prm.key];
          inp.style.width = '140px';
          inp.addEventListener('input', function () { node.p[prm.key] = inp.value; });
          row.appendChild(label);
          row.appendChild(inp);
        }
        if (prm.out) {
          const se = socketEl(node.id, { key: prm.out, type: 'num', label: '' }, 'out');
          se.classList.add('inline'); // 内联端口：绝对定位在节点右缘，不占行宽
          row.appendChild(se);
        }
        el.appendChild(row);
      }
    }
    for (const sock of (def.sockets || [])) {
      if (sock.dir !== 'out') continue;
      if (def.params && def.params.some(function (p) { return p.out === sock.key; })) continue; // 已在参数行右侧内联，避免重复
      el.appendChild(socketEl(node.id, sock, 'out'));
    }
    // 【显示值】类节点：「值」显示框（显示上一个连接的节点输出的值）
    if (def.displayVal) {
      const dv = document.createElement('div');
      dv.className = 'node-val';
      const lb = document.createElement('span');
      lb.className = 'nv-label';
      lb.textContent = '值';
      const bx = document.createElement('span');
      bx.className = 'nv-box';
      bx.textContent = '—';
      dv.appendChild(lb);
      dv.appendChild(bx);
      el.appendChild(dv);
      nodeValEls.set(node.id, bx);
    }
    // 条件判断：动态条件端口（左侧）+ ➕ 条件按钮
    if (node.type === 'ifCond') {
      if (!node.p.conds) node.p.conds = ['c0'];
      for (const ck of node.p.conds) el.appendChild(socketEl(node.id, ck, 'in'));
      const addRow = document.createElement('div');
      addRow.className = 'ng-row ng-add-cond';
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '➕ 条件';
      btn.title = '添加一个条件端口';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        node.p.conds.push('c' + node.p.conds.length);
        renderNodeGraph();
      });
      addRow.appendChild(btn);
      el.appendChild(addRow);
    }
    // 执行流出口（右侧连接点）→ 已移到节点顶部右侧（与入口对称）
    el.addEventListener('click', function (e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      selNodeIdx = node.id;
      selNodeSet = new Set([node.id]); // 单击 = 单选
      renderNodeGraph();
    });
    vp.appendChild(el);
  }
  target.appendChild(vp);
  drawConns();
  drawFlowConns();
  drawTempConn();
  // 框选矩形（叠加在画布上方，屏幕坐标）
  if (graphSelStart && graphSelEnd) {
    const r = target.getBoundingClientRect();
    const x = Math.min(graphSelStart.x, graphSelEnd.x) - r.left;
    const y = Math.min(graphSelStart.y, graphSelEnd.y) - r.top;
    const w = Math.abs(graphSelEnd.x - graphSelStart.x);
    const h = Math.abs(graphSelEnd.y - graphSelStart.y);
    const box = document.createElement('div');
    box.className = 'graph-sel-box';
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.width = w + 'px'; box.style.height = h + 'px';
    target.appendChild(box);
  }
}
// 执行流端口（连接点：in=入口/左侧，out=出口/右侧）
function flowEl(nodeId, dir) {
  const el = document.createElement('div');
  el.className = 'node-flow ' + dir;
  el.dataset.nodeId = nodeId;
  el.dataset.flow = '1';
  el.dataset.dir = dir;
  el.title = dir === 'out' ? '执行流出口：拖到下一个节点的入口（绿色线）' : '执行流入口：从上一步连接（绿色线）';
  el.addEventListener('pointerdown', function (e) {
    e.stopPropagation();
    e.preventDefault();
    if (dir === 'out') {
      connStart = { nodeId: nodeId, sock: '__flow__', type: 'flow', dir: dir };
      const w = toWorld(e.clientX, e.clientY);
      tempEnd = { x: w.x, y: w.y };
      if (connSvg) {
        connSvg.innerHTML = '';
        drawConns();
        drawFlowConns();
        drawTempConn();
      }
    } else {
      removeFlowConn(nodeId); // 点击入口：断开进入的执行流
      renderNodeGraph();
    }
  });
  return el;
}
function socketEl(nodeId, sock, dir) {
  const el = document.createElement('div');
  el.className = 'node-socket ' + dir;
  el.dataset.nodeId = nodeId;
  el.dataset.sock = sock.key;
  el.dataset.dir = dir;
  el.dataset.type = sock.type;
  el.innerHTML = dir === 'in'
    ? '<span class="dot"></span><span class="sl">' + escapeHtml(sock.label) + '</span>'
    : '<span class="sl">' + escapeHtml(sock.label) + '</span><span class="dot"></span>';
  el.addEventListener('pointerdown', function (e) {
    e.stopPropagation();
    e.preventDefault();
    if (dir === 'out') {
      // 起点：保存连线状态后直接画临时线（不能调 renderNodeGraph，否则状态被清空）
      connStart = { nodeId: nodeId, sock: sock.key, type: sock.type };
      const w = toWorld(e.clientX, e.clientY);
      tempEnd = { x: w.x, y: w.y };
      if (connSvg) {
        connSvg.innerHTML = '';
        drawConns();
        drawFlowConns();
        drawTempConn();
      }
    } else {
      removeConnTo(nodeId, sock.key); // 点击输入端口：断开旧连线
      renderNodeGraph();
    }
  });
  return el;
}
// 收集端口坐标（世界坐标，随画布缩放/平移），绘制全部连线（含执行流端口）
function collectPorts() {
  const ports = {};
  const target = curGraphArea || els.nodeCanvas;
  const cRect = target.getBoundingClientRect();
  target.querySelectorAll('.node-socket, .node-flow').forEach(function (s) {
    const rect = s.getBoundingClientRect();
    const isFlow = s.classList && s.classList.contains('node-flow');
    // flow 端口必须区分方向：同一节点的入口/出口坐标不同，key 混用会导致出口覆盖入口
    const key = isFlow ? 'f:' + s.dataset.nodeId + ':' + s.dataset.dir : s.dataset.nodeId + ':' + s.dataset.sock;
    // 连线端点对齐到圆点（.dot）中心，而不是端口行中心（否则线头偏离圆圈）
    const dot = s.querySelector('.dot');
    let cx = rect.left - cRect.left + rect.width / 2;
    let cy = rect.top - cRect.top + rect.height / 2;
    if (dot) {
      const dr = dot.getBoundingClientRect();
      cx = dr.left - cRect.left + dr.width / 2;
      cy = dr.top - cRect.top + dr.height / 2;
    }
    ports[key] = {
      x: (cx - graphView.ox) / graphView.s,
      y: (cy - graphView.oy) / graphView.s,
    };
  });
  return ports;
}
function drawConns() {
  const g = currentGraph(); // 展开组编辑时画组内连线
  if (!g || !connSvg) return;
  const ports = collectPorts();
  g.conns.forEach(function (c) {
    const a = ports[c.from + ':' + c.fromSock];
    const b = ports[c.to + ':' + c.toSock];
    if (!a || !b) return;
    const path = document.createElementNS(svgNS, 'path');
    const mx = (a.x + b.x) / 2;
    path.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' C ' + mx + ' ' + a.y + ', ' + mx + ' ' + b.y + ', ' + b.x + ' ' + b.y);
    path.setAttribute('class', 'conn');
    path.addEventListener('click', function (e) {
      e.stopPropagation();
      const g2 = currentGraph();
      if (g2) {
        g2.conns = g2.conns.filter(function (cc) { return cc !== c; });
        renderNodeGraph();
      }
    });
    connSvg.appendChild(path);
  });
}
// 执行流连线（绿色粗线 + 方向箭头）
function drawFlowConns() {
  const g = currentGraph(); // 展开组编辑时画组内执行流连线
  if (!g || !connSvg) return;
  // 方向箭头 marker（每次 svg 重建后重新添加）
  if (!connSvg.querySelector('marker')) {
    const mk = document.createElementNS(svgNS, 'marker');
    mk.setAttribute('id', 'flowArrow');
    mk.setAttribute('viewBox', '0 0 10 10');
    mk.setAttribute('refX', '9'); mk.setAttribute('refY', '5');
    mk.setAttribute('markerWidth', '7'); mk.setAttribute('markerHeight', '7');
    mk.setAttribute('orient', 'auto');
    const mp = document.createElementNS(svgNS, 'path');
    mp.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    mp.setAttribute('fill', '#22c55e');
    mk.appendChild(mp);
    connSvg.appendChild(mk);
  }
  const ports = collectPorts();
  (g.flows || []).forEach(function (c) {
    const a = ports['f:' + c.from + ':out'];
    const b = ports['f:' + c.to + ':in'];
    if (!a || !b) return;
    const path = document.createElementNS(svgNS, 'path');
    const mx = (a.x + b.x) / 2;
    path.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' C ' + mx + ' ' + a.y + ', ' + mx + ' ' + b.y + ', ' + b.x + ' ' + b.y);
    path.setAttribute('class', 'conn flow');
    path.setAttribute('marker-end', 'url(#flowArrow)');
    path.addEventListener('click', function (e) {
      e.stopPropagation();
      const g2 = currentGraph();
      if (g2) {
        g2.flows = (g2.flows || []).filter(function (cc) { return cc !== c; });
        renderNodeGraph();
      }
    });
    connSvg.appendChild(path);
  });
}
function drawTempConn() {
  if (!connStart || !tempEnd || !connSvg) return;
  const ports = collectPorts();
  // 执行流端口在 collectPorts 中的 key 带 'f:' 前缀和方向（如 'f:3:out'），
  // 数据端口 key = '节点id:端口key'——按类型分别查找，否则 flow 临时线起点查不到
  const key = connStart.type === 'flow'
    ? 'f:' + connStart.nodeId + ':' + (connStart.dir || 'out')
    : connStart.nodeId + ':' + connStart.sock;
  const a = ports[key];
  if (!a) return;
  const path = document.createElementNS(svgNS, 'path');
  const mx = (a.x + tempEnd.x) / 2;
  path.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' C ' + mx + ' ' + a.y + ', ' + mx + ' ' + tempEnd.y + ', ' + tempEnd.x + ' ' + tempEnd.y);
  path.setAttribute('class', connStart.type === 'flow' ? 'temp flow-temp' : 'temp');
  connSvg.appendChild(path);
}
// 连线 / 节点增删
function addConn(fromNode, fromSock, toNode, toSock) {
  const g = currentGraph(); // 展开组编辑时连线写入组内图
  if (!g) return;
  g.conns = g.conns.filter(function (c) { return !(c.to === toNode && c.toSock === toSock); }); // 同输入端口只留一条
  g.conns.push({ from: fromNode, fromSock: fromSock, to: toNode, toSock: toSock });
  renderNodeGraph();
}
// 执行流连线：from（出口）→ to（入口）；每个节点出口只连一条（重复连线替换）
function addFlowConn(fromNode, toNode) {
  const g = currentGraph();
  if (!g) return;
  if (!g.flows) g.flows = [];
  g.flows = g.flows.filter(function (c) { return c.from !== fromNode; });
  g.flows.push({ from: fromNode, to: toNode });
  renderNodeGraph();
}
function removeFlowConn(toNode) {
  const g = currentGraph();
  if (!g) return;
  g.flows = (g.flows || []).filter(function (c) { return c.to !== toNode; });
}
function removeConnTo(toNode, toSock) {
  const g = currentGraph();
  if (!g) return;
  g.conns = g.conns.filter(function (c) { return !(c.to === toNode && c.toSock === toSock); });
}
// ---------- 节点图撤销 / 重做（右键菜单 + Ctrl+Z / Ctrl+Shift+Z） ----------
let nodeHist = [];      // 撤销栈（操作前快照）
let nodeRedo = [];      // 重做栈
const NODE_HIST_MAX = 60;
function nodeSnapshot() {
  const g = currentGraph();
  if (!g) return null;
  return JSON.stringify({ nodes: g.nodes, conns: g.conns, flows: g.flows || [] });
}
function pushNodeHistory() {
  const snap = nodeSnapshot();
  if (snap === null) return;
  nodeHist.push(snap);
  if (nodeHist.length > NODE_HIST_MAX) nodeHist.shift();
  nodeRedo = [];
}
function applyNodeSnapshot(snap) {
  if (snap === null) return;
  const g = currentGraph();
  if (!g) return;
  const d = JSON.parse(snap);
  g.nodes = d.nodes;
  g.conns = d.conns;
  g.flows = d.flows || [];
  selNodeSet = new Set();
  selNodeIdx = -1;
  if (typeof renderVarUI === 'function') renderVarUI();
  hideNodeCtxMenu();
  renderNodeGraph();
}
function undoNode() {
  if (!nodeHist.length) return;
  const snap = nodeHist.pop();
  nodeRedo.push(nodeSnapshot());
  applyNodeSnapshot(snap);
}
function redoNode() {
  if (!nodeRedo.length) return;
  const snap = nodeRedo.pop();
  nodeHist.push(nodeSnapshot());
  applyNodeSnapshot(snap);
}
function deleteGraphNode(id) {
  pushNodeHistory();
  const g = currentGraph();
  if (!g) return;
  g.nodes = g.nodes.filter(function (n) { return n.id !== id; });
  g.conns = g.conns.filter(function (c) { return c.from !== id && c.to !== id; });
  g.flows = (g.flows || []).filter(function (c) { return c.from !== id && c.to !== id; });
  renderNodeGraph();
}
// ---------- 右键工具框（框选节点后，在鼠标位置弹出，可删除框选节点） ----------
const nodeCtxMenu = document.getElementById('nodeCtxMenu');
const nodeCtxDelete = document.getElementById('nodeCtxDelete');
function hideNodeCtxMenu() { if (nodeCtxMenu) nodeCtxMenu.style.display = 'none'; }
function showNodeCtxMenu(x, y) {
  if (!nodeCtxMenu || !selNodeSet.size) { hideNodeCtxMenu(); return; }
  nodeCtxMenu.style.display = 'block';
  const w = nodeCtxMenu.offsetWidth || 130, hgt = nodeCtxMenu.offsetHeight || 30;
  nodeCtxMenu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  nodeCtxMenu.style.top = Math.min(y, window.innerHeight - hgt - 8) + 'px';
  if (nodeCtxDelete) nodeCtxDelete.textContent = '🗑 删除框选节点（' + selNodeSet.size + '）';
}
function deleteSelNodes() {
  pushNodeHistory();
  const g = currentGraph();
  if (!g || !selNodeSet.size) { hideNodeCtxMenu(); return; }
  const ids = Array.from(selNodeSet);
  g.nodes = g.nodes.filter(function (n) { return ids.indexOf(n.id) < 0; });
  g.conns = g.conns.filter(function (c) { return ids.indexOf(c.from) < 0 && ids.indexOf(c.to) < 0; });
  g.flows = (g.flows || []).filter(function (c) { return ids.indexOf(c.from) < 0 && ids.indexOf(c.to) < 0; });
  selNodeSet = new Set();
  selNodeIdx = -1;
  if (typeof renderVarUI === 'function') renderVarUI();
  hideNodeCtxMenu();
  renderNodeGraph();
}
if (nodeCtxDelete) nodeCtxDelete.addEventListener('click', deleteSelNodes);
// ---------- 节点复制 / 粘贴（框选后复制，粘贴到画布；快捷键 Ctrl+C / Ctrl+V） ----------
let nodeClipboard = null; // { nodes, conns, flows }
function copySelNodes() {
  const g = currentGraph();
  if (!g || !selNodeSet.size) return false;
  const ids = Array.from(selNodeSet);
  const nodes = g.nodes.filter(function (n) { return ids.indexOf(n.id) >= 0; }).map(function (n) { return JSON.parse(JSON.stringify(n)); });
  const conns = g.conns.filter(function (c) { return ids.indexOf(c.from) >= 0 && ids.indexOf(c.to) >= 0; }).map(function (c) { return JSON.parse(JSON.stringify(c)); });
  const flows = (g.flows || []).filter(function (c) { return ids.indexOf(c.from) >= 0 && ids.indexOf(c.to) >= 0; }).map(function (c) { return JSON.parse(JSON.stringify(c)); });
  nodeClipboard = { nodes: nodes, conns: conns, flows: flows };
  return true;
}
function pasteClipboard() {
  pushNodeHistory();
  const g = currentGraph();
  if (!g || !nodeClipboard || !nodeClipboard.nodes.length) return;
  const oldToNew = {};
  const offset = 24;
  for (const n of nodeClipboard.nodes) {
    const nn = JSON.parse(JSON.stringify(n));
    const newId = nextNodeId++;
    oldToNew[n.id] = newId;
    nn.id = newId;
    nn.x = (nn.x || 20) + offset;
    nn.y = (nn.y || 20) + offset;
    g.nodes.push(nn);
  }
  for (const c of nodeClipboard.conns) g.conns.push({ from: oldToNew[c.from], fromSock: c.fromSock, to: oldToNew[c.to], toSock: c.toSock });
  for (const f of nodeClipboard.flows || []) g.flows.push({ from: oldToNew[f.from], to: oldToNew[f.to] });
  selNodeSet = new Set(Object.values(oldToNew));
  selNodeIdx = selNodeSet.values().next().value;
  if (typeof renderVarUI === 'function') renderVarUI();
  hideNodeCtxMenu();
  renderNodeGraph();
}
const nodeCtxCopy = document.getElementById('nodeCtxCopy');
const nodeCtxPaste = document.getElementById('nodeCtxPaste');
const nodeCtxUndo = document.getElementById('nodeCtxUndo');
const nodeCtxRedo = document.getElementById('nodeCtxRedo');
if (nodeCtxCopy) nodeCtxCopy.addEventListener('click', function () { copySelNodes(); hideNodeCtxMenu(); });
if (nodeCtxPaste) nodeCtxPaste.addEventListener('click', function () { pasteClipboard(); hideNodeCtxMenu(); });
if (nodeCtxUndo) nodeCtxUndo.addEventListener('click', function () { undoNode(); hideNodeCtxMenu(); });
if (nodeCtxRedo) nodeCtxRedo.addEventListener('click', function () { redoNode(); hideNodeCtxMenu(); });
// 快捷键：Ctrl+C 复制框选节点，Ctrl+V 粘贴（在节点画布区域且未在输入框中时）
document.addEventListener('keydown', function (e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoNode(); }
  else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoNode(); }
  else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'c' || e.key === 'C')) { copySelNodes(); }
  else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteClipboard(); }
});
// 整个网站右键不再弹出浏览器默认菜单；节点/库按钮上的右键走各自原有逻辑（已 stopPropagation）
document.addEventListener('contextmenu', function (e) {
  e.preventDefault(); // 全局阻止浏览器默认右键菜单（另存为等）
  const t = e.target;
  const inCanvas = (t === els.nodeCanvas || els.nodeCanvas.contains(t)) || (t === els.scratchCanvas || els.scratchCanvas.contains(t));
  if (!inCanvas) { hideNodeCtxMenu(); return; }
  if (t.closest && t.closest('.node-gnode')) return; // 节点上右键：走节点原有逻辑
  if (selNodeSet.size) { showNodeCtxMenu(e.clientX, e.clientY); }
  else hideNodeCtxMenu();
});
document.addEventListener('click', function () { hideNodeCtxMenu(); });
document.addEventListener('wheel', function () { hideNodeCtxMenu(); });
// 画布交互：拖动节点 / 连线 / 平移 / 缩放（事件委托到 document）
document.addEventListener('pointermove', function (e) {
  if (dragNode) {
    const g = currentGraph();
    if (g) {
      const w = toWorld(e.clientX, e.clientY);
      if (dragNode.ids) { // 多选整体拖动：所有选中节点保持相对位置一起移动
        const dx = w.x - dragNode.w0x, dy = w.y - dragNode.w0y;
        for (const nid of dragNode.ids) {
          const node = g.nodes.find(function (n) { return n.id === nid; });
          if (node && dragNode.starts[nid]) {
            node.x = dragNode.starts[nid].x + dx;
            node.y = dragNode.starts[nid].y + dy;
          }
        }
      } else {
        const node = g.nodes.find(function (n) { return n.id === dragNode.id; });
        if (node) {
          node.x = Math.max(-800, w.x - dragNode.dx);
          node.y = Math.max(-800, w.y - dragNode.dy);
        }
      }
      renderNodeGraph();
    }
  } else if (graphPan) {
    graphView.ox = e.clientX - graphPan.x;
    graphView.oy = e.clientY - graphPan.y;
    renderNodeGraph();
  } else if (graphSelStart) {
    graphSelEnd = { x: e.clientX, y: e.clientY };
    renderNodeGraph();
  } else if (stagePan) {
    stageView.ox = stagePan.ox - (e.clientX - stagePan.x) / stagePan.s;
    stageView.oy = stagePan.oy - (e.clientY - stagePan.y) / stagePan.s;
  } else if (connStart) {
    const w = toWorld(e.clientX, e.clientY);
    tempEnd = { x: w.x, y: w.y };
    if (connSvg) {
      connSvg.innerHTML = '';
      drawConns();
      drawFlowConns();
      drawTempConn();
    }
  }
});
// 空白处按下：左键 = 框选节点，中键 = 平移画布（捕获阶段，避免被节点/端口的事件吞掉）
document.addEventListener('pointerdown', function (e) {
  const target = curGraphArea || els.nodeCanvas;
  if (!target || !target.contains(e.target)) return;
  if (e.target === target || (e.target.classList && e.target.classList.contains('graph-viewport'))) {
    if (e.button === 0) { // 左键：框选
      graphSelStart = { x: e.clientX, y: e.clientY };
      graphSelEnd = { x: e.clientX, y: e.clientY };
      graphPan = null;
    } else if (e.button === 1) { // 中键：平移
      graphPan = { x: e.clientX - graphView.ox, y: e.clientY - graphView.oy };
    }
  }
}, true);
// 滚轮 = 以鼠标为中心缩放画布
function graphWheelHandler(e) {
  const target = curGraphArea || els.nodeCanvas;
  if (!target || !target.contains(e.target)) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const r = target.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const s2 = Math.min(4, Math.max(0.15, graphView.s * factor));
  graphView.ox = mx - (mx - graphView.ox) * (s2 / graphView.s);
  graphView.oy = my - (my - graphView.oy) * (s2 / graphView.s);
  graphView.s = s2;
  renderNodeGraph();
}
document.addEventListener('wheel', graphWheelHandler, { passive: false });
document.addEventListener('pointerup', function (e) {
  if (graphSelStart) { // 框选结束：命中矩形内的节点（多选）
    const target = curGraphArea || els.nodeCanvas;
    const w1 = toWorld(graphSelStart.x, graphSelStart.y), w2 = toWorld(graphSelEnd.x, graphSelEnd.y);
    const x0 = Math.min(w1.x, w2.x) - 5, y0 = Math.min(w1.y, w2.y) - 5;
    const x1 = Math.max(w1.x, w2.x) + 5, y1 = Math.max(w1.y, w2.y) + 5;
    const g = currentGraph();
    selNodeSet = new Set();
    if (g) {
      for (const n of g.nodes) {
        if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) selNodeSet.add(n.id);
      }
    }
    selNodeIdx = selNodeSet.size ? Array.from(selNodeSet)[0] : -1;
    graphSelStart = null; graphSelEnd = null;
    renderNodeGraph();
    return;
  }
  if (connStart) {
    // 用坐标命中端口（比依赖 e.target 更稳，DOM 重绘/端口边缘都不会漏）
    const target = curGraphArea || els.nodeCanvas;
    if (connStart.type === 'flow') {
      let hit = null;
      target.querySelectorAll('.node-flow.in').forEach(function (s) {
        const r = s.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          if (+s.dataset.nodeId !== connStart.nodeId) hit = s;
        }
      });
      if (hit) addFlowConn(connStart.nodeId, +hit.dataset.nodeId);
    } else {
      let hit = null;
      target.querySelectorAll('.node-socket.in').forEach(function (s) {
        const r = s.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          if (+s.dataset.nodeId !== connStart.nodeId && s.dataset.type === connStart.type) hit = s;
        }
      });
      if (hit) { pushNodeHistory(); addConn(connStart.nodeId, connStart.sock, +hit.dataset.nodeId, hit.dataset.sock); }
    }
    connStart = null;
    tempEnd = null;
    renderNodeGraph();
  }
  dragNode = null;
  graphPan = null;
  stagePan = null;
});

// ---------- 节点分类 / 类型下拉 ----------
function fillNodeCatSelect() {
  els.nodeCatSelect.innerHTML = '';
  for (const cat of Object.keys(NODE_CATS)) {
    const has = Object.keys(NODE_TYPES).some(function (t) { return NODE_TYPES[t].category === cat; });
    if (!has) continue;
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    els.nodeCatSelect.appendChild(opt);
  }
  // 「节点组」分类（打包好的子图，选择后可直接添加到画布）
  const gOpt = document.createElement('option');
  gOpt.value = '节点组';
  gOpt.textContent = '节点组';
  els.nodeCatSelect.appendChild(gOpt);
  fillNodeTypeSelect();
}
function fillNodeTypeSelect() {
  const cat = els.nodeCatSelect.value;
  els.nodeTypeSelect.innerHTML = '';
  // 声音导入区只在选中「声音」分类时展开显示（导入声音属于声音类型节点库）
  const sr = document.getElementById('soundRow');
  if (sr) sr.style.display = (cat === '声音') ? 'flex' : 'none';
  const ca = document.getElementById('btnNodeAddCustom');
  const cs = document.getElementById('btnSaveCustom');
  if (cs) cs.style.display = (cat === '自制') ? '' : 'none';
  if (ca) ca.style.display = (cat === '自制') ? '' : 'none';
  if (cat === '节点组') { // 列出已保存的节点组
    for (const name of Object.keys(GROUPS)) {
      const opt = document.createElement('option');
      opt.value = 'groupRef:' + name;
      opt.textContent = name;
      els.nodeTypeSelect.appendChild(opt);
    }
    if (!Object.keys(GROUPS).length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（暂无节点组：框选节点后点「打包」）';
      els.nodeTypeSelect.appendChild(opt);
    }
    return;
  }
  for (const t of Object.keys(NODE_TYPES)) {
    if (NODE_TYPES[t].category !== cat) continue;
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = NODE_TYPES[t].name;
    els.nodeTypeSelect.appendChild(opt);
  }
}
// 添加节点到当前图（展开组编辑时加到组内图）：graph.nodes 追加
function addNodeToObject(type) {
  pushNodeHistory();
  const g = currentGraph();
  if (!g) { alert('请先在左侧选择一个对象。'); return; }
  const realType = type.indexOf('groupRef:') === 0 ? 'groupRef' : type; // groupRef:组名 → 组引用节点
  const def = NODE_TYPES[realType];
  if (!def) return;
  const n = g.nodes.length;
  const p = defaultParams(def);
  if (realType === 'groupRef') p.group = type.slice('groupRef:'.length);
  g.nodes.push({
    id: nextNodeId++, type: realType, p: p,
    x: 20 + (n % 2) * 130,   // 两列瀑布：每两个节点换列
    y: 16 + Math.floor(n / 2) * 42, // 每行 42px 步进，行内向下排，避免互相遮挡
  });
  renderNodeGraph();
}

// ---------- 面板事件 ----------
// 打包选中的节点为节点组：提取子图 → 注册组 → 用组节点替换选中节点
function packSelectedAsGroup() {
  const g = currentGraph();
  if (!g || selNodeSet.size < 2) { alert('请先在画布上框选至少 2 个节点。'); return; }
  const name = prompt('节点组名称：');
  if (!name) return;
  const ids = new Set(selNodeSet);
  const sub = { nodes: [], conns: [], flows: [] };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of g.nodes) {
    if (!ids.has(n.id)) continue;
    sub.nodes.push(JSON.parse(JSON.stringify(n)));
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  }
  for (const c of g.conns) if (ids.has(c.from) && ids.has(c.to)) sub.conns.push(JSON.parse(JSON.stringify(c)));
  for (const f of (g.flows || [])) if (ids.has(f.from) && ids.has(f.to)) sub.flows.push(JSON.parse(JSON.stringify(f)));
  const io = deriveGroupIO(sub);
  GROUPS[name] = { name: name, graph: sub, inputs: io.inputs, outputs: io.outputs };
  // 替换：移除选中节点及所有相关连线（外部连线断开，接口端口由组定义自动暴露）
  g.nodes = g.nodes.filter(function (n) { return !ids.has(n.id); });
  g.conns = g.conns.filter(function (c) { return !ids.has(c.from) && !ids.has(c.to); });
  g.flows = (g.flows || []).filter(function (f) { return !ids.has(f.from) && !ids.has(f.to); });
  g.nodes.push({ id: nextNodeId++, type: 'groupRef', p: { group: name }, x: (minX + maxX) / 2 - 60, y: (minY + maxY) / 2 - 30 });
  selNodeSet = new Set();
  selNodeIdx = -1;
  if (typeof renderVarUI === 'function') renderVarUI();
  renderNodeGraph();
  fillNodeCatSelect();
  alert('已打包为节点组「' + name + '」（输入 ' + io.inputs.length + ' / 输出 ' + io.outputs.length + '），可在「节点组」分类中添加使用，双击组节点可展开编辑。');
}
// 展开节点组：在画布上编辑组内图（增删节点/连线），完成后回到主图
function enterGroupEdit(name) {
  if (!GROUPS[name]) return;
  graphEditGroup = name;
  if (els.groupEditName) els.groupEditName.textContent = name;
  if (els.groupEditRow) els.groupEditRow.style.display = 'flex';
  if (els.scratchGroupDone) els.scratchGroupDone.style.display = ''; // 全屏模式也提供「完成」按钮
  graphView = { s: 1, ox: 30, oy: 30 };
  renderNodeGraph();
}
function doneGroupEdit() {
  graphEditGroup = null;
  if (els.groupEditRow) els.groupEditRow.style.display = 'none';
  if (els.scratchGroupDone) els.scratchGroupDone.style.display = 'none';
  renderNodeGraph();
  fillNodeCatSelect();
  if (scratchModeOn) { fillScratchCats(); fillScratchPalette(); }
}
// 导出所有节点组为 JSON 文件（可直接再导入）
function exportGroupsJS() {
  const data = {};
  for (const name of Object.keys(GROUPS)) {
    const grp = GROUPS[name];
    data[name] = { graph: grp.graph, inputs: grp.inputs, outputs: grp.outputs };
  }
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'node-groups-node.json');
}
// 导入节点组 JSON 文件
function importGroupsJS(file) {
  const fr = new FileReader();
  fr.onload = function () {
    try {
      const data = JSON.parse(fr.result);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('不是有效的节点组 JSON');
      const names = Object.keys(data);
      for (const name of names) registerNodeGroup(name, data[name]);
      alert('导入成功：' + names.length + ' 个节点组（共 ' + Object.keys(GROUPS).length + ' 个）。');
    } catch (err) {
      alert('导入失败：' + err.message);
    }
    fillNodeCatSelect();
    renderNodeGraph();
  };
  fr.readAsText(file);
}
function updateRunButton() {
  els.btnNodeRun.textContent = state.nodesRunning ? '⏹ 停止全部' : '▶ 运行全部';
  if (els.btnScratchRun) els.btnScratchRun.textContent = state.nodesRunning ? '⏹ 停止全部' : '▶ 运行全部';
  els.nodeRunHint.textContent = state.nodesRunning
    ? '运行中 · 画布上有 ' + state.instances.length + ' 个实例'
    : '已停止 · ' + state.instances.length + ' 个实例';
}

// ---------- 插件库（导入外部 JS 插件，注册节点类型与节点库） ----------
const PLUGINS_KEY = 'nd-plugins';
function loadPlugins() {
  try { return JSON.parse(localStorage.getItem(PLUGINS_KEY) || '[]'); } catch (e) { return []; }
}
function savePlugins(arr) {
  try { localStorage.setItem(PLUGINS_KEY, JSON.stringify(arr)); } catch (e) { /* 存储满忽略 */ }
}
let pluginNodeIds = new Set(); // 插件注册的节点 id（可右键编辑）
function applyPluginCode(code) {
  const re = /registerNodeType\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code || ''))) pluginNodeIds.add(m[1]);
  (0, eval)(code);
}
function loadAllPlugins() {
  for (const p of loadPlugins()) {
    try { applyPluginCode(p.code); } catch (e) { console.warn('插件加载失败: ' + (p.name || '') + ' · ' + e.message); }
  }
}
let tempPlugins = []; // 本次会话导入、尚未点「保存」的插件（刷新后丢失）
function renderPluginLib() {
  const savedBox = document.getElementById('scratchPluginSaved');
  const newBox = document.getElementById('scratchPluginNewBox');
  const infoBox = document.getElementById('scratchPluginInfo');
  const svBtn = document.getElementById('scratchBtnSavePlugin');
  if (svBtn) svBtn.style.display = tempPlugins.length ? '' : 'none';
  const saved = loadPlugins().map(function (x) { return { name: x.name, code: x.code, time: x.time, saved: true }; });
  const all = saved.concat(tempPlugins.map(function (x) { return { name: x.name, code: x.code, time: x.time, saved: false }; }));
  // 已保存插件：盒子外面、保存按钮上方（点击【保存】后的插件存放位置）
  if (savedBox) {
    savedBox.innerHTML = '';
    savedBox.style.display = saved.length ? 'block' : 'none';
    for (const p of saved) savedBox.appendChild(pluginItemEl(p, false));
  }
  // 盒子（导入按钮下方、保存按钮上方）：放本次导入、尚未保存的插件
  if (newBox) {
    newBox.innerHTML = '';
    for (const p of tempPlugins) newBox.appendChild(pluginItemEl(p, false));
  }
  // 导入信息按钮内容：全部插件条目（已保存 + 未保存）
  if (infoBox) {
    infoBox.innerHTML = '';
    if (!all.length) { infoBox.textContent = '暂无导入的插件'; return; }
    for (const p of all) infoBox.appendChild(pluginItemEl(p));
  }
}
// 生成单个插件条目（左键编辑、删除按钮、未保存标记）
function pluginItemEl(p, showMeta) {
  const item = document.createElement('div');
  item.className = 'plugin-item';
  item.title = '左键打开脚本编辑器修改 JS';
  const nodeCount = (p.code.match(/registerNodeType\s*\(/g) || []).length;
  const nm = document.createElement('span');
  nm.className = 'pi-name';
  nm.textContent = p.name || '插件';
  // 信息（节点数/日期/未保存）只在 📥 导入信息中显示；盒子条目不重复显示
  const meta = document.createElement('span');
  meta.className = 'pi-meta';
  meta.textContent = nodeCount + ' 个节点 · ' + new Date(p.time).toLocaleDateString() + (p.saved ? '' : ' · 未保存');
  const del = document.createElement('span');
  del.className = 'pi-del';
  del.textContent = '×';
  del.title = '删除插件';
  del.addEventListener('click', function (ev) {
    ev.stopPropagation();
    if (p.saved) {
      const cur = loadPlugins().filter(function (x) { return x.time !== p.time || x.name !== p.name; });
      savePlugins(cur);
      location.reload();
    } else {
      tempPlugins = tempPlugins.filter(function (x) { return x !== p; });
      renderPluginLib();
    }
  });
  // 左键插件类型盒子 → 显示该插件注册的节点库（像点击「输入」分类显示其节点一样）
  item.addEventListener('click', function () {
    showPluginNodes(p);
  });
  // 右键插件类型盒子 → 打开文本编辑器修改其中的 JS 代码（插件 code 含 // @locked 标记则锁定，不能编辑）
  item.addEventListener('contextmenu', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (p.code && p.code.indexOf('@locked') >= 0) return; // 插件已锁定：不能右键编辑
    openNodeJsEditor(p.code, '编辑插件「' + (p.name || '') + '」的 JS', { plugin: p });
  });
  item.appendChild(nm);            // 名称在前
  if (showMeta !== false) item.appendChild(meta); // meta 仅在 📥 导入信息中显示
  item.appendChild(del);           // 删除按钮在名称后面（画笔×）
  return item;
}
// 显示某插件的节点库（在节点库区域渲染该插件 code 中注册的全部节点）
function showPluginNodes(p) {
  const ids = [];
  const re = /registerNodeType\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(p.code || ''))) ids.push(m[1]);
  const lib = document.getElementById('scratchLib');
  if (lib) lib.style.display = '';
  const pal = els.scratchPalette;
  pal.innerHTML = '';
  const title = document.querySelector('#scratchLib .scratch-col-title');
  if (title) title.childNodes[0].textContent = (p.name || '插件') + ' 类型节点 ';
  if (!ids.length) {
    const note = document.createElement('span');
    note.className = 'layers-hint';
    note.textContent = '该插件未注册节点';
    pal.appendChild(note);
    return;
  }
  for (const id of ids) {
    const def = NODE_TYPES[id];
    if (!def) continue;
    const btn = document.createElement('button');
    btn.className = 'pb';
    btn.style.background = NODE_CATS[def.category] || '#22d3ee';
    btn.textContent = def.name;
    btn.title = (def.desc || '') + '（左键编辑 JS · 双击添加）';
    // 插件节点库：左键=添加到画布，右键=打开文本编辑器修改 JS
    btn.addEventListener('click', function () { addNodeToObject(id); });
    if (!def.noEdit) {
      btn.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openNodeJsEditor(NODE_DEF_SRC[id], '编辑节点「' + def.name + '」的 JS');
      });
    }
    pal.appendChild(btn);
  }
}
// 保存按钮：把本次会话导入的（未保存）插件永久保存到浏览器
function saveAllPlugins() {
  if (!tempPlugins.length) { alert('没有待保存的插件。'); return; }
  const n0 = tempPlugins.length;
  const arr = loadPlugins();
  for (const t of tempPlugins) arr.unshift({ name: t.name, code: t.code, time: t.time || Date.now() });
  savePlugins(arr);
  tempPlugins = [];
  renderPluginLib();
  alert('已保存 ' + n0 + ' 个插件到浏览器（刷新后仍然保留）。');
}
// ---------- 节点全局搜索（搜索框：搜所有类型节点库，含自制/插件） ----------
function renderSearchResults(q) {
  els.scratchPalette.innerHTML = '';
  // 搜索时隐藏插件盒/声音区/变量区等分类专属区域
  const pbox = document.getElementById('scratchPluginBox');
  if (pbox) pbox.style.display = 'none';
  const sb = document.getElementById('scratchSoundBlock');
  if (sb) sb.style.display = 'none';
  const vb = document.getElementById('scratchVarBlock');
  if (vb) vb.style.display = 'none';
  const sbc = document.getElementById('scratchBtnAddCustom');
  const sbs = document.getElementById('scratchBtnSaveCustom');
  if (sbc) sbc.style.display = 'none';
  if (sbs) sbs.style.display = 'none';
  const head = document.createElement('span');
  head.className = 'layers-hint';
  head.style.padding = '2px 2px 6px';
  head.textContent = '搜索「' + q + '」：';
  els.scratchPalette.appendChild(head);
  const results = [];
  for (const t of Object.keys(NODE_TYPES)) {
    const def = NODE_TYPES[t];
    if (!def || !def.name) continue;
    const hay = (def.name + ' ' + (def.desc || '') + ' ' + (def.category || '')).toLowerCase();
    if (hay.indexOf(q) >= 0) results.push(t);
  }
  results.sort();
  if (!results.length) {
    const note = document.createElement('span');
    note.className = 'n-note';
    note.textContent = '没有找到匹配的节点';
    els.scratchPalette.appendChild(note);
    return;
  }
  for (const t of results) {
    const def = NODE_TYPES[t];
    const btn = document.createElement('button');
    btn.className = 'pb';
    btn.style.background = NODE_CATS[def.category] || '#22d3ee';
    btn.textContent = def.name + '（' + def.category + '）';
    btn.title = (def.desc || '') + '（左键添加' + (((def.category === '自制' || pluginNodeIds.has(t)) && NODE_DEF_SRC[t] && !def.noEdit) ? ' · 右键编辑 JS' : '') + '）';
    btn.addEventListener('click', function () { addNodeToObject(t); });
    if ((def.category === '自制' || pluginNodeIds.has(t)) && NODE_DEF_SRC[t] && !def.noEdit) {
      btn.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openNodeJsEditor(NODE_DEF_SRC[t], '编辑节点「' + def.name + '」的 JS');
      });
    }
    els.scratchPalette.appendChild(btn);
  }
}
// ---------- 全屏模式（放大：节点库 + 大节点画布 + 舞台 + 实例信息） ----------
let scratchModeOn = false;
let scratchCat = '输入'; // 节点库当前分类
let stageView = { ox: 0, oy: 0, baseS: null }; // 舞台视口：ox/oy=左上世界坐标（格），baseS=内容铺满基准（CSS px/格）
let stagePan = null;

function openScratchMode() {
  window.__nodeEditorOpen = true;
  scratchModeOn = true;
  curGraphArea = els.scratchCanvas; // 节点画布切换到全屏
  if (!scratchModeOn) window.__nodeEditorOpen = false;
  els.nodePanel.classList.remove('open');
  els.scratchOverlay.classList.add('open');
  fillScratchCats();
  fillScratchPalette();
  renderNodeGraph();
  resizeStage();
  renderScratchSide();
  updateRunButton();
}
function closeScratchMode() {
  window.__nodeEditorOpen = false;
  scratchModeOn = false;
  curGraphArea = null;
  els.scratchOverlay.classList.remove('open');
  window.__nodeEditorOpen = true;
  els.nodePanel.classList.add('open');
  raiseSidePanel(els.nodePanel);
  renderNodeGraph();
  updateRunButton();
}
function fillScratchCats() {
  // 先把搜索框、插件库盒子与已保存插件区移出（避免被 innerHTML 清掉），重建后再放回（搜索框在顶部，插件区在「插件」按钮下方）
  const searchEl = document.getElementById('scratchSearchWrap');
  const pluginBox = document.getElementById('scratchPluginBox');
  const pluginSaved = document.getElementById('scratchPluginSaved');
  if (searchEl && searchEl.parentNode === els.scratchCats) els.scratchCats.removeChild(searchEl);
  if (pluginBox && pluginBox.parentNode === els.scratchCats) els.scratchCats.removeChild(pluginBox);
  if (pluginSaved && pluginSaved.parentNode === els.scratchCats) els.scratchCats.removeChild(pluginSaved);
  els.scratchCats.innerHTML = '';
  // 搜索框放回顶部（事件按钮正上方）
  if (searchEl) els.scratchCats.appendChild(searchEl);
  for (const cat of Object.keys(NODE_CATS)) {
    if (cat === '插件') continue; // 「插件」分类按钮单独添加（插件库）
    // 所有类型分类固定显示（含暂无节点的空分类，点击显示「暂无节点」提示）
    const btn = document.createElement('div');
    btn.className = 'cat' + (cat === scratchCat ? ' active' : '');
    btn.style.background = NODE_CATS[cat];
    btn.textContent = cat;
    btn.addEventListener('click', function () {
      scratchCat = cat;
      fillScratchCats();
      fillScratchPalette();
    });
    els.scratchCats.appendChild(btn);
  }
  // 「节点组」分类（打包好的子图，紫色）
  const gbtn = document.createElement('div');
  gbtn.className = 'cat' + (scratchCat === '节点组' ? ' active' : '');
  gbtn.style.background = '#a78bfa';
  gbtn.textContent = '节点组';
  gbtn.addEventListener('click', function () {
    scratchCat = '节点组';
    fillScratchCats();
    fillScratchPalette();
  });
  els.scratchCats.appendChild(gbtn);
  // 「插件」分类：打开插件库（与事件/运动/控制同一个盒子里的新盒子）
  const pbtn = document.createElement('div');
  pbtn.className = 'cat' + (scratchCat === '插件' ? ' active' : '');
  pbtn.style.background = NODE_CATS['插件'];
  pbtn.textContent = '插件';
  pbtn.addEventListener('click', function () {
    scratchCat = '插件';
    fillScratchCats();
    fillScratchPalette();
  });
  els.scratchCats.appendChild(pbtn);
  // 已保存插件区：常驻显示在「插件」按钮正下方（不用点击插件即可看到）
  if (pluginSaved) els.scratchCats.appendChild(pluginSaved);
  // 插件库盒子（点击插件分类时才展开）
  if (pluginBox) els.scratchCats.appendChild(pluginBox);
}
// 已保存插件常驻显示：始终渲染在「插件」分类按钮下方（不依赖当前分类，无需点击插件）
function renderSavedPlugins() {
  const savedBox = document.getElementById('scratchPluginSaved');
  if (!savedBox) return;
  const saved = loadPlugins().map(function (x) { return { name: x.name, code: x.code, time: x.time, saved: true }; });
  savedBox.innerHTML = '';
  savedBox.style.display = saved.length ? 'block' : 'none';
  for (const p of saved) savedBox.appendChild(pluginItemEl(p, false));
}
function fillScratchPalette() {
  // 搜索模式：搜索框有内容时全局搜索所有类型（含自制与插件节点）
  const q = (els.scratchSearch ? els.scratchSearch.value : '').trim().toLowerCase();
  if (q) { renderSearchResults(q); return; }
  renderSavedPlugins(); // 已保存插件常驻显示（无需点击插件分类）
  const pbox = document.getElementById('scratchPluginBox');
  const isPl = scratchCat === '插件';
  if (pbox) pbox.style.display = isPl ? 'block' : 'none';
  els.scratchPalette.innerHTML = '';
  // 声音区只在选中「声音」分类时展开显示（导入声音属于声音类型节点库）
  const sb = document.getElementById('scratchSoundBlock');
  if (sb) sb.style.display = (scratchCat === '声音') ? 'block' : 'none';
  const sbc = document.getElementById('scratchBtnAddCustom');
  const sbs = document.getElementById('scratchBtnSaveCustom');
  if (sbs) sbs.style.display = (scratchCat === '自制') ? '' : 'none';
  if (sbc) sbc.style.display = (scratchCat === '自制') ? '' : 'none';
  // 变量区只在选中「变量」分类时展开显示（新建变量属于变量类型节点库）
  const vb = document.getElementById('scratchVarBlock');
  // 变量/数组区只在选中「变量」分类时显示
  if (vb) vb.style.display = (scratchCat === '变量') ? '' : 'none';
  if (scratchCat === '插件') {
    // 已保存插件自动排列到【📂 导入插件】按钮下方（插件库盒子内）
    const savedBox = document.getElementById('scratchPluginSaved');
    const box = document.getElementById('scratchPluginBox');
    const imp = document.getElementById('scratchBtnImportPlugin');
    if (savedBox && box && imp && savedBox.parentNode !== box) {
      box.insertBefore(savedBox, imp.nextSibling);
    }
    renderPluginLib();
    return;
  }
  if (scratchCat === '节点组') { // 列出所有节点组，点击添加为单个组节点
    if (!Object.keys(GROUPS).length) {
      const note = document.createElement('span');
      note.className = 'layers-hint';
      note.textContent = '暂无节点组：框选画布节点后点「📦 打包」创建';
      els.scratchPalette.appendChild(note);
      return;
    }
    for (const name of Object.keys(GROUPS)) {
      const btn = document.createElement('button');
      btn.className = 'pb';
      btn.style.background = '#a78bfa';
      btn.textContent = name;
      btn.title = '添加节点组「' + name + '」（双击组节点可展开编辑）';
      btn.addEventListener('click', function () { addNodeToObject('groupRef:' + name); });
      els.scratchPalette.appendChild(btn);
    }
    return;
  }
  for (const t of Object.keys(NODE_TYPES)) {
    const def = NODE_TYPES[t];
    if (def.category !== scratchCat) continue;
    const btn = document.createElement('button');
    btn.className = 'pb';
    btn.style.background = NODE_CATS[def.category] || '#888';
    btn.textContent = def.name;
    btn.title = def.desc || '';
    // 自制/插件节点：左键=添加到画布，右键=打开脚本编辑器修改 JS
    btn.addEventListener('click', function () { addNodeToObject(t); });
    if ((def.category === '自制' || def.category === '插件') && NODE_DEF_SRC[t]) {
      btn.title = (def.desc || '') + '（左键添加 · 右键编辑 JS）';
      if (!def.noEdit) {
        btn.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openNodeJsEditor(NODE_DEF_SRC[t], '编辑节点「' + def.name + '」的 JS');
        });
      }
    }
    els.scratchPalette.appendChild(btn);
  }
  if (!els.scratchPalette.children.length) {
    const note = document.createElement('span');
    note.className = 'n-note';
    note.textContent = '该类型暂无节点（可新建自制节点或导入插件）';
    els.scratchPalette.appendChild(note);
  }
}
// 舞台：正方形，实时预览主画布（右上角）；舞台大小与网格大小分别可调。
// 舞台变大时右侧栏跟随变宽（压缩左侧节点画布），且永不超过屏幕，避免溢出到屏幕外。
let stageFloating = false; // 舞台是否处于独立浮动窗口
// 只设置舞台正方形尺寸（不改右栏宽度）
function applyStageSize(s) {
  const sc = els.stageCanvas;
  const d = dpr();
  sc.style.width = s + 'px';
  sc.style.height = s + 'px';
  sc.width = Math.round(s * d);
  sc.height = Math.round(s * d);
  els.stageBox.style.width = s + 'px';
  els.stageBox.style.height = s + 'px';
  if (stageFloating) document.getElementById('stageFloatBody').style.height = (s + 16) + 'px';
}
function resizeStage() {
  // 舞台尺寸 = 所在容器可用宽（浮动窗宽 或 右侧栏宽），正方形，不超屏高 60%
  const avail = stageFloating
    ? (document.getElementById('stageFloatWin').offsetWidth - 24)
    : (els.scratchRight.clientWidth - 20);
  const s = Math.round(Math.max(120, Math.min(avail, cssH() * 0.6)));
  applyStageSize(s);
  if (!stageFloating) {
    els.scratchRight.style.flexBasis = Math.max(220, s + 30) + 'px';
  }
  if (typeof fitStageView === 'function' && stageView.baseS) {
    // 尺寸变化后保持内容铺满
  }
}
function stageLoop() {
  requestAnimationFrame(stageLoop);
  if (!scratchModeOn) return;
  const sc = els.stageCanvas;
  if (sc.width === 0 || !state.layers || !state.layers.length) return;
  if (!stageView.baseS || (!stageView._everShown && computeContentBounds())) fitStageView(); // 首次 / 世界有内容但从未显示过 → 自动对准内容
  const cc = sc.getContext('2d');
  const d = dpr();
  cc.setTransform(d, 0, 0, d, 0, 0); // 用 CSS 像素坐标
  cc.imageSmoothingEnabled = false;
  const W = sc.width / d, H = sc.height / d; // CSS 尺寸
  // 画布背景（与主画布一致：白色）
  cc.fillStyle = '#ffffff';
  cc.fillRect(0, 0, W, H);
  const grid = Math.max(5, +els.stageGrid.value || 100) / 100;
  const s = (stageView.baseS || 1) * grid; // CSS px / 格（缩放）
  const ox = stageView.ox || 0, oy = stageView.oy || 0;
  const gx0 = Math.floor(ox), gx1 = Math.floor(ox + W / s);
  const gy0 = Math.floor(oy), gy1 = Math.floor(oy + H / s);
  // 网格线（自动步进，线距 >= 12px）
  let step = 1;
  while (s * step < 12) step *= 2;
  cc.strokeStyle = 'rgba(0,0,0,.14)';
  cc.lineWidth = 1;
  const gxs = Math.ceil(gx0 / step) * step;
  for (let gxi = gxs; gxi <= gx1; gxi += step) {
    const px = (gxi - ox) * s;
    cc.beginPath(); cc.moveTo(px, 0); cc.lineTo(px, H); cc.stroke();
  }
  const gys = Math.ceil(gy0 / step) * step;
  for (let gyi = gys; gyi <= gy1; gyi += step) {
    const py = (gyi - oy) * s;
    cc.beginPath(); cc.moveTo(0, py); cc.lineTo(W, py); cc.stroke();
  }
  // 坐标轴（世界 x=0 / y=0 轴线）
  if (state.showAxis) {
    cc.strokeStyle = (typeof AXIS_COLOR !== 'undefined') ? AXIS_COLOR : '#8a8f9a';
    cc.lineWidth = 1.6;
    cc.beginPath();
    if (gx0 <= 0 && 0 <= gx1) { const sx = (0 - ox) * s + 0.5; cc.moveTo(sx, 0); cc.lineTo(sx, H); }
    if (gy0 <= 0 && 0 <= gy1) { const sy = (0 - oy) * s + 0.5; cc.moveTo(0, sy); cc.lineTo(W, sy); }
    cc.stroke();
  }
  // 世界像素（按格子绘制；格子过多时跳步防卡）
  const cells = (gx1 - gx0 + 1) * (gy1 - gy0 + 1);
  const jstep = cells > 30000 ? Math.ceil(cells / 30000) : 1;
  for (let gy = gy0; gy <= gy1; gy += jstep) {
    for (let gx = gx0; gx <= gx1; gx += jstep) {
      const c = worldPixel(gx, gy);
      if (!c) continue;
      stageView._everShown = true; // 视图已显示过内容（此后不再自动跳动）
      cc.fillStyle = c;
      cc.fillRect((gx - ox) * s, (gy - oy) * s, s * jstep, s * jstep);
    }
  }
  // 实例（该图层可见的对象，画在像素之上）
  drawStageInstances(cc, s, ox, oy);
  updateInstInfo();
}
// 内容包围盒（所有可见图层非空像素范围）
function computeContentBounds() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const L of state.layers) {
    if (!L.visible) continue;
    for (const key of L.pixels.keys()) {
      const i = key.indexOf(',');
      const gx = +key.slice(0, i), gy = +key.slice(i + 1);
      if (gx < x0) x0 = gx; if (gx > x1) x1 = gx;
      if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
    }
  }
  if (x1 < x0) return null;
  return { x0: x0, y0: y0, x1: x1, y1: y1 };
}
// 舞台视图：内容自适应铺满（等比、格子正方、居中），grid 100 = 铺满
function fitStageView() {
  const sc = els.stageCanvas;
  if (!sc || sc.width === 0) return;
  const d = dpr();
  const W = sc.width / d;
  const b = computeContentBounds();
  let w, h;
  if (b) {
    w = b.x1 - b.x0 + 9; h = b.y1 - b.y0 + 9; // 内容范围 + 留白（决定缩放基准）
  } else {
    w = 200; h = 200;
  }
  const s = Math.min(W / w, W / h); // 等比铺满（正方格子）
  stageView.baseS = s;
  // 坐标轴原点 (0,0) 居中于舞台画布
  stageView.ox = -W / s / 2;
  stageView.oy = -W / s / 2;
  els.stageGrid.value = 100;
  els.stageGridVal.textContent = '100';
}
// 舞台画实例（对象模板图缩放到舞台坐标，画在世界位置）
function drawStageInstances(cc, s, ox, oy) {
  if (!state.instances.length) return;
  for (const inst of state.instances) {
    const ili = inst.layerIdx === undefined ? 0 : inst.layerIdx;
    if (!state.layers[ili] || !state.layers[ili].visible) continue;
    const obj = state.objects[inst.objectIdx];
    if (!obj) continue;
    let img = objCanvases.get(obj.id);
    if (!img) { img = buildObjectCanvas(obj); objCanvases.set(obj.id, img); }
    const ix = Math.round(inst.x), iy = Math.round(inst.y);
    cc.drawImage(img, (ix - ox) * s, (iy - oy) * s, obj.w * s, obj.h * s);
    if (inst.id === selInstId) { // 选中高亮框
      cc.strokeStyle = 'rgba(30, 200, 120, .95)';
      cc.lineWidth = 1.5;
      cc.setLineDash([3, 2]);
      cc.strokeRect((ix - ox) * s - 0.5, (iy - oy) * s - 0.5, obj.w * s + 1, obj.h * s + 1);
      cc.setLineDash([]);
    }
  }
}
// 查世界像素颜色（所有可见图层，顶层优先；null = 空 → 画板灰底）
function worldPixel(gx, gy) {
  const key = gx + ',' + gy;
  for (let li = state.layers.length - 1; li >= 0; li--) {
    const L = state.layers[li];
    if (!L.visible) continue;
    const c = L.pixels.get(key);
    if (c) return c;
  }
  return null;
}
// 节点库（左侧列）宽度拖拽调节：鼠标按住右边缘拖动
let libResize = null;
(function () {
  if (!els.scratchLib) return;
  // 分类栏右缘拖拽把手（分类栏 ↔ 节点库 分界）
  let catsResize = null;
  const catsDivider = document.getElementById('catsDivider');
  if (catsDivider) catsDivider.addEventListener('pointerdown', function (e) {
    catsResize = { x: e.clientX, w: els.scratchCats.getBoundingClientRect().width };
    e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) {
    if (!catsResize) return;
    els.scratchCats.style.width = Math.max(90, Math.min(220, catsResize.w + (e.clientX - catsResize.x))) + 'px';
  });
  document.addEventListener('pointerup', function () { catsResize = null; });
  // 节点库右缘拖拽把手（可见竖条，避免被画布遮挡）
  const libDivider = document.getElementById('libDivider');
  (libDivider || els.scratchLib).addEventListener('pointerdown', function (e) {
    const r = els.scratchLib.getBoundingClientRect();
    libResize = { x: e.clientX, w: r.width };
    e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) {
    if (!libResize) return;
    const w = Math.max(120, Math.min(340, libResize.w + (e.clientX - libResize.x)));
    els.scratchLib.style.width = w + 'px';
  });
  document.addEventListener('pointerup', function () { libResize = null; });
})();
// 全屏右下：对象选择 + 实例列表 + 实例化/删除（方便随时选择对象并添加到画布）
function renderScratchSide() {
  if (!scratchModeOn) return;
  const sel = els.scratchObjSel;
  sel.innerHTML = '';
  state.objects.forEach(function (o, i) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = (o.name || '对象' + i) + (o.kind ? '（' + o.kind + '）' : '');
    if (i === selObjIdx) opt.selected = true;
    sel.appendChild(opt);
  });
  const list = els.scratchInstList;
  list.innerHTML = '';
  if (!state.instances.length) {
    list.innerHTML = '<div class="n-note">暂无实例，选择对象后点「⬇ 实例化」</div>';
  }
  state.instances.forEach(function (it) {
    const div = document.createElement('div');
    div.className = 'node-inst' + (it.id === selInstId ? ' active' : '');
    const obj = state.objects[it.objectIdx];
    div.innerHTML = '<span>#' + it.id + ' ' + escapeHtml(obj ? obj.name : '?') + '</span>' +
      '<span class="layers-hint">(' + Math.round(it.x) + ',' + Math.round(it.y) + ')</span>' +
      '<span class="del" title="删除此实例">🗑</span>';
    div.querySelector('.del').addEventListener('click', function (e) {
      e.stopPropagation();
      deleteInstance(it.id);
    });
    div.addEventListener('click', function () {
      selInstId = it.id;
      renderScratchSide();
      requestRender();
    });
    list.appendChild(div);
  });
}
// 实例信息（右下方）
function updateInstInfo() {
  const el = els.instInfo;
  const inst = state.instances.find(function (it) { return it.id === selInstId; });
  if (!inst) {
    el.innerHTML = '<div class="n-note">未选中实例。回到画布点击实例（绿色框）或在下方的实例列表里选择。</div>';
    return;
  }
  const obj = state.objects[inst.objectIdx];
  const li = inst.layerIdx === undefined ? 0 : inst.layerIdx;
  const L = state.layers[li];
  let html = '<b>' + escapeHtml(obj ? obj.name : '?') + '</b> <span class="layers-hint">#' + inst.id + '</span><br>';
  html += '图层：' + (L ? escapeHtml(L.name) : '?') + '<br>';
  html += '位置：(' + Math.round(inst.x) + ', ' + Math.round(inst.y) + ')<br>';
  html += '方向：' + (inst.st.dir === undefined ? '—' : Math.round(inst.st.dir)) + '°<br>';
  if (inst.st && inst.st.vars) {
    const keys2 = Object.keys(inst.st.vars);
    if (keys2.length) {
      html += '变量：';
      for (const k of keys2) html += '<b>' + escapeHtml(k) + '</b>=' + (Math.round(inst.st.vars[k] * 10) / 10) + ' ';
    }
  }
  el.innerHTML = html;
}

// ---------- 事件绑定 ----------
els.btnOpenNodeEditor.addEventListener('click', function () {
  els.moreMenu.classList.remove('open');
  window.__nodeEditorOpen = true;
  els.nodePanel.classList.add('open');
  raiseSidePanel(els.nodePanel);
  // 「框选添加对象」工具已合并到节点编辑器入口：打开时自动启用（框选像素 → 创建对象）
  setTool('nodeSelect');
  fillNodeCatSelect();
  renderNodePanel();
});
els.btnCloseNode.addEventListener('click', function () {
  if (!scratchModeOn) window.__nodeEditorOpen = false;
  els.nodePanel.classList.remove('open');
});
// 「添加对象」工具（节点编辑器左下角）：启用框选像素 → 剪切为对象
els.btnNodeAddObj.addEventListener('click', function () { setTool('nodeSelect'); });
// 名称输入框：实时重命名选中对象
els.nodeNameInput.addEventListener('input', function () {
  if (selObjIdx >= 0) state.objects[selObjIdx].name = els.nodeNameInput.value;
});
// 实例化 / 删除实例
els.btnNodeInstance.addEventListener('click', function () {
  if (selObjIdx < 0) return;
  instantiateObject(selObjIdx);
});
els.btnInstDel.addEventListener('click', function () {
  if (selInstId >= 0) deleteInstance(selInstId);
  else alert('请先在画布上点击要删除的实例（出现绿色框），或在左侧实例列表中选中它。');
});
// 添加节点
els.btnNodeAdd.addEventListener('click', function () {
  const cat = els.nodeCatSelect.value;
  const type = els.nodeTypeSelect.value;
  // 自制分类：点击「添加」弹出 JS 编辑器（文字框 + 基础模板），直接编写新节点
  if (cat === '自制') { openNewNodeEditor(); return; }
  if (!type) { alert('请先选择节点类型（「节点组」分类中选择一个组）。'); return; }
  addNodeToObject(type);
});
// 打包选中节点为节点组
els.btnPackGroup.addEventListener('click', function () { packSelectedAsGroup(); });
// 导出 / 导入节点组 JS 文件
els.btnExportGroups.addEventListener('click', function () {
  if (!Object.keys(GROUPS).length) { alert('还没有节点组：先在画布上框选节点后点「📦 打包」。'); return; }
  exportGroupsJS();
});
els.btnImportGroups.addEventListener('click', function () { els.importGroupsFile.click(); });
els.importGroupsFile.addEventListener('change', function () {
  if (els.importGroupsFile.files && els.importGroupsFile.files[0]) importGroupsJS(els.importGroupsFile.files[0]);
  els.importGroupsFile.value = '';
});
// 完成节点组编辑
els.btnGroupDone.addEventListener('click', function () { doneGroupEdit(); });
els.scratchGroupDone.addEventListener('click', function () { doneGroupEdit(); });
// 全屏模式的节点组工具
const btnPluginHelp = document.getElementById('btnPluginHelp');
if (btnPluginHelp) btnPluginHelp.addEventListener('click', function () {
  const hp = document.getElementById('scratchPluginHelp');
  if (hp) hp.style.display = hp.style.display === 'block' ? 'none' : 'block';
});
const btnPluginInfo = document.getElementById('btnPluginInfo');
if (btnPluginInfo) btnPluginInfo.addEventListener('click', function () {
  const ib = document.getElementById('scratchPluginInfo');
  if (!ib) return;
  if (ib.style.display === 'block') { ib.style.display = 'none'; return; }
  renderPluginLib();
  ib.style.display = 'block';
});
const scratchBtnImportPlugin = document.getElementById('scratchBtnImportPlugin');
if (scratchBtnImportPlugin) scratchBtnImportPlugin.addEventListener('click', function () { els.scratchPluginFile.click(); });
const scratchBtnSavePlugin = document.getElementById('scratchBtnSavePlugin');
if (scratchBtnSavePlugin) scratchBtnSavePlugin.addEventListener('click', saveAllPlugins);
els.scratchPluginFile.addEventListener('change', function () {
  const f = els.scratchPluginFile.files && els.scratchPluginFile.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = function () {
    const code = String(reader.result || '');
    try { applyPluginCode(code); }
    catch (e) { alert('插件执行失败：' + e.message + '（请检查插件代码）'); els.scratchPluginFile.value = ''; return; }
    tempPlugins.unshift({ name: f.name.replace(/\.js$/i, '') || '插件', code: code, time: Date.now() });
    els.scratchPluginFile.value = '';
    renderPluginLib();
    alert('插件「' + f.name + '」已导入并临时生效（节点已注册）。点击插件库下方【保存】可永久保存，否则刷新后会重置。');
  };
  reader.readAsText(f);
});
els.scratchBtnPack.addEventListener('click', function () { packSelectedAsGroup(); });
els.scratchBtnExport.addEventListener('click', function () {
  if (!Object.keys(GROUPS).length) { alert('还没有节点组：先在画布上框选节点后点「📦 打包」。'); return; }
  exportGroupsJS();
});
els.scratchBtnImport.addEventListener('click', function () { els.importGroupsFile.click(); });
// 用法提示
els.btnNodeHint.addEventListener('click', function () {
  alert('节点用法（Blender 几何节点式）：\n\n' +
    '· 添加节点：选分类与类型，点「➕ 添加」\n' +
    '· 连线：点节点右侧黄色输出端口 → 拖到左侧蓝色输入端口（类型必须一致：向量/数字）\n' +
    '· 点 × 删除节点，点连线删除；拖动节点调整布局（滚轮缩放画布，空白处拖动平移）\n' +
    '· 动作节点（移动/设置位置）每帧执行，最终驱动实例\n\n' +
    '组合示例：\n' +
    '· 键盘移动：键盘输入 → 移动\n' +
    '· 随机漫游：随机向量 → 移动\n' +
    '· 追踪目标：目标位置 ⊖ 自身位置 → 向量单位化 → 向量缩放 → 移动\n' +
    '· 鼠标跟随：鼠标位置 ⊖ 自身位置 → 向量单位化 → 向量缩放 → 移动\n' +
    '· 碰到边缘反弹：碰到边缘? → 选择（真=取反方向，假=当前方向）→ 移动\n' +
    '· 速度控制：键盘输入 → 向量缩放（倍数=变量值）→ 移动\n\n' +
    '变量：先在下方输入框建变量（每个实例的值独立），再用「变量」分类的节点读写\n' +
    '扩展：「自制」分类的节点由「其他节点」文件夹中的 .js 文件注册（见 wasd-move.js / ccc.js 示例）——' +
    '新加文件后必须在 index.html 的 <script> 区加一行引用（浏览器不会自动加载文件夹里的文件），刷新才生效。');
});
// 运行 / 停止
els.btnNodeRun.addEventListener('click', function () {
  state.nodesRunning = !state.nodesRunning;
  if (!state.nodesRunning) stopAllSounds(); // 停止全部运行时同时停止所有声音
  updateRunButton();
  requestRender();
});
// 分类下拉联动
els.nodeCatSelect.addEventListener('change', fillNodeTypeSelect);
// 节点画布缩放按钮
els.btnZoomIn.addEventListener('click', function () { zoomGraph(1.25); });
els.btnZoomOut.addEventListener('click', function () { zoomGraph(0.8); });
els.btnZoomReset.addEventListener('click', function () { graphView = { s: 1, ox: 30, oy: 30 }; renderNodeGraph(); });
// 变量管理（每个对象有自己的变量列表，实例的值独立）
function addVariable(inputEl) {
  // 未选中对象时自动用第一个对象（避免"添加不了"）
  if (selObjIdx < 0 || !state.objects[selObjIdx]) {
    if (state.objects.length) selObjIdx = 0;
    else { alert('请先创建/选择一个对象。'); return; }
    if (typeof renderScratchSide === 'function') renderScratchSide();
    renderNodePanel();
  }
  const obj = state.objects[selObjIdx];
  const name = (inputEl.value || '').trim();
  if (!name) { alert('请输入变量名。'); return; }
  if (obj.vars.indexOf(name) >= 0) { alert('变量已存在：' + name); return; }
  obj.vars.push({ name: name, value: 0 }); // 变量对象：{ 名称, 默认值 }（值可为数字或字符串，布尔用 0/1）
  inputEl.value = '';
  renderVarUI();
  renderNodeGraph();
}
function parseVarValue(str) {
  const t = String(str == null ? '' : str).trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}
// 构建变量默认值编辑表（数字或字符串；布尔用 0/1）
function buildVarTable(box, v) {
  const cur = (v && v.value !== undefined) ? v.value : 0;
  box.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'arr-table-row';
  row.innerHTML = '<label>值</label><input type="text" class="var-val" value="' + String(cur).replace(/"/g, '&quot;') + '" style="flex:1">';
  const foot = document.createElement('div');
  foot.className = 'arr-table-foot';
  const apply = document.createElement('button');
  apply.className = 'btn';
  apply.textContent = '✔ 应用';
  apply.addEventListener('click', function () {
    v.value = parseVarValue(row.querySelector('.var-val').value);
    // 同步：把新默认值立即应用到该对象所有已存在实例（否则实例仍用旧值，运行不生效）
    const vname = (v && v.name) || v;
    for (const it of state.instances) {
      if (it.objectIdx === selObjIdx) {
        if (!it.st.vars) it.st.vars = {};
        it.st.vars[vname] = v.value;
      }
    }
    renderVarUI();
  });
  const close = document.createElement('button');
  close.className = 'btn';
  close.textContent = '收起';
  close.addEventListener('click', function () { box.style.display = 'none'; });
  foot.appendChild(apply);
  foot.appendChild(close);
  box.appendChild(row);
  box.appendChild(foot);
}
// 选中节点联动：若当前选中的节点引用了该变量/数组，且有选中实例 → 返回实例当前值（供列表预览）
function currentVarPreview(obj, vname) {
  if (selNodeIdx < 0) return undefined;
  const g = currentGraph();
  if (!g) return undefined;
  const node = g.nodes.find(function (n) { return n.id === selNodeIdx; });
  if (!node) return undefined;
  const def = NODE_TYPES[node.type];
  if (!def || !def.params) return undefined;
  const hasVar = def.params.some(function (prm) { return prm.key === 'var' && (node.p[prm.key]) === vname; });
  if (!hasVar) return undefined;
  const inst = state.instances.find(function (it) { return it.id === selInstId; });
  if (!inst || !inst.st || !inst.st.vars) return undefined;
  const v = inst.st.vars[vname];
  if (v === undefined) return undefined;
  return (typeof v === 'string') ? '"' + v + '"' : v;
}
function currentArrPreview(obj, aname) {
  if (selNodeIdx < 0) return undefined;
  const g = currentGraph();
  if (!g) return undefined;
  const node = g.nodes.find(function (n) { return n.id === selNodeIdx; });
  if (!node) return undefined;
  const def = NODE_TYPES[node.type];
  if (!def || !def.params) return undefined;
  const hasArr = def.params.some(function (prm) { return prm.key === 'arr' && (node.p[prm.key]) === aname; });
  if (!hasArr) return undefined;
  const inst = state.instances.find(function (it) { return it.id === selInstId; });
  if (!inst || !inst.st || !inst.st.arrs) return undefined;
  const a = inst.st.arrs[aname];
  if (!Array.isArray(a)) return undefined;
  // 组数多时只预览第 0 组前几项
  const g0 = Array.isArray(a[0]) ? a[0] : a;
  return '[' + g0.slice(0, 6).join(',') + (g0.length > 6 ? ',…' : '') + ']';
}
function renderVarUI() {
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  const hint = obj
    ? ('变量：' + (obj.vars && obj.vars.length ? obj.vars.length + ' 个' : '（无）') + ' · 数组：' + (obj.arrs && obj.arrs.length ? obj.arrs.length + ' 个' : '（无）'))
    : '选中对象后创建变量';
  els.varHint.textContent = hint;
  // 全屏节点库：已添加的变量名称列表（显示在「添加新变量」按钮下方）
  if (els.scratchVarList) {
    els.scratchVarList.innerHTML = '';
    if (obj && obj.vars && obj.vars.length) {
      for (const v of obj.vars) {
        const vname = (v && v.name) || v;
        const item = document.createElement('div');
        item.className = 'scratch-var-item';
        const nm = document.createElement('span');
        nm.className = 'sv-name';
        // 显示名称 + 默认值；若选中了引用该变量的节点且有选中实例，显示该实例当前值（取消选择恢复默认值）
        const dispVal = currentVarPreview(obj, vname);
        nm.textContent = vname + (dispVal !== undefined ? ' = ' + dispVal : '');
        const edit = document.createElement('button');
        edit.className = 'sv-del';
        edit.textContent = '📝';
        edit.title = '设置变量「' + vname + '」的默认值（数字或字符串；布尔用 0/1）';
        const del = document.createElement('button');
        del.className = 'sv-del';
        del.textContent = '🗑';
        del.title = '删除变量「' + vname + '」';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          const i = obj.vars.indexOf(v);
          if (i >= 0) obj.vars.splice(i, 1);
          renderVarUI();
          renderNodeGraph();
        });
        const box = document.createElement('div');
        box.className = 'scratch-arr-table';
        box.style.display = 'none';
        edit.addEventListener('click', function (e) {
          e.stopPropagation();
          const show = box.style.display === 'none';
          box.style.display = show ? '' : 'none';
          if (show) buildVarTable(box, v);
        });
        item.appendChild(nm);
        item.appendChild(edit);
        item.appendChild(del);
        item.appendChild(box);
        els.scratchVarList.appendChild(item);
      }
    } else {
      const note = document.createElement('span');
      note.className = 'n-note sv-note';
      note.textContent = '（暂无变量，输入名称点「添加新变量」）';
      els.scratchVarList.appendChild(note);
    }
  }
  // 全屏节点库：数组列表（名称 + 删除 + 编辑表格，表格默认隐藏）
  const arrList = document.getElementById('scratchArrList');
  if (arrList) {
    arrList.innerHTML = '';
    if (obj && obj.arrs && obj.arrs.length) {
      for (const a of obj.arrs) {
        const aname = (a && a.name) || '';
        const item = document.createElement('div');
        item.className = 'scratch-var-item scratch-arr-item';
        const nm = document.createElement('span');
        nm.className = 'sv-name';
        // 名称 + 容量 + 预览（选中引用该数组的节点且有实例时显示实例当前值）
        const dispArr = currentArrPreview(obj, aname);
        nm.textContent = aname + '（' + ((a && a.size) || 10) + '）' + (dispArr !== undefined ? ' = ' + dispArr : '');
        const edit = document.createElement('button');
        edit.className = 'sv-del';
        edit.textContent = '📝';
        edit.title = '编辑数组「' + aname + '」：数量与索引值（表格默认隐藏）';
        const del = document.createElement('button');
        del.className = 'sv-del';
        del.textContent = '🗑';
        del.title = '删除数组「' + aname + '」';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          const i = obj.arrs.indexOf(a);
          if (i >= 0) obj.arrs.splice(i, 1);
          renderVarUI();
          renderNodeGraph();
        });
        const box = document.createElement('div');
        box.className = 'scratch-arr-table';
        box.style.display = 'none';
        edit.addEventListener('click', function (e) {
          e.stopPropagation();
          const show = box.style.display === 'none';
          box.style.display = show ? '' : 'none';
          if (show) buildArrTable(box, a);
        });
        item.appendChild(nm);
        item.appendChild(edit);
        item.appendChild(del);
        item.appendChild(box);
        arrList.appendChild(item);
      }
    } else {
      const note = document.createElement('span');
      note.className = 'n-note sv-note';
      note.textContent = '（暂无数组，输入名称点「添加新数组」）';
      arrList.appendChild(note);
    }
  }
}
// 构建数组编辑表格：数量(容量) + 索引/值行
function buildArrTable(box, arr) {
  const size = (arr.size && arr.size > 0) ? arr.size : 10;
  let groups = (arr.groups && arr.groups > 0) ? arr.groups : 1;
  // values 为嵌套数组 [组][索引]（兼容旧扁平数据：应用时统一为嵌套）
  let vals = arr.values;
  if (!Array.isArray(vals) || !vals.length) vals = [];
  if (!Array.isArray(vals[0])) vals = [vals]; // 旧扁平 → 当作第 0 组
  let curGroup = 0;
  box.innerHTML = '';
  // 行1：数量（容量）
  const row1 = document.createElement('div');
  row1.className = 'arr-table-row';
  row1.innerHTML = '<label>数量</label><input type="number" class="arr-size" min="1" max="1024" value="' + size + '">';
  // 行2：组（组数 = 几维/几组；2 = 二维数组）
  const rowGrp = document.createElement('div');
  rowGrp.className = 'arr-table-row arr-grp-row';
  const grpLabel = document.createElement('label');
  grpLabel.textContent = '组';
  const grpMinus = document.createElement('button');
  grpMinus.className = 'sv-del';
  grpMinus.textContent = '−';
  const grpVal = document.createElement('span');
  grpVal.className = 'arr-grp-val';
  grpVal.textContent = groups;
  const grpPlus = document.createElement('button');
  grpPlus.className = 'sv-del';
  grpPlus.textContent = '+';
  rowGrp.appendChild(grpLabel);
  rowGrp.appendChild(grpMinus);
  rowGrp.appendChild(grpVal);
  rowGrp.appendChild(grpPlus);
  // 滑动条行（组 >= 2 时显示，左右滑动切换查看/编辑的组）
  const slideRow = document.createElement('div');
  slideRow.className = 'arr-table-row arr-slide-row';
  slideRow.style.display = groups >= 2 ? '' : 'none';
  const slide = document.createElement('input');
  slide.type = 'range';
  slide.min = 0;
  slide.max = Math.max(0, groups - 1);
  slide.value = 0;
  slide.style.flex = '1';
  const slideLabel = document.createElement('span');
  slideLabel.className = 'arr-idx';
  slideLabel.textContent = '第 1/' + groups + ' 组';
  slideRow.appendChild(slideLabel);
  slideRow.appendChild(slide);
  // 值行
  const rows = document.createElement('div');
  rows.className = 'arr-rows';
  const drawRows = function () {
    rows.innerHTML = '';
    const n = Math.max(1, parseInt(box.querySelector('.arr-size').value, 10) || 1);
    const g = Math.min(Math.max(0, curGroup), Math.max(0, groups - 1));
    const gv = vals[g] || [];
    for (let i = 0; i < n; i++) {
      const r = document.createElement('div');
      r.className = 'arr-table-row';
      r.innerHTML = '<span class="arr-idx">' + g + '.' + i + '</span><input type="number" class="arr-val" step="any" value="' + ((gv[i] === undefined) ? 0 : gv[i]) + '">';
      rows.appendChild(r);
    }
  };
  row1.querySelector('.arr-size').addEventListener('input', drawRows);
  grpPlus.addEventListener('click', function () {
    groups = Math.min(32, groups + 1);
    grpVal.textContent = groups;
    slide.max = groups - 1;
    slideRow.style.display = groups >= 2 ? '' : 'none';
    slideLabel.textContent = '第 ' + (curGroup + 1) + '/' + groups + ' 组';
    drawRows();
  });
  grpMinus.addEventListener('click', function () {
    if (groups <= 1) return;
    groups = groups - 1;
    if (curGroup >= groups) curGroup = groups - 1;
    grpVal.textContent = groups;
    slide.max = Math.max(0, groups - 1);
    slide.value = curGroup;
    slideRow.style.display = groups >= 2 ? '' : 'none';
    slideLabel.textContent = '第 ' + (curGroup + 1) + '/' + groups + ' 组';
    drawRows();
  });
  slide.addEventListener('input', function () {
    curGroup = parseInt(slide.value, 10) || 0;
    slideLabel.textContent = '第 ' + (curGroup + 1) + '/' + groups + ' 组';
    drawRows();
  });
  const foot = document.createElement('div');
  foot.className = 'arr-table-foot';
  const apply = document.createElement('button');
  apply.className = 'btn';
  apply.textContent = '✔ 应用';
  apply.addEventListener('click', function () {
    const n = Math.max(1, parseInt(box.querySelector('.arr-size').value, 10) || 1);
    arr.size = n;
    arr.groups = groups;
    // 收集所有组的值（先读当前输入，其他组保留原值）
    const newVals = [];
    for (let g = 0; g < groups; g++) {
      const rowArr = [];
      for (let i = 0; i < n; i++) rowArr.push(0);
      newVals.push(rowArr);
    }
    // 保留旧值（非当前组）
    for (let g = 0; g < groups && g < vals.length; g++) {
      if (g === curGroup) continue;
      for (let i = 0; i < n; i++) newVals[g][i] = (vals[g][i] === undefined) ? 0 : vals[g][i];
    }
    // 当前组读输入
    rows.querySelectorAll('.arr-val').forEach(function (inp, i) {
      const v = parseFloat(inp.value);
      newVals[curGroup][i] = isFinite(v) ? v : 0;
    });
    arr.values = newVals;
    renderVarUI();
  });
  const close = document.createElement('button');
  close.className = 'btn';
  close.textContent = '收起';
  close.addEventListener('click', function () { box.style.display = 'none'; });
  foot.appendChild(apply);
  foot.appendChild(close);
  box.appendChild(row1);
  box.appendChild(rowGrp);
  box.appendChild(slideRow);
  box.appendChild(rows);
  box.appendChild(foot);
  drawRows();
}
function addArray(inputEl) {
  // 未选中对象时自动用第一个对象
  if (selObjIdx < 0 || !state.objects[selObjIdx]) {
    if (state.objects.length) selObjIdx = 0;
    else { alert('请先创建/选择一个对象。'); return; }
    if (typeof renderScratchSide === 'function') renderScratchSide();
    renderNodePanel();
  }
  const obj = state.objects[selObjIdx];
  const name = (inputEl.value || '').trim();
  if (!name) { alert('请输入数组名。'); return; }
  if (obj.arrs.some(function (a) { return (a && a.name) === name; })) { alert('数组已存在：' + name); return; }
  // 数组对象：{ name 名称, size 数量(容量), groups 组数(维度), values 索引值 }——表格默认隐藏，可编辑
  obj.arrs.push({ name: name, size: 10, groups: 1, values: [] });
  inputEl.value = '';
  renderVarUI();
  renderNodeGraph();
}
els.btnVarAdd.addEventListener('click', function () { addVariable(els.varNameInput); });
els.scratchVarBtn.addEventListener('click', function () { addVariable(els.scratchVarNameInput); });
const scratchArrBtn = document.getElementById('scratchArrBtn');
if (scratchArrBtn) scratchArrBtn.addEventListener('click', function () { addArray(document.getElementById('scratchArrNameInput')); });

// 声音导入 / 管理（小面板与全屏编辑器共用同一个隐藏文件选择框；
// change 按文件类型分发：音频 → importSoundFile，JSON 工程 → importSongFile，见文件末尾）
const btnSoundImport = document.getElementById('btnSoundImport');
const scratchBtnSoundImport = document.getElementById('scratchBtnSoundImport');
btnSoundImport.addEventListener('click', function () { soundFileInput.click(); });
scratchBtnSoundImport.addEventListener('click', function () { soundFileInput.click(); });
renderSoundUI();

// 声音导入：mp3 / wav / ogg 等音频 → importSoundFile；音乐编辑器 JSON 工程 → importSongFile（自动转码 WAV）
const btnMusicEditor = document.getElementById('btnMusicEditor');
const scratchBtnMusicEditor = document.getElementById('scratchBtnMusicEditor');
if (soundFileInput) soundFileInput.addEventListener('change', function () {
  const f = soundFileInput.files && soundFileInput.files[0];
  if (f) {
    if (/\.json$/i.test(f.name) || f.type === 'application/json' || f.type === 'text/json') importSongFile(f);
    else importSoundFile(f);
  }
  soundFileInput.value = '';
});
// 音乐编辑器快捷按钮：新标签页打开（相对路径：无限像素画布上一级目录的 音乐编辑器/）
function openMusicEditor() { window.open('../音乐编辑器/音乐编辑器.html', '_blank'); }
if (btnMusicEditor) btnMusicEditor.addEventListener('click', openMusicEditor);
if (scratchBtnMusicEditor) scratchBtnMusicEditor.addEventListener('click', openMusicEditor);

// 全屏模式
els.scratchSearch.addEventListener('input', function () { fillScratchPalette(); });
els.scratchSearch.addEventListener('keydown', function (e) { if (e.key === 'Escape') { this.value = ''; fillScratchPalette(); } });
els.btnScratchMax.addEventListener('click', openScratchMode);
els.btnScratchBack.addEventListener('click', closeScratchMode);
els.btnScratchRun.addEventListener('click', function () {
  state.nodesRunning = !state.nodesRunning;
  if (!state.nodesRunning) stopAllSounds(); // 停止全部运行时同时停止所有声音
  updateRunButton();
  requestRender();
});
els.stageGrid.addEventListener('input', function () {
  els.stageGridVal.textContent = els.stageGrid.value;
});
// 舞台右键：阻止浏览器默认菜单（另存为/查看图像等）
els.stageCanvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
els.stageBox.addEventListener('contextmenu', function (e) { e.preventDefault(); });
// 舞台滚轮：直接调整网格大小（预览倍率）
els.stageBox.addEventListener('wheel', function (e) {
  if (!scratchModeOn) return;
  e.preventDefault();
  const g = Math.min(400, Math.max(25, (+els.stageGrid.value || 100) + (e.deltaY < 0 ? 10 : -10)));
  els.stageGrid.value = g;
  els.stageGridVal.textContent = g;
}, { passive: false });
// 舞台交互：左键/中键拖动实例（点中实例则移动它）；空白处拖动 = 平移视图（网格放大查看）；双击重置视图
let dragStageInst = null; // { inst, dx, dy }
function stageScreenToWorld(cx, cy) {
  // cx/cy 为相对 stageCanvas 左上角的 CSS 像素
  const grid = Math.max(5, +els.stageGrid.value || 100) / 100;
  const s = (stageView.baseS || 1) * grid; // CSS px / 格
  return { x: (stageView.ox || 0) + cx / s, y: (stageView.oy || 0) + cy / s };
}
els.stageBox.addEventListener('pointerdown', function (e) {
  if (!scratchModeOn) return;
  const rect = els.stageCanvas.getBoundingClientRect();
  const w = stageScreenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  let best = null, bestD = 1e9;
  for (const inst of state.instances) {
    const dx = inst.x - w.x, dy = inst.y - w.y, dd = dx * dx + dy * dy;
    if (dd < bestD) { bestD = dd; best = inst; }
  }
  if (e.button !== 1 && best && bestD < 24) { // 点中实例（左键）拖动移动实例；中键始终平移视图
    dragStageInst = { inst: best, dx: best.x - w.x, dy: best.y - w.y, moved: false, rect: rect };
  } else {
    // 空白处平移视图：记录起点世界坐标与每格像素比
    const grid = Math.max(5, +els.stageGrid.value || 100) / 100;
    stagePan = { x: e.clientX, y: e.clientY, ox: stageView.ox || 0, oy: stageView.oy || 0, s: (stageView.baseS || 1) * grid };
  }
});
els.stageBox.addEventListener('dblclick', function () {
  stageView = { ox: 0, oy: 0 };
});
// 舞台拖动实例：pointermove 更新实例位置
(function () {
  const pm = document.addEventListener('pointermove', function (e) {
    if (!dragStageInst) return;
    const rect = dragStageInst.rect || els.stageCanvas.getBoundingClientRect();
    const w = stageScreenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    dragStageInst.inst.x = Math.round(w.x + dragStageInst.dx);
    dragStageInst.inst.y = Math.round(w.y + dragStageInst.dy);
    dragStageInst.moved = true;
    requestRender();
  });
  document.addEventListener('pointerup', function () { dragStageInst = null; });
})();
// 舞台右栏分界拖拽：鼠标按住右侧栏左边缘可调整舞台大小
let rightResize = null;
// 分界拖拽把手（右栏左缘竖条，避免被画布遮挡）：按住拖动调整舞台大小
const stageDivider = document.getElementById('stageDivider');
(stageDivider || els.scratchRight).addEventListener('pointerdown', function (e) {
  if (scratchModeOn) {
    const r = els.scratchRight.getBoundingClientRect();
    rightResize = { x: e.clientX, w: r.width };
    e.preventDefault();
  }
});
document.addEventListener('pointermove', function (e) {
  if (!rightResize) return;
  const w = Math.max(180, Math.min(720, rightResize.w - (e.clientX - rightResize.x)));
  els.scratchRight.style.flexBasis = w + 'px';
  applyStageSize(Math.round(Math.max(120, Math.min(w - 20, cssH() * 0.6))));
});
document.addEventListener('pointerup', function () { rightResize = null; });
// 舞台浮动窗口：可拖出、可拖动位置、可调整大小
const btnStageFloat = document.getElementById('btnStageFloat');
const btnStageFloatBack = document.getElementById('btnStageFloatBack');
let winDrag = null, winResize = null;
if (btnStageFloat) btnStageFloat.addEventListener('click', function () {
  stageFloating = !stageFloating;
  if (stageFloating) {
    document.getElementById('stageFloatWin').style.display = 'block';
    document.getElementById('stageFloatWin').style.width = '440px';
    document.getElementById('stageFloatWin').style.height = '520px';
    document.getElementById('stageFloatWin').style.left = Math.max(10, window.innerWidth - 460) + 'px';
    document.getElementById('stageFloatWin').style.top = '60px';
    document.getElementById('stageFloatBody').appendChild(els.stageBox);
  } else {
    document.getElementById('stageFloatWin').style.display = 'none';
    els.scratchRight.insertBefore(els.stageBox, els.stageCtrl);
  }
  resizeStage();
});
if (btnStageFloatBack) btnStageFloatBack.addEventListener('click', function () {
  stageFloating = false;
  document.getElementById('stageFloatWin').style.display = 'none';
  els.scratchRight.insertBefore(els.stageBox, els.stageCtrl);
  resizeStage();
});
const stageFloatBar = document.getElementById('stageFloatBar');
if (stageFloatBar) stageFloatBar.addEventListener('pointerdown', function (e) {
  winDrag = { x: e.clientX, y: e.clientY, l: document.getElementById('stageFloatWin').offsetLeft, t: document.getElementById('stageFloatWin').offsetTop, win: document.getElementById('stageFloatWin') };
  e.preventDefault();
});
// ---------- 小节点编辑器浮动窗口 ----------
let nodeFloating = false;
const nodeFloatWin = document.getElementById('nodeFloatWin');
const btnNodeFloat = document.getElementById('btnNodeFloat');
const btnNodeFloatBack = document.getElementById('btnNodeFloatBack');
const nodeFloatBody = document.getElementById('nodeFloatBody');
const nodeFloatBar = document.getElementById('nodeFloatBar');
const nodeFloatResize = document.getElementById('nodeFloatResize');
if (btnNodeFloat) btnNodeFloat.addEventListener('click', function () {
  nodeFloating = true;
  nodeFloatWin.style.display = 'block';
  nodeFloatWin.style.width = Math.max(560, els.nodePanel.offsetWidth || 720) + 'px';
  nodeFloatWin.style.height = Math.max(480, els.nodePanel.offsetHeight || 620) + 'px';
  nodeFloatWin.style.left = Math.max(8, window.innerWidth - nodeFloatWin.offsetWidth - 16) + 'px';
  nodeFloatWin.style.top = '60px';
  nodeFloatBody.appendChild(document.getElementById('nodeBody'));
  els.nodePanel.style.display = 'none';
  window.__nodeEditorOpen = true;
  renderNodeGraph();
  requestAnimationFrame(function () { renderNodeGraph(); });
});
if (btnNodeFloatBack) btnNodeFloatBack.addEventListener('click', function () {
  nodeFloating = false;
  nodeFloatWin.style.display = 'none';
  els.nodePanel.appendChild(document.getElementById('nodeBody'));
  els.nodePanel.style.display = '';
  if (els.nodePanel.classList.contains('open')) window.__nodeEditorOpen = true;
  else window.__nodeEditorOpen = false;
  renderNodeGraph();
});
if (nodeFloatBar) nodeFloatBar.addEventListener('pointerdown', function (e) {
  winDrag = { x: e.clientX, y: e.clientY, l: nodeFloatWin.offsetLeft, t: nodeFloatWin.offsetTop, win: nodeFloatWin };
  e.preventDefault();
});
if (nodeFloatResize) nodeFloatResize.addEventListener('pointerdown', function (e) {
  winResize = { x: e.clientX, y: e.clientY, w: nodeFloatWin.offsetWidth, h: nodeFloatWin.offsetHeight, win: nodeFloatWin };
  e.preventDefault();
});
const stageFloatResize = document.getElementById('stageFloatResize');
if (stageFloatResize) stageFloatResize.addEventListener('pointerdown', function (e) {
  winResize = { x: e.clientX, y: e.clientY, w: document.getElementById('stageFloatWin').offsetWidth, h: document.getElementById('stageFloatWin').offsetHeight, win: document.getElementById('stageFloatWin') };
  e.preventDefault();
});
document.addEventListener('pointermove', function (e) {
  if (winDrag && winDrag.win) {
    winDrag.win.style.left = (winDrag.l + e.clientX - winDrag.x) + 'px';
    winDrag.win.style.top = (winDrag.t + e.clientY - winDrag.y) + 'px';
  }
  if (winResize && winResize.win) {
    const w = Math.max(240, winResize.w + e.clientX - winResize.x);
    const h = Math.max(280, winResize.h + e.clientY - winResize.y);
    winResize.win.style.width = w + 'px';
    winResize.win.style.height = h + 'px';
    if (winResize.win.id === 'stageFloatWin') resizeStage();
  }
});
document.addEventListener('pointerup', function () { winDrag = null; winResize = null; });
// 重置视图：视图回中铺满舞台 + 对象实例归位画布中心
const btnStageReset = document.getElementById('btnStageReset');
if (btnStageReset) btnStageReset.addEventListener('click', function () {
  fitStageView(); // 视图：内容自适应铺满舞台（等比、格子正方、居中）
  const b = computeContentBounds();
  const cx = b ? Math.round((b.x0 + b.x1) / 2) : 100;
  const cy = b ? Math.round((b.y0 + b.y1) / 2) : 100;
  for (const inst of state.instances) { inst.x = cx; inst.y = cy; } // 对象归位内容中心
  requestRender();
  if (typeof updateInstInfo === 'function') updateInstInfo();
});
els.stageBox.addEventListener('dblclick', function () {
  stageView = { ox: 0, oy: 0 };
});
els.scratchObjSel.addEventListener('change', function () {
  const i = +els.scratchObjSel.value;
  if (i >= 0 && i < state.objects.length) selectObject(i);
});
els.scratchBtnInst.addEventListener('click', function () {
  const i = +els.scratchObjSel.value;
  if (i >= 0 && i < state.objects.length) instantiateObject(i);
});
els.scratchBtnDelObj.addEventListener('click', function () {
  const i = +els.scratchObjSel.value;
  if (i >= 0 && i < state.objects.length) deleteObject(i);
});
els.scratchBtnDelInst.addEventListener('click', function () {
  if (selInstId >= 0) deleteInstance(selInstId);
  else alert('请先选择要删除的实例（在画布点击或在实例列表中选中）。');
});
requestAnimationFrame(stageLoop);

// ---------- 自制节点 JS 在线编辑器 ----------
const nodeJsEl = function (id) { return document.getElementById(id); };
let editingPlugin = null; // 当前编辑器正在编辑的插件对象（插件库左键打开）
function openNodeJsEditor(code, title, opts) {
  editingPlugin = (opts && opts.plugin) || null;
  // 记录当前编辑的节点 id（供删除按钮使用）
  const m0 = code.match(/registerNodeType\(\s*['"]([^'"]+)['"]/);
  editingNodeId = m0 ? m0[1] : null;
  nodeJsEl('nodeJsDelete').style.display = editingPlugin ? 'none' : '';
  renderNodeJsEditor(code);
  nodeJsEl('nodeJsTitle').textContent = title || '编辑自制节点';
  nodeJsEl('nodeJsErr').textContent = '';
  nodeJsEl('nodeJsModal').classList.add('open');
  nodeJsEl('nodeJsEdit').focus();
}
let editingNodeId = null;
// ---------- JS 语法高亮（VSCode 风格配色） ----------
function escHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function hlJS(code) {
  let h = escHtml(code);
  // 单次正则一次成型：注释/字符串/关键字/数字按当前位置互斥匹配，立即包裹成 span，
  // 不会出现「先替换生成 span、后续正则又匹配 span 属性」的二次嵌套（修复 class=class= 与 === 被吞）
  h = h.replace(
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|'[^'\\\n]*(?:\\.[^'\\\n]*)*'|"[^"\\\n]*(?:\\.[^"\\\n]*)*"|`[^`\\]*(?:\\.[^`\\]*)*`|\b(?:function|return|const|let|var|if|else|for|while|new|typeof|instanceof|true|false|null|undefined|this|in|of|break|continue|switch|case|default|try|catch|throw|delete|void|class|extends|import|export|yield|async|await)\b|\b\d+\.?\d*\b)/g,
    function (m) {
      if (m.charAt(0) === '/' && (m.charAt(1) === '/' || m.charAt(1) === '*')) return '<span class="tok-cmt">' + m + '</span>';
      if (m.charAt(0) === '\'' || m.charAt(0) === '"' || m.charAt(0) === '`') return '<span class="tok-str">' + m + '</span>';
      if (/^\d/.test(m)) return '<span class="tok-num">' + m + '</span>';
      return '<span class="tok-kw">' + m + '</span>';
    }
  );
  return h;
}
// 渲染高亮内容到单层可编辑区（换行用 <br>，与 getEditText 互逆）
function renderNodeJsEditor(text) {
  const el = nodeJsEl('nodeJsEdit');
  // 输入先清洗（防二次高亮：若传入的是渲染后的 HTML 文本则还原为纯代码）
  const t = sanitizeCodeText(text == null ? '' : text);
  el.innerHTML = t ? hlJS(t).replace(/\n/g, '<br>') : '';
}
// 从可编辑区提取纯文本（<br>/<div> 边界还原为换行）
function getEditText() {
  const el = nodeJsEl('nodeJsEdit');
  const out = [];
  (function walk(n) {
    if (n.nodeType === 3) out.push(n.textContent);
    else if (n.nodeName === 'BR') out.push('\n');
    else if (n.nodeName === 'DIV' || n.nodeName === 'P') { for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]); out.push('\n'); }
    else { for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]); }
  })(el);
  // 清洗可能混入的 HTML 残骸后返回纯代码；contenteditable 会把空格存成 \u00A0，还原为普通空格
  return sanitizeCodeText(out.join('')).replace(/\u00A0/g, ' ').replace(/\n+$/, '');
}
// 渲染前清洗：把可能混入的 HTML 残骸（如误粘贴的高亮 span、转义实体）还原为纯文本，
// 保证 hlJS 永远只处理纯文本代码
function sanitizeCodeText(t) {
  let s = String(t == null ? '' : t);
  // 还原被转义的实体
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  // 剥离完整 span 标签
  s = s.replace(/<span[^>]*>/g, '').replace(/<\/span>/g, '');
  // 剥离「渲染后 HTML 的可见残片」（用户从聊天/网页复制的污染文本常见形态）：
  //   class=class="tok-str">"tok-cmt">…  /  class="tok-cmt">…  /  "tok-cmt">…
  s = s.replace(/class=class="tok-(?:str|cmt|kw|num)"\s*>\s*"tok-(?:str|cmt|kw|num)">/g, '');
  s = s.replace(/class="tok-(?:str|cmt|kw|num)">/g, '');
  s = s.replace(/"tok-(?:str|cmt|kw|num)">/g, '');
  s = s.replace(/<span/g, '');
  // 还原 <br> / <div> / <p> 边界为换行
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n').replace(/<[^>]+>/g, '');
  // 去掉行首行尾残留的空格与孤立空行（粘贴污染文本常带）
  return s;
}
// 输入时不重渲染（避免中文输入法被打断；选择/光标天然对齐，因为只有一层）
nodeJsEl('nodeJsEdit').addEventListener('blur', function () {
  renderNodeJsEditor(getEditText());
});
// 空格键：强制插入普通空格（contenteditable 直接输入会存成 \u00A0，保存时 JS 解析报错，打不出"真正的空格"）
nodeJsEl('nodeJsEdit').addEventListener('keydown', function (e) {
  if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    document.execCommand('insertText', false, ' ');
  }
});
// 粘贴强制为纯文本：禁止富文本 HTML 插入（防止高亮 span 污染代码、字符错乱）
nodeJsEl('nodeJsEdit').addEventListener('paste', function (e) {
  e.preventDefault();
  const txt = (e.clipboardData || window.clipboardData).getData('text/plain');
  const clean = sanitizeCodeText(txt);
  // 在光标处插入纯文本（保留原换行/缩进）
  document.execCommand('insertText', false, clean);
});
// ---------- 导入 / 导出 JS ----------
nodeJsEl('nodeJsImport').addEventListener('click', function () { nodeJsEl('nodeJsImportFile').click(); });
nodeJsEl('nodeJsImportFile').addEventListener('change', function () {
  const f = this.files && this.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = function () { renderNodeJsEditor(String(rd.result || '')); };
  rd.readAsText(f);
  this.value = '';
});
nodeJsEl('nodeJsExport').addEventListener('click', function () {
  const code = getEditText();
  const blob = new Blob([code], { type: 'text/javascript;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const m = code.match(/registerNodeType\(\s*['"]([^'"]+)['"]/);
  a.download = (m ? m[1] : 'custom-node') + '.js';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
});
function closeNodeJsEditor() {
  editingPlugin = null;
  nodeJsEl('nodeJsModal').classList.remove('open');
}
// 删除当前编辑的节点
function deleteNodeJs() {
  if (!editingNodeId) { nodeJsEl('nodeJsErr').textContent = '当前内容未包含可删除的节点（缺少 registerNodeType("id", …)）。'; return; }
  if (!confirm('确定删除节点「' + editingNodeId + '」吗？（会同时清除本地保存，画布上已使用的该节点将失效）')) return;
  delete NODE_TYPES[editingNodeId];
  delete NODE_DEF_SRC[editingNodeId];
  deleteCustomNode(editingNodeId);
  refreshNodeLibrary();
  closeNodeJsEditor();
}
nodeJsEl('nodeJsDelete').addEventListener('click', deleteNodeJs);
function refreshNodeLibrary() {
  const keep = els.nodeCatSelect ? els.nodeCatSelect.value : '自制';
  fillNodeCatSelect();
  if (els.nodeCatSelect && keep && NODE_CATS[keep]) { els.nodeCatSelect.value = keep; fillNodeTypeSelect(); }
  if (typeof fillScratchCats === 'function') { fillScratchCats(); fillScratchPalette(); }
  renderNodeGraph();
}
function saveNodeJs() {
  const code = getEditText();
  // 插件编辑模式：更新插件源码并重新注册
  if (editingPlugin) {
    try { (0, eval)(code); }
    catch (e) { nodeJsEl('nodeJsErr').textContent = 'JS 错误：' + e.message; return; }
    const pname = editingPlugin.name || '';
    editingPlugin.code = code;
    if (editingPlugin.saved) {
      const arr = loadPlugins().map(function (x) {
        return (x.time === editingPlugin.time && x.name === editingPlugin.name) ? { name: x.name, code: code, time: x.time } : x;
      });
      savePlugins(arr);
    }
    renderPluginLib();
    closeNodeJsEditor();
    alert('插件「' + pname + '」已更新。');
    return;
  }
  const m = code.match(/registerNodeType\(\s*['"]([^'"]+)['"]/);
  let id = m ? m[1] : null;
  try {
    (0, eval)(code);
  } catch (e) {
    nodeJsEl('nodeJsErr').textContent = 'JS 错误：' + e.message;
    return;
  }
  if (id) {
    saveCustomNode(id, code);
    editingNodeId = id; // 保存后更新当前编辑的节点 id（删除按钮用）
    refreshNodeLibrary();
    closeNodeJsEditor();
  } else {
    nodeJsEl('nodeJsErr').textContent = '未找到 registerNodeType(' + "'id'" + ', { … }) 调用，无法确定节点 id。';
  }
}
nodeJsEl('nodeJsSave').addEventListener('click', saveNodeJs);
nodeJsEl('nodeJsClose').addEventListener('click', closeNodeJsEditor);
nodeJsEl('nodeJsCancel').addEventListener('click', closeNodeJsEditor);
// 新建自制节点：预填模板
const NODE_TEMPLATE = [
  '// 在下方编写你的自制节点（保存后立即生效并自动存入浏览器）',
  '// 示例：一个动作节点（每帧执行，把实例向下移动）',
  "registerNodeType('myMoveDown', {",
  "  name: '向下移动',",
  "  category: '自制',",
  "  desc: '自制节点示例：每帧向下移动一格',",
  "  flowIn: true, flowOut: true,",
  "  params: [{ key: 'speed', label: '速度', type: 'number', def: 1, min: 0, max: 10 }],",
  "  run: function (inputs, inst, p, st) {",
  "    inst.y += p.speed;",
  "    requestRender();",
  "  },",
  '});',
  '',
  '// 更多：端口 sockets、数据节点 value、下拉参数 options 等用法',
  '// 见 node-ther.js 顶部的 registerNodeType 参数说明',
].join('\n');
function openNewNodeEditor() {
  openNodeJsEditor(NODE_TEMPLATE, '新建自制节点（在文字框中编写 JS）');
}
nodeJsEl('btnNodeAddCustom').addEventListener('click', openNewNodeEditor);
nodeJsEl('scratchBtnAddCustom').addEventListener('click', openNewNodeEditor);
// 【保存】按钮：手动持久化新增/删除状态（重启后保留）
function doSaveCustom() {
  const msg = saveAllCustomNodes();
  flashNodeJs(msg);
}
function flashNodeJs(msg) {
  const d = document.createElement('div');
  d.textContent = '💾 ' + msg;
  d.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);background:#1e3a5f;border:1px solid #3b82f6;color:#dbe2ea;padding:8px 18px;border-radius:8px;z-index:200;font-size:13px';
  document.body.appendChild(d);
  setTimeout(function () { d.remove(); }, 2000);
}
nodeJsEl('btnSaveCustom').addEventListener('click', doSaveCustom);
nodeJsEl('scratchBtnSaveCustom').addEventListener('click', doSaveCustom);
// 加载已保存的自制节点与插件（浏览器本地持久化）
loadCustomNodes();
refreshNodeLibrary();
loadAllPlugins();
