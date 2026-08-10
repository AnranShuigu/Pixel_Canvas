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
function registerNodeType(type, def) { NODE_TYPES[type] = def; }
function defaultParams(def) {
  const p = {};
  if (def.params) for (const prm of def.params) p[prm.key] = prm.def;
  return p;
}
function hasOutput(def) { return def.sockets && def.sockets.some(function (s) { return s.dir === 'out'; }); }
// 分类顺序：事件/运动/控制/侦测/运算/变量/自制（Scratch 式）→ 常量/输入/动作（Blender 基础）
const NODE_CATS = {
  '事件': '#ffd500', '运动': '#4c97ff', '控制': '#ffab19', '侦测': '#0fbd8c',
  '运算': '#59c059', '变量': '#ff8c1a', '自制': '#ff6680',
  '常量': '#9aa0ab', '输入': '#7aa2ff', '动作': '#ff8c6b',
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
  name: '移动', category: '动作', flowIn: true, flowOut: true,
  desc: '每帧把位移向量加到实例位置上',
  sockets: [{ key: 'vec', dir: 'in', type: 'vec', label: '位移' }],
  run: function (inputs, inst) {
    if (!inputs.vec) return;
    inst.x += inputs.vec.x;
    inst.y += inputs.vec.y;
  },
});
registerNodeType('setPos', {
  name: '设置位置', category: '动作', flowIn: true, flowOut: true,
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

// ---- 变量（橙红）：变量本身是「数字」，通过节点读写，每个实例的值独立 ----
function varOptions() {
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  const opts = [{ v: '', label: '（选择变量）' }];
  if (obj && obj.vars) for (const name of obj.vars) opts.push({ v: name, label: name });
  return opts;
}
registerNodeType('varGet', {
  name: '变量值', category: '变量',
  desc: '输出指定变量的当前值（数字）',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '值' }],
  params: [{ key: 'var', label: '变量', type: 'select', def: '', options: varOptions }],
  value: function (inputs, inst, p) {
    if (!p.var || !inst.st.vars) return 0;
    const v = inst.st.vars[p.var];
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
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
      if (src) inputs[sock.key] = groupNodeValue(grp, src.from, inst, ext, cache, visiting);
      else if (ext && ext[nodeId + '::' + sock.key] !== undefined) inputs[sock.key] = ext[nodeId + '::' + sock.key];
      else inputs[sock.key] = null;
    }
  }
  if (node.type === 'ifCond' && node.p && node.p.conds) {
    for (const ck of node.p.conds) {
      const src = findConn(g, nodeId, ck);
      if (src) inputs[ck] = groupNodeValue(grp, src.from, inst, ext, cache, visiting);
      else if (ext && ext[nodeId + '::' + ck] !== undefined) inputs[ck] = ext[nodeId + '::' + ck];
      else inputs[ck] = null;
    }
  }
  return inputs;
}
function groupNodeValue(grp, nodeId, inst, ext, cache, visiting) {
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
  try { val = def.value(inputs, inst, node.p || {}, inst.st); } catch (e) { val = null; }
  visiting.delete(nodeId);
  cache.set(nodeId, val);
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
    ext[pin.nodeId + '::' + pin.sockKey] = src ? nodeValue(g, src.from, inst, new Map(), new Set()) : null;
  }
  return ext;
}
// 求组节点的某个输出端口值（外部连线消费组输出时调用）
function groupOutValue(grp, extKey, groupNode, inst, g) {
  const out = grp.outputs.find(function (o) { return o.extKey === extKey; });
  if (!out) return null;
  const ext = groupExtInputs(grp, groupNode, inst, g);
  return groupNodeValue(grp, out.nodeId, inst, ext, new Map(), new Set());
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
  obj.graph = { nodes: [], conns: [] };
  obj.vars = []; // 对象级变量列表（每个实例有独立的值）
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
  els.nodePanel.classList.add('open');
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
    els.nodePanel.classList.add('open');
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
  els.nodePanel.classList.add('open');
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
  state.instances.push({
    id: nextInstId++, objectIdx: objIdx,
    x: obj.srcX, y: obj.srcY, st: {}, layerIdx: li,
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
  if (i >= 0) state.instances.splice(i, 1);
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
        inputs[pin.extKey] = src ? nodeValue(g, src.from, inst, cache, visiting) : null;
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
          inputs[sock.key] = nodeValue(g, src.from, inst, cache, visiting);
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
          inputs[ck] = nodeValue(g, src.from, inst, cache, visiting);
        }
      } else {
        inputs[ck] = null;
      }
    }
  }
  return inputs;
}
// 数据节点求值（缓存 + 环保护），数据链路与执行链共用
function nodeValue(g, nodeId, inst, cache, visiting) {
  if (cache.has(nodeId)) return cache.get(nodeId);
  if (visiting.has(nodeId)) return null; // 环路保护
  const node = g.nodes.find(function (n) { return n.id === nodeId; });
  if (!node) { cache.set(nodeId, null); return null; }
  const def = NODE_TYPES[node.type];
  if (!def || !def.value) { cache.set(nodeId, null); return null; }
  visiting.add(nodeId);
  const inputs = evalInputs(g, nodeId, inst, cache, visiting);
  let val = null;
  try { val = def.value(inputs, inst, node.p || {}, inst.st); } catch (e) { val = null; }
  visiting.delete(nodeId);
  cache.set(nodeId, val);
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
  frameCount++;
  for (const inst of state.instances) {
    const li = inst.layerIdx === undefined ? 0 : inst.layerIdx;
    if (!state.layers[li] || !state.layers[li].visible) continue; // 隐藏图层：实例停止
    const obj = state.objects[inst.objectIdx];
    if (!obj) continue;
    try { evalGraph(obj, inst); } catch (e) { /* 节点执行出错跳过本帧 */ }
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

function renderNodeGraph() {
  const target = graphTarget();
  target.innerHTML = '';
  connSvg = null;
  // 注意：不在这里清空 connStart/tempEnd——socket 按下起点后调用本函数重建 DOM 时，
  // 需要保留连线起点状态，最后由 drawTempConn() 基于 connStart 重画临时线。
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (!obj) {
    target.innerHTML = '<div class="n-note" style="padding:10px">先在左侧选择一个对象，再用下方按钮添加节点</div>';
    return;
  }
  const g = currentGraph();
  if (!g) {
    target.innerHTML = '<div class="n-note" style="padding:10px">先在左侧选择一个对象，或用「节点组」分类展开组</div>';
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
    el.className = 'node-gnode' + (node.id === selNodeIdx || selNodeSet.has(node.id) ? ' sel' : '') + (node.type === 'groupRef' ? ' group' : '');
    el.style.left = (node.x || 20) + 'px';
    el.style.top = (node.y || 20) + 'px';
    const head = document.createElement('div');
    head.className = 'ng-head';
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
        }
        el.appendChild(row);
      }
    }
    for (const sock of (def.sockets || [])) {
      if (sock.dir !== 'out') continue;
      el.appendChild(socketEl(node.id, sock, 'out'));
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
      connStart = { nodeId: nodeId, sock: '__flow__', type: 'flow' };
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
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (!obj || !obj.graph || !connSvg) return;
  const ports = collectPorts();
  obj.graph.conns.forEach(function (c) {
    const a = ports[c.from + ':' + c.fromSock];
    const b = ports[c.to + ':' + c.toSock];
    if (!a || !b) return;
    const path = document.createElementNS(svgNS, 'path');
    const mx = (a.x + b.x) / 2;
    path.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' C ' + mx + ' ' + a.y + ', ' + mx + ' ' + b.y + ', ' + b.x + ' ' + b.y);
    path.setAttribute('class', 'conn');
    path.addEventListener('click', function (e) {
      e.stopPropagation();
      const o2 = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
      if (o2 && o2.graph) {
        o2.graph.conns = o2.graph.conns.filter(function (cc) { return cc !== c; });
        renderNodeGraph();
      }
    });
    connSvg.appendChild(path);
  });
}
// 执行流连线（绿色粗线 + 方向箭头）
function drawFlowConns() {
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (!obj || !obj.graph || !connSvg) return;
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
  (obj.graph.flows || []).forEach(function (c) {
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
      const o2 = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
      if (o2 && o2.graph) {
        o2.graph.flows = (o2.graph.flows || []).filter(function (cc) { return cc !== c; });
        renderNodeGraph();
      }
    });
    connSvg.appendChild(path);
  });
}
function drawTempConn() {
  if (!connStart || !tempEnd || !connSvg) return;
  const ports = collectPorts();
  const a = ports[connStart.nodeId + ':' + connStart.sock];
  if (!a) return;
  const path = document.createElementNS(svgNS, 'path');
  const mx = (a.x + tempEnd.x) / 2;
  path.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' C ' + mx + ' ' + a.y + ', ' + mx + ' ' + tempEnd.y + ', ' + tempEnd.x + ' ' + tempEnd.y);
  path.setAttribute('class', 'temp');
  connSvg.appendChild(path);
}
// 连线 / 节点增删
function addConn(fromNode, fromSock, toNode, toSock) {
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (!obj) return;
  const g = ensureGraph(obj);
  g.conns = g.conns.filter(function (c) { return !(c.to === toNode && c.toSock === toSock); }); // 同输入端口只留一条
  g.conns.push({ from: fromNode, fromSock: fromSock, to: toNode, toSock: toSock });
  renderNodeGraph();
}
// 执行流连线：from（出口）→ to（入口）；每个节点出口只连一条（重复连线替换）
function addFlowConn(fromNode, toNode) {
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (!obj) return;
  const g = ensureGraph(obj);
  if (!g.flows) g.flows = [];
  g.flows = g.flows.filter(function (c) { return c.from !== fromNode; });
  g.flows.push({ from: fromNode, to: toNode });
  renderNodeGraph();
}
function removeFlowConn(toNode) {
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (!obj || !obj.graph) return;
  obj.graph.flows = (obj.graph.flows || []).filter(function (c) { return c.to !== toNode; });
}
function removeConnTo(toNode, toSock) {
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (!obj || !obj.graph) return;
  obj.graph.conns = obj.graph.conns.filter(function (c) { return !(c.to === toNode && c.toSock === toSock); });
}
function deleteGraphNode(id) {
  const g = currentGraph();
  if (!g) return;
  g.nodes = g.nodes.filter(function (n) { return n.id !== id; });
  g.conns = g.conns.filter(function (c) { return c.from !== id && c.to !== id; });
  g.flows = (g.flows || []).filter(function (c) { return c.from !== id && c.to !== id; });
  renderNodeGraph();
}
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
    stageView.ox = e.clientX - stagePan.x;
    stageView.oy = e.clientY - stagePan.y;
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
      if (hit) addConn(connStart.nodeId, connStart.sock, +hit.dataset.nodeId, hit.dataset.sock);
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
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'node-groups.json');
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

