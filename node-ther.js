// ===================================================================
// node-ther.js —— 全部自制节点（唯一引用文件）
// -------------------------------------------------------------------
// 【怎么用】
// 1. index.html 只需引用本文件一次（node-system.js 之后、vector-canvas.js 之前）：
//      <script src="node-ther.js"></script>
// 2. 以后要加新节点：直接在这个文件末尾调用 registerNodeType(...) 写一个新节点，
//    不需要再改 index.html、不需要新建文件；
// 3. 刷新页面后，节点编辑器 / 全屏编辑器的「自制」分类中自动出现所有节点。
//
// 【registerNodeType 参数说明】
//   name     节点显示名称
//   category 分类：'事件' | '运动' | '控制' | '侦测' | '运算' | '变量' | '自制'（自制节点放这里）| '常量' | '输入' | '动作'
//   desc     说明文字（全屏编辑器鼠标悬停显示）
//   sockets  端口：[{ key, dir:'in'|'out', type:'vec'|'num', label }]
//            · dir='out' 输出端口（数据源），dir='in' 输入端口（数据汇）
//            · type='vec' 传 {x,y} 向量，type='num' 传数字；连线两端类型必须一致
//   flowIn / flowOut  执行流连接点（绿色）：flowIn 左侧入口，flowOut 右侧出口；
//            · 帽子节点（当开始运行/当按下键/当对象被点击）只有 flowOut
//            · 动作/控制节点两侧都有，可接入执行链
//   params   参数（节点上显示编辑控件）：
//            [{ key, label, type:'number', min, max, step, def }]        数字输入
//            [{ key, label, type:'select', def, options:()=>[{v,label}] }] 下拉选择
//            [{ key, label, type:'key', def }]                             按键下拉
//   value(inputs, inst, p, st) 数据节点（有输出端口）：返回 {x,y}（vec）或数字（num）
//   run(inputs, inst, p, st)   动作节点（无输出端口）：每帧执行，可改 inst.x / inst.y
//     · inputs = { 端口key: 值 }，未连线为 null
//     · inst   = { id, objectIdx, x, y, layerIdx, st }（x/y 是对象左上角格子坐标）
//     · p      = 该节点的参数对象（params 里的当前值）
//     · st     = 该实例的持久状态（跨帧数据存这里，每个实例独立）
//     · 可访问全局：state / keys / nextInstId / state.layers / state.instances / state.objects / requestRender()
// ===================================================================

// ===================================================================
// 一、WASD 移动（键盘控制实例移动，自带键盘检测，无需连线）
// ===================================================================
registerNodeType('wasdMove', {
  name: 'WASD 移动',
  category: '自制',
  flowIn: true, flowOut: true,
  desc: '方向键 / WASD 控制实例移动（速度可调，自带键盘检测，无需连线）',
  params: [
    { key: 'speed', label: '速度(格/帧)', type: 'number', min: 0.1, max: 10, step: 0.1, def: 1.5 },
  ],
  run: function (inputs, inst, p) {
    var dx = 0, dy = 0;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
    if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1;
    if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1;
    if (dx === 0 && dy === 0) return;
    var d = Math.hypot(dx, dy);
    inst.x += dx / d * p.speed;
    inst.y += dy / d * p.speed;
  },
});

// ===================================================================
// 二、网格基础能力节点（通用）
// 说明：读写画布格子、统计邻域、运行中创建/删除实例、逻辑非/取模等运算，
//   ① 读写画布格子（像素）  ② 统计邻域格子  ③ 运行中创建/删除实例  ④ 逻辑非/取模等运算
// 网格类玩法（元胞自动机、五子棋落子等）与通用逻辑都能用这些基础节点拼出来。
// ===================================================================

