// ============================================================
// 插件示例节点（模板）：可直接根据此文件修改，制作自己的插件
// 用法：📂 导入本文件（节点编辑器 → 插件库 → 导入插件）
//       导入后本文件注册的所有节点自动出现在「插件」分类（插件库）中，
//       节点按钮右键可随时编辑 JS；点插件库的 × 删除插件，刷新后节点一并移除。
// 参考：同目录下的 自制示例.js（自制分类）讲解各字段含义，
//       本文件是「插件」分类的完整示例，包含 5 个节点：
//
//   【插件示例】  综合模板：流程 + 输入/输出端口 + 参数 + 显示框（最全）
//   【插件示例1】 流程动作节点：每帧执行 run（如每帧移动/计数）
//   【插件示例2】 数据节点：value 返回数值，供其他节点连线取值
//   【插件示例3】 检测节点：value 返回 真/假（0/1），可做条件
//   【插件示例4】 参数+端口节点：选择框、数字、输入框与输入/输出端口组合
//
// ────────────────────────────────────────────────
// 一、如何添加自己的插件节点？
// ────────────────────────────────────────────────
//  1) 复制下面任意一个 registerNodeType('xxx', { ... })，改名为你的节点 id（唯一）。
//  2) 修改 name / category / desc / sockets / params / run / value。
//  3) 保存为 .js 文件，在节点编辑器 → 插件库 → 📂 导入插件 导入即可。
//
//  ─ 字段速查 ─
//    name      节点在节点库/画布上显示的名称
//    category  分类（插件示例统一用 '插件'，会进入插件库；也可用 '自制' 等）
//    desc      鼠标悬停说明
//    flowIn / flowOut  顶部执行流端口：连入动作链后每帧执行 run
//    sockets   输入端口（左侧 ●）/ 输出端口（右侧 ●）
//    params    参数框（选择框 / 数字框 / 文本输入框 / 颜色框）
//    displayVal 底部「值」显示框（实时显示 value 主输出）
//    run       动作函数（flowIn/flowOut 时每帧执行）
//    value     数据函数（从输出端口取数时调用；第 5 参 fromSock 区分输出哪个端口）
//
//  ─ 输入/输出读取 ─
//    run/value 的第一参 inputs：inputs.端口key 读连线值（未连线为 null，要判空）
//    参数值用 p.参数key 读取；实例独立状态用 st.xxx（每实例一份）
//
// ────────────────────────────────────────────────
// 二、各节点对应结构示意
// ────────────────────────────────────────────────
// 【插件示例】：
//   ◀ 插件示例 ▶
//   ● 数值A / 数值B ●  ← 输入（左）/ 输出（右）
//   ● [选择框 ▼]      ← 参数 + 左侧输入端口
//   [开关] ●          ← 参数 + 右侧输出端口
//   ● [显示框]        ← 显示框 + 左侧输入端口
// 【插件示例1】：◀ 插件示例1 ▶（flow 流程节点，每帧执行 run）
// 【插件示例2】：◀ 插件示例2 ▶（数据节点：● 数值 → 返回）
// 【插件示例3】：◀ 插件示例3 ▶（检测节点：● 比较值 → 返回 真/假）
// 【插件示例4】：◀ 插件示例4 ▶（参数+端口综合：选择框/数字/输入框 ● 端口）
// ============================================================