// ---------- 全屏模式（放大：节点库 + 大节点画布 + 舞台 + 实例信息） ----------
let scratchModeOn = false;
let scratchCat = '输入'; // 节点库当前分类
let stageView = { ox: 0, oy: 0 }; // 舞台预览偏移（放大超出舞台时可拖动查看）
let stagePan = null;

function openScratchMode() {
  scratchModeOn = true;
  curGraphArea = els.scratchCanvas; // 节点画布切换到全屏
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
  scratchModeOn = false;
  curGraphArea = null;
  els.scratchOverlay.classList.remove('open');
  els.nodePanel.classList.add('open');
  renderNodeGraph();
  updateRunButton();
}
function fillScratchCats() {
  els.scratchCats.innerHTML = '';
  for (const cat of Object.keys(NODE_CATS)) {
    const has = Object.keys(NODE_TYPES).some(function (t) { return NODE_TYPES[t].category === cat; });
    if (!has) continue;
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
}
function fillScratchPalette() {
  els.scratchPalette.innerHTML = '';
  // 变量区只在选中「变量」分类时展开显示（新建变量属于变量类型节点库）
  if (els.scratchVarRow) els.scratchVarRow.style.display = (scratchCat === '变量') ? 'flex' : 'none';
  if (scratchCat === '节点组') { // 列出所有节点组，点击添加为单个组节点
    if (!Object.keys(GROUPS).length) {
      const note = document.createElement('span');
      note.className = 'n-note';
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
    btn.addEventListener('click', function () { addNodeToObject(t); });
    els.scratchPalette.appendChild(btn);
  }
}
// 舞台：正方形，实时预览主画布（右上角）；舞台大小与网格大小分别可调。
// 舞台变大时右侧栏跟随变宽（压缩左侧节点画布），且永不超过屏幕，避免溢出到屏幕外。
function resizeStage() {
  const size = Math.max(120, +els.stageSize.value || 320);
  els.stageSizeVal.textContent = size;
  // 舞台最大边长：不超过右侧栏可用宽度与屏幕高度的 55%（保证不溢出）
  const maxSize = Math.max(160, Math.min(window.innerWidth * 0.46 - 20, cssH() * 0.55));
  const s = Math.round(Math.min(size, maxSize));
  els.stageSize.max = Math.round(maxSize); // 滑块上限 = 屏幕允许的最大边长（所见即所得）
  const sc = els.stageCanvas;
  const d = dpr();
  sc.style.width = s + 'px';
  sc.style.height = s + 'px';
  sc.width = Math.round(s * d);
  sc.height = Math.round(s * d);
  els.stageBox.style.width = s + 'px';
  els.stageBox.style.height = s + 'px';
  // 右栏宽度跟随舞台（+留白），flex 布局自动压缩左侧节点画布
  els.scratchRight.style.flexBasis = Math.max(240, s + 40) + 'px';
}
function stageLoop() {
  requestAnimationFrame(stageLoop);
  if (!scratchModeOn) return;
  const sc = els.stageCanvas;
  if (sc.width === 0 || !canvas || canvas.width === 0) return;
  const cc = sc.getContext('2d');
  cc.imageSmoothingEnabled = true;
  cc.clearRect(0, 0, sc.width, sc.height);
  // 背景浅色网格：无论预览缩小到多小，舞台四周始终有网格线
  const d = dpr();
  cc.strokeStyle = 'rgba(0,0,0,.12)';
  cc.lineWidth = 1;
  const step = 16 * d;
  for (let gx = step; gx < sc.width; gx += step) {
    cc.beginPath(); cc.moveTo(gx, 0); cc.lineTo(gx, sc.height); cc.stroke();
  }
  for (let gy = step; gy < sc.height; gy += step) {
    cc.beginPath(); cc.moveTo(0, gy); cc.lineTo(sc.width, gy); cc.stroke();
  }
  // 网格大小 = 预览倍率（100% 时主画布较大边正好铺满正方形舞台，保持宽高比、格子为正方形；
  // 调大放大细节（超出部分可拖动平移查看），调小露出背景网格）
  const cw = canvas.width / d, ch = canvas.height / d;
  const grid = Math.max(5, +els.stageGrid.value || 100) / 100;
  const fit = sc.width / Math.max(cw, ch, 1); // 等比缩放：像素格保持正方形，不拉伸变形
  const tw = Math.max(1, cw * fit * grid);
  const th = Math.max(1, ch * fit * grid);
  // 叠加舞台平移偏移（放大后拖动查看超出部分）
  const ox = (sc.width - tw * d) / 2 + stageView.ox * d;
  const oy = (sc.height - th * d) / 2 + stageView.oy * d;
  cc.drawImage(canvas, 0, 0, canvas.width, canvas.height, ox, oy, tw * d, th * d);
  updateInstInfo();
}
// 节点库（左侧列）宽度拖拽调节：鼠标按住右边缘拖动
let libResize = null;
(function () {
  if (!els.scratchLib) return;
  els.scratchLib.addEventListener('pointerdown', function (e) {
    const r = els.scratchLib.getBoundingClientRect();
    if (e.clientX > r.right - 10) { // 右边缘 10px 内为拖拽区
      libResize = { x: e.clientX, w: r.width };
      e.preventDefault();
    }
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
  els.nodePanel.classList.add('open');
  // 「框选添加对象」工具已合并到节点编辑器入口：打开时自动启用（框选像素 → 创建对象）
  setTool('nodeSelect');
  fillNodeCatSelect();
  renderNodePanel();
});
els.btnCloseNode.addEventListener('click', function () {
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
  const type = els.nodeTypeSelect.value;
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
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  if (!obj) { alert('请先在左侧选择一个对象。'); return; }
  const name = (inputEl.value || '').trim();
  if (!name) { alert('请输入变量名。'); return; }
  if (obj.vars.indexOf(name) >= 0) { alert('变量已存在：' + name); return; }
  obj.vars.push(name);
  inputEl.value = '';
  renderVarUI();
  renderNodeGraph();
}
function renderVarUI() {
  const obj = selObjIdx >= 0 ? state.objects[selObjIdx] : null;
  const hint = obj
    ? ('变量：' + (obj.vars && obj.vars.length ? obj.vars.length + ' 个' : '（无）'))
    : '选中对象后创建变量';
  els.varHint.textContent = hint;
  // 全屏节点库：已添加的变量名称列表（显示在「添加新变量」按钮下方）
  if (els.scratchVarList) {
    els.scratchVarList.innerHTML = '';
    if (obj && obj.vars && obj.vars.length) {
      for (const name of obj.vars) {
        const item = document.createElement('div');
        item.className = 'scratch-var-item';
        item.textContent = name;
        els.scratchVarList.appendChild(item);
      }
    } else {
      const note = document.createElement('span');
      note.className = 'n-note';
      note.textContent = '（暂无变量，输入名称点「添加新变量」）';
      els.scratchVarList.appendChild(note);
    }
  }
}
els.btnVarAdd.addEventListener('click', function () { addVariable(els.varNameInput); });
els.scratchVarBtn.addEventListener('click', function () { addVariable(els.scratchVarNameInput); });

// 全屏模式
els.btnScratchMax.addEventListener('click', openScratchMode);
els.btnScratchBack.addEventListener('click', closeScratchMode);
els.btnScratchRun.addEventListener('click', function () {
  state.nodesRunning = !state.nodesRunning;
  updateRunButton();
  requestRender();
});
els.stageSize.addEventListener('input', resizeStage);
els.stageGrid.addEventListener('input', function () {
  els.stageGridVal.textContent = els.stageGrid.value;
});
// 舞台滚轮：直接调整网格大小（预览倍率）
els.stageBox.addEventListener('wheel', function (e) {
  if (!scratchModeOn) return;
  e.preventDefault();
  const g = Math.min(400, Math.max(25, (+els.stageGrid.value || 100) + (e.deltaY < 0 ? 10 : -10)));
  els.stageGrid.value = g;
  els.stageGridVal.textContent = g;
}, { passive: false });
// 舞台拖动平移（网格放大后预览超出舞台，拖动查看）；双击重置
els.stageBox.addEventListener('pointerdown', function (e) {
  if (!scratchModeOn) return;
  stagePan = { x: e.clientX - stageView.ox, y: e.clientY - stageView.oy };
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