// ---- 格子读取（数据）：当前实例所在格子是否有像素（有=1 无=0） ----
registerNodeType('pixelAt', {
  name: '格子读取', category: '自制',
  desc: '读取当前实例所在格子：有像素输出 1，否则输出 0',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '有像素?' }],
  value: function (inputs, inst) {
    var li = inst.layerIdx === undefined ? 0 : inst.layerIdx;
    var L = state.layers[li];
    if (!L) return 0;
    return L.pixels.has(Math.round(inst.x) + ',' + Math.round(inst.y)) ? 1 : 0;
  },
});

// ---- 格子写入（动作）：在当前实例所在格子画像素（值=1）或擦除（值=0） ----
registerNodeType('pixelSet', {
  name: '格子写入', category: '自制', flowIn: true, flowOut: true,
  desc: '写像素：值输入 1=画上、0=擦除；位置未连线=当前实例所在格，连线=指定坐标；颜色：0黑 1白 2蓝(默认) 3红 4绿 5黄',
  sockets: [
    { key: 'v', dir: 'in', type: 'num', label: '值' },
    { key: 'pos', dir: 'in', type: 'vec', label: '位置' },
    { key: 'color', dir: 'in', type: 'num', label: '颜色' },
  ],
  run: function (inputs, inst) {
    var li = inst.layerIdx === undefined ? 0 : inst.layerIdx;
    var L = state.layers[li];
    if (!L) return;
    var v = inputs.v;
    var x, y;
    if (inputs.pos) { x = Math.round(inputs.pos.x); y = Math.round(inputs.pos.y); }
    else { x = Math.round(inst.x); y = Math.round(inst.y); }
    if (v === 0) L.pixels.delete(x + ',' + y);
    else if (v > 0) {
      var PAL = ['#111111', '#ffffff', '#3b82f6', '#ef4444', '#22c55e', '#eab308'];
      var ci = inputs.color === null || inputs.color === undefined ? 2 : Math.round(inputs.color);
      L.pixels.set(x + ',' + y, PAL[ci] || PAL[2]);
    }
    requestRender();
  },
});

// ---- 停止当前脚本 / 停止全部执行（动作）：中断执行链 ----
registerNodeType('stopSelf', {
  name: '停止当前脚本', category: '控制', flowIn: true, flowOut: true,
  desc: '停止当前实例的节点执行：立即中断本执行链，之后该实例不再执行任何节点（直到重新运行）',
  run: function (inputs, inst) { inst.st.stopSelf = true; },
});
registerNodeType('stopAll', {
  name: '停止全部执行', category: '控制', flowIn: true, flowOut: true,
  desc: '停止所有对象的节点执行（相当于关闭「运行」开关）',
  run: function () { state.nodesRunning = false; if (typeof updateRunButton === 'function') updateRunButton(); },
});

// ---- 鼠标的X坐标 / 鼠标的Y坐标（数据）：鼠标在像素画布上的世界格子坐标 ----
registerNodeType('mouseX', {
  name: '鼠标的X坐标', category: '侦测',
  desc: '返回鼠标在像素画布上的 X 格子坐标（移动鼠标实时更新）',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: 'X' }],
  value: function () { return state.mouseGridX || 0; },
});
registerNodeType('mouseY', {
  name: '鼠标的Y坐标', category: '侦测',
  desc: '返回鼠标在像素画布上的 Y 格子坐标（移动鼠标实时更新）',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: 'Y' }],
  value: function () { return state.mouseGridY || 0; },
});

// ---- 邻域格子数（数据）：当前实例 8 邻域中有像素的格子数量（通用） ----
registerNodeType('neighborCount', {
  name: '邻域格子数', category: '侦测',
  desc: '统计当前实例所在格子 8 邻域（上下左右+斜角）中有像素的格子数量（通用）',
  sockets: [{ key: 'out', dir: 'out', type: 'num', label: '邻居数' }],
  value: function (inputs, inst) {
    var li = inst.layerIdx === undefined ? 0 : inst.layerIdx;
    var L = state.layers[li];
    if (!L) return 0;
    var n = 0;
    var x = Math.round(inst.x), y = Math.round(inst.y);
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (L.pixels.has((x + dx) + ',' + (y + dy))) n++;
      }
    }
    return n;
  },
});