// ---------- 【插件示例】综合模板 ----------
// 展示插件节点的完整能力：流程、输入/输出端口、参数（含带端口参数）、显示框
registerNodeType('pluginExample', {
  name: '插件示例',            // 节点名称
  category: '插件',            // 分类：插件（进入插件库）
  flowIn: true, flowOut: true, // 顶部执行流输入/输出（可连入动作链，每帧执行 run）
  displayVal: true,            // 底部「值」显示框（实时显示 value 主输出值）
  desc: '插件综合模板：输入A/输出A、选择框（带输入端口）、开关（带输出端口）、显示框（带输入端口），可按需修改后另存为你的插件节点',
  sockets: [
    // 输入端口（左侧 ●）
    { key: 'a', dir: 'in', type: 'num', label: '数值A' },
    // 选择框左侧输入端口（连线时优先使用连线值）
    { key: 'selIn', dir: 'in', type: 'num', label: '选择框' },
    // 显示框左侧输入端口（显示该输入的值）
    { key: 'dispIn', dir: 'in', type: 'num', label: '显示框' },
    // 输出端口（右侧 ●）
    { key: 'outA', dir: 'out', type: 'num', label: '数值A' },
    // 开关右侧输出端口（输出开关当前值 0/1）
    { key: 'swOut', dir: 'out', type: 'num', label: '开关' },
  ],
  params: [
    // 选择框 + 输入端口：连线时参数框自动禁用、优先用连线值（inputs.selIn）
    { key: 'sel', label: '选择框', type: 'select', def: 'x', port: 'selIn', options: function () { return [{ v: 'x', label: '选项X' }, { v: 'y', label: '选项Y' }]; } },
    // 开关 + 输出端口：输出当前选中的值（inputs.swOut）
    { key: 'sw', label: '开关', type: 'select', def: 'on', options: function () { return [{ v: 'on', label: '开' }, { v: 'off', label: '关' }]; } },
  ],
  // 动作执行（每帧）：在这里写你的逻辑（移动、绘制、改状态等）
  run: function (inputs, inst, p, st) {
    // inputs.a / inputs.selIn / inputs.dispIn —— 连线输入值（未连线为 null）
    // p.sel / p.sw —— 参数值
    // st.xxx —— 每实例独立状态
    // 示例：每帧把实例向右移动一格（取消注释生效）
    // inst.x += 1;
    // 示例：每帧累计一个帧数（取消注释生效）
    // st.frames = (st.frames || 0) + 1;
  },
  // 数据输出（第 5 参 fromSock 区分输出哪个端口）
  value: function (inputs, inst, p, st, fromSock) {
    if (fromSock === 'swOut') return p.sw === 'on' ? 1 : 0;          // 开关端口输出 1/0
    if (inputs.dispIn !== null && inputs.dispIn !== undefined) return inputs.dispIn; // 显示框优先显示输入值
    return (inputs.a === null || inputs.a === undefined) ? 0 : inputs.a;             // 主输出 = 数值A
  },
});

// ---------- 【插件示例1】流程动作节点 ----------
// 最简单的流程节点：加 flowIn/flowOut，每帧执行 run（适合做移动、计时、播放等持续动作）
registerNodeType('pluginExample1', {
  name: '插件示例1',            // 节点名称
  category: '插件',
  flowIn: true, flowOut: true, // 连入动作链后每帧执行 run
  desc: '插件流程节点示例：每帧执行一次 run（示例：每帧让实例向下移动 1 格、并累计执行次数到 st.count）。复制本节点改 run 即可做你的持续动作',
  // run：每帧调用，第一个参数 inputs（输入端口值）、第三个参数 p（参数值）、第四个参数 st（实例状态）
  run: function (inputs, inst, p, st) {
    // 示例逻辑（取消注释生效）：
    // inst.y += 1;                      // 每帧向下移动 1 格
    // st.count = (st.count || 0) + 1;   // 每帧累计执行次数（每实例独立）
  },
});

// ---------- 【插件示例2】数据节点 ----------
// 数据节点：value 返回一个数值/文本，别的节点连它的输出端口即可取值
// 适合做"得分""血量""随机数""坐标"等数据源
registerNodeType('pluginExample2', {
  name: '插件示例2',
  category: '插件',
  desc: '插件数据节点示例：value 返回数值（示例：返回画布坐标 x+y）。想输出什么就让 value 返回什么（数值/文本/布尔）',
  sockets: [
    { key: 'out', dir: 'out', type: 'num', label: '数值' }, // 输出端口（右侧 ●）
  ],
  // value：别的节点从这个节点取数时调用，返回输出值
  value: function (inputs, inst, p, st) {
    // 示例：返回实例的 x 与 y 坐标之和（取消注释生效）
    // return inst.x + inst.y;
    return 0; // 默认返回 0
  },
});