// ---- 删除自身（动作）：输入为 1 时把当前实例从画布移除（子弹消失等） ----
registerNodeType('deleteSelf', {
  name: '删除自身', category: '控制', flowIn: true, flowOut: true,
  desc: '输入为 1 时把当前实例从画布移除（输入 0 则保留；用于子弹命中消失等）',
  sockets: [{ key: 'v', dir: 'in', type: 'num', label: '删除?' }],
  run: function (inputs, inst) {
    if (inputs.v !== 1) return;
    var i = state.instances.findIndex(function (it) { return it.id === inst.id; });
    if (i >= 0) state.instances.splice(i, 1);
  },
});

// ---- 创建实例（动作）：输入为 1 时，在 8 邻域第一个空格子（无实例处）创建同对象新实例 ----
// ===================================================================
// 三、数学增强（逻辑/算术完备：补齐 非/取模/取整/绝对值/最小/最大）
// 配合已有的 加减乘除/比较/与或，运算节点覆盖完整逻辑与整数算术
// ===================================================================
function num1Def(type, label, fn) {
  registerNodeType(type, {
    name: label, category: '运算',
    desc: '单输入数字运算（未连线按 0）',
    sockets: [
      { key: 'a', dir: 'in', type: 'num', label: 'A' },
      { key: 'out', dir: 'out', type: 'num', label: '结果' },
    ],
    value: function (inputs) {
      var a = inputs.a === null || inputs.a === undefined ? 0 : inputs.a;
      return fn(a);
    },
  });
}
function num2Def(type, label, fn) {
  registerNodeType(type, {
    name: label, category: '运算',
    desc: '双输入数字运算（未连线按 0）',
    sockets: [
      { key: 'a', dir: 'in', type: 'num', label: 'A' },
      { key: 'b', dir: 'in', type: 'num', label: 'B' },
      { key: 'out', dir: 'out', type: 'num', label: '结果' },
    ],
    value: function (inputs) {
      var a = inputs.a === null || inputs.a === undefined ? 0 : inputs.a;
      var b = inputs.b === null || inputs.b === undefined ? 0 : inputs.b;
      return fn(a, b);
    },
  });
}
num1Def('numNot', '逻辑非 ?', function (a) { return a ? 0 : 1; });
num1Def('numAbs', '绝对值', function (a) { return Math.abs(a); });
num1Def('numFloor', '向下取整', function (a) { return Math.floor(a); });
num1Def('numCeil', '向上取整', function (a) { return Math.ceil(a); });
num1Def('numRound', '四舍五入', function (a) { return Math.round(a); });
num2Def('numMod', 'A % B', function (a, b) { return b === 0 ? 0 : a % b; });
num2Def('numMin', '较小值', function (a, b) { return Math.min(a, b); });
num2Def('numMax', '较大值', function (a, b) { return Math.max(a, b); });
// 比较运算（返回 0/1，供条件判断/控制节点使用）
num2Def('numLt', 'A < B', function (a, b) { return a < b ? 1 : 0; });
num2Def('numGt', 'A > B', function (a, b) { return a > b ? 1 : 0; });
num2Def('numEq', 'A = B', function (a, b) { return a === b ? 1 : 0; });
num2Def('numDiv', 'A / B', function (a, b) { return b === 0 ? 0 : a / b; });

// ===================================================================
// 游戏玩法节点：创建/删除指定对象实例（射击游戏：发射子弹、击杀敌人、重置）
// ===================================================================

// ---- 创建指定对象实例（动作）：位置未连线=当前实例左上角，连线=指定位置 ----
registerNodeType('createObjInst', {
  name: '创建指定对象', category: '控制', flowIn: true, flowOut: true,
  desc: '创建一个指定对象的实例（发射子弹、生成敌人、显示数字等）：对象=「对象索引」输入（未连线用参数）；位置未连线=当前实例位置，连线=指定位置',
  sockets: [
    { key: 'v', dir: 'in', type: 'num', label: '触发' },
    { key: 'pos', dir: 'in', type: 'vec', label: '位置' },
    { key: 'objIn', dir: 'in', type: 'num', label: '对象索引' },
  ],
  params: [{
    key: 'obj', label: '对象', type: 'select', num: true, def: -1,
    options: function () {
      const opts = [{ v: -1, label: '（无）' }];
      state.objects.forEach(function (o, i) { opts.push({ v: i, label: o.name }); });
      return opts;
    },
  }],
  run: function (inputs, inst, p) {
    if (inputs.v !== null && inputs.v !== undefined && inputs.v !== 1) return; // 触发：未连线=默认触发，连线=输入 1 才创建
    var oi = (inputs.objIn === null || inputs.objIn === undefined) ? p.obj : Math.round(inputs.objIn);
    if (oi < 0 || !state.objects[oi]) return;
    var x = inst.x, y = inst.y;
    if (inputs.pos) { x = inputs.pos.x; y = inputs.pos.y; }
    state.instances.push({ id: nextInstId++, objectIdx: oi, x: x, y: y, st: {}, layerIdx: inst.layerIdx });
  },
});

// ---- 删除指定对象的所有实例（动作）：输入 1 时清空场上该对象 ----
registerNodeType('deleteObjInst', {
  name: '删除指定对象', category: '控制', flowIn: true, flowOut: true,
  desc: '输入为 1 时删除指定对象的所有实例（清空场上该对象，如清空子弹/敌人）',
  sockets: [{ key: 'v', dir: 'in', type: 'num', label: '触发' }],
  params: [{
    key: 'obj', label: '对象', type: 'select', num: true, def: -1,
    options: function () {
      const opts = [{ v: -1, label: '（无）' }];
      state.objects.forEach(function (o, i) { opts.push({ v: i, label: o.name }); });
      return opts;
    },
  }],
  run: function (inputs, inst, p) {
    if (inputs.v !== null && inputs.v !== undefined && inputs.v !== 1) return; // 未连线=默认触发
    if (p.obj === -2) { // 删除所有对象的实例（保留当前实例所在对象，秒表刷新数字用）
      for (var i = state.instances.length - 1; i >= 0; i--) {
        if (state.instances[i].objectIdx !== inst.objectIdx) state.instances.splice(i, 1);
      }
      return;
    }
    if (p.obj < 0) return;
    for (var i = state.instances.length - 1; i >= 0; i--) {
      if (state.instances[i].objectIdx === p.obj) state.instances.splice(i, 1);
    }
  },
});

// ===================================================================
// 【模板】复制下面的注释块，改成自己的节点即可（写在本文件末尾即可生效）
// ===================================================================
/*
registerNodeType('myNode', {
  name: '我的节点', category: '自制', flowIn: true, flowOut: true,
  desc: '说明',
  sockets: [
    { key: 'a', dir: 'in', type: 'num', label: 'A' },
    { key: 'out', dir: 'out', type: 'num', label: '结果' },
  ],
  params: [{ key: 'n', label: '参数', type: 'number', min: -100, max: 100, step: 1, def: 1 }],
  // 数据节点：value 返回数字或 {x,y}
  value: function (inputs, inst, p, st) { return (inputs.a || 0) + p.n; },
  // 动作节点：run 每帧执行，可移动/创建/删除实例、读写像素
  run: function (inputs, inst, p, st) { inst.x += 1; },
});
*/

// ===================================================================
// 数字加减（运算完备：五子棋等需要 1-N / N+1 类算术）
// ===================================================================
num2Def('numAdd', 'A + B', function (a, b) { return a + b; });
num2Def('numSub', 'A - B', function (a, b) { return a - b; });