// ---------- 【插件示例3】检测节点 ----------
// 检测/条件节点：value 返回 真(1) / 假(0)，可接「如果(条件)」等判断节点
// 适合做"碰到边界?""血量<0?""按下某键?"等条件判断
registerNodeType('pluginExample3', {
  name: '插件示例3',
  category: '插件',
  desc: '插件检测节点示例：带输入端口「比较值」，value 返回 真(1)/假(0)（示例：比较值 > 50 返回 1，否则 0）。可接条件判断节点使用',
  sockets: [
    { key: 'v', dir: 'in', type: 'num', label: '比较值' }, // 输入端口（左侧 ●）
    { key: 'out', dir: 'out', type: 'num', label: '结果' }, // 输出端口（右侧 ●）
  ],
  value: function (inputs, inst, p, st) {
    const v = (inputs.v === null || inputs.v === undefined) ? 0 : inputs.v;
    // 示例：比较值大于 50 返回 1（真），否则 0（假）（取消注释生效）
    // return v > 50 ? 1 : 0;
    return 0;
  },
});

// ---------- 【插件示例4】参数+端口综合节点 ----------
// 参数与端口组合：选择框、数字框、文本输入框，以及带输入/输出端口的参数
// 适合做可配置的复杂节点（如"音效设置""颜色选择""文本消息"）
registerNodeType('pluginExample4', {
  name: '插件示例4',
  category: '插件',
  flowIn: true, flowOut: true,
  displayVal: true,
  desc: '插件参数综合示例：选择框「类型」、数字框「倍率」（带输入端口）、输入框「消息」（带输出端口）、显示框。演示参数/端口组合的写法',
  sockets: [
    // 「倍率」左侧输入端口（连线时优先用连线值）
    { key: 'mulIn', dir: 'in', type: 'num', label: '倍率' },
    // 「消息」右侧输出端口（输出输入框内容）
    { key: 'msgOut', dir: 'out', type: 'num', label: '消息' },
  ],
  params: [
    { key: 'type', label: '类型', type: 'select', def: 'a', options: function () { return [{ v: 'a', label: '类型A' }, { v: 'b', label: '类型B' }, { v: 'c', label: '类型C' }]; } },
    { key: 'mul', label: '倍率', type: 'number', port: 'mulIn', min: 0, max: 100, step: 1, def: 1 },
    { key: 'msg', label: '消息', type: 'text', def: '你好', out: 'msgOut' },
  ],
  run: function (inputs, inst, p, st) {
    // p.type —— 选择框选中的值（'a'/'b'/'c'）
    // p.mul / inputs.mulIn —— 倍率（未连线用参数 p.mul，连线用 inputs.mulIn）
    // p.msg —— 输入框文本
    // 示例：每帧把 x 加上 倍率（取消注释生效）
    // const mul = (inputs.mulIn === null || inputs.mulIn === undefined) ? p.mul : inputs.mulIn;
    // inst.x += mul;
  },
  value: function (inputs, inst, p, st, fromSock) {
    if (fromSock === 'msgOut') return (p.msg === undefined || p.msg === null || p.msg === '') ? 0 : p.msg; // 消息端口输出文本
    return (inputs.mulIn === null || inputs.mulIn === undefined) ? p.mul : inputs.mulIn;                   // 主输出 = 倍率
  },
});

// ============================================================
// 快速添加你的插件节点：
//   复制 registerNodeType('你的id', { ... }); 到文件末尾（两个 // === 之间），
//   改 name/category/desc/sockets/params/run/value 即可。
//   导入后如要修改，节点按钮上右键 → 编辑 JS。
// ============================================================
