// ============================================================
// 自制示例节点（模板）：可直接根据此文件修改，制作自己的节点
// 用法：📂 导入本文件（节点编辑器 → 插件库 → 导入插件）→ 点【保存】永久保存；
//       或在「🧩 自制」编辑器粘贴本文件内容后「💾 保存并生效」。
// 节点库「自制」分类出现「自制示例」节点。
//
// ────────────────────────────────────────────────
// 一、此节点如何实现具体功能？
// ────────────────────────────────────────────────
//  1) registerNodeType('节点id', { ... }) 注册一个节点，'节点id' 是唯一标识（如 customExample）。
//  2) 对象里的字段决定节点的外观与行为：
//       name      —— 节点在节点库/画布上显示的名称
//       category  —— 所属分类（自制 / 画笔 / …）
//       desc      —— 鼠标悬停显示的功能说明
//       flowIn / flowOut —— 顶部执行流输入/输出端口：
//          加了 flowIn + flowOut 的节点可以连进动作链（whenStart → 本节点 → 下一节点），
//          每一帧会按顺序执行本节点的 run 函数（run 里写"每帧要做什么"）。
//       sockets   —— 数据输入/输出端口（见下方"二"）
//       params    —— 节点上的参数（选择框 / 输入框 / 数字框 / 颜色，见下方"二"）
//       displayVal —— 底部「值」显示框（见下方"三"）
//       run       —— 动作函数：flowIn/flowOut 时每帧调用，用来执行"动作"（移动、绘制、改变状态等）
//       value     —— 数据函数：当别的节点从这个节点的输出端口取数据时调用，返回该输出端口的值
//  3) 节点添加到对象节点图并运行后：引擎每帧执行链上的 run；数据端口之间的连线在需要时自动调用 value。
//
// ────────────────────────────────────────────────
// 二、下方每个输入/输出点如何实现具体功能？
// ────────────────────────────────────────────────
//  ▸ 输入端口（左侧 ●）：在 sockets 里定义 { key:'a', dir:'in', type:'num', label:'输入A' }
//        - key   端口标识（在 run / value 里用 inputs.a 读取连线传来的值）
//        - dir   'in' 输入 / 'out' 输出
//        - label 节点上显示的名字
//     读取方式：run/value 的第一个参数 inputs，如 inputs.a、inputs.b、inputs.c。
//     未连线时 inputs.a 为 null，代码里要判空（例：inputs.a === null ? 0 : inputs.a）。
//     参数也可以带输入端口：params 里写 port:'sel1In'，且 sockets 里定义该端口，
//     连线时参数框自动禁用、优先使用连线值（inputs.sel1In）。
//  ▸ 输出端口（右侧 ●）：在 sockets 里定义 { key:'outA', dir:'out', type:'num', label:'输出A' }
//        - value 函数按"第 5 个参数 fromSock"区分当前要输出哪个端口：
//              fromSock === 'outA' → 返回输出A 的值
//              fromSock === 'outB' → 返回输出B 的值
//        - 节点可以有多个输出端口，各自返回不同数据（端口化输出）。
//     参数带输出端口：params 里写 out:'txtOut'（输入框右侧 ●，输出输入框的值），
//     该端口也在 sockets 定义，value 里用 fromSock === 'txtOut' 返回。
//  ▸ 参数（选择框/输入框）：
//        - 选择框 { type:'select', options:function(){return [{v:'x',label:'选项X'},...]} }
//              运行里用 p.sel1 读取选中的值；v 是存储值、label 是显示文字。
//        - 输入框 { type:'text' }  运行里用 p.txt 读取文本。
//        - 数字框 { type:'number' } 运行里用 p.xxx 读取数字。
//
// ────────────────────────────────────────────────
// 三、显示框如何实现显示字符？
// ────────────────────────────────────────────────
//  在节点定义里写 displayVal: true，节点底部会自动出现一个「值」显示框。
//  引擎会把该节点 value 函数的"主输出值"（默认输出，即 fromSock 之外的返回值）
//  实时显示在显示框里（每帧刷新）：
//        - 数字  → 显示为数字（如 3.142）
//        - 字符串 → 显示为带引号的字符串（如 "得分"）
//        - 布尔  → 显示为 真(1) / 假(0)
//        - 空    → 显示为 —
//  想显示哪个字符/数字，就让 value 返回它即可；
//  本示例中「显示框1」还带一个输入端口 dispIn，连线后显示框优先显示该输入值。
//  注意：字符超出一定长度会自动省略（显示 …）。
//
// 结构（对照示意）：
//   ◀ 名称 ▶
//   ● 输入A / 输入B / 输入C        ← 输入端口（左侧）
//   输出A / 输出B / 输出C          ← 输出端口（右侧）
//   ● [选择框 ▼]                  ← 选择框参数 + 左侧输入端口（连线时优先使用连线值）
//   [选择框2 ▼] ●                 ← 选择框参数 + 右侧输出端口（输出当前值）
//   [输入框] ●                    ← 文本输入参数 + 右侧输出端口（输出输入框的值）
//   ● [显示框1]                   ← 「值」显示框 + 左侧输入端口（显示输入的值）
// ============================================================
registerNodeType('customExample', {
  name: '自制示例',            // 节点名称
  category: '自制',            // 分类（自制/画笔/…）
  flowIn: true, flowOut: true, // 顶部执行流输入/输出（可连入动作链，每帧执行 run）
  displayVal: true,            // 底部「值」显示框（实时显示 value 主输出值）
  desc: '自制节点示例模板：输入A/B/C、输出A/B/C、选择框（带输入端口）、选择框2（带输出端口）、输入框（带输出端口）、显示框（带输入端口），可按需修改后另存为新节点',
  sockets: [
    // —— 输入端口（左侧） ——
    { key: 'a', dir: 'in', type: 'num', label: '输入A' },
    { key: 'b', dir: 'in', type: 'num', label: '输入B' },
    { key: 'c', dir: 'in', type: 'num', label: '输入C' },
    // 第一个选择框左侧的输入端口（连线时优先使用连线值）
    { key: 'sel1In', dir: 'in', type: 'num', label: '选择框' },
    // 显示框 左侧的输入端口（显示该输入的值）
    { key: 'dispIn', dir: 'in', type: 'num', label: '显示框' },
    // —— 输出端口（右侧） ——
    { key: 'outA', dir: 'out', type: 'num', label: '输出A' },
    { key: 'outB', dir: 'out', type: 'num', label: '输出B' },
    { key: 'outC', dir: 'out', type: 'num', label: '输出C' },
    // 第二个选择框右侧的输出端口（输出选择框当前值）
    { key: 'sel2Out', dir: 'out', type: 'num', label: '选择框2' },
    // 输入框右侧的输出端口（输出输入框的值）
    { key: 'txtOut', dir: 'out', type: 'num', label: '输入框' },
  ],
  params: [
    { key: 'sel1', label: '选择框', type: 'select', def: 'x', port: 'sel1In', options: function () { return [{ v: 'x', label: '选项X' }, { v: 'y', label: '选项Y' }]; } },
    { key: 'sel2', label: '选择框2', type: 'select', def: 'x', options: function () { return [{ v: 'x', label: '选项X' }, { v: 'y', label: '选项Y' }]; } },
    { key: 'txt', label: '输入框', type: 'text', def: '', out: 'txtOut' },
  ],
  // 动作执行（flowIn/flowOut 时每帧调用）：在此写你的逻辑
  run: function (inputs, inst, p, st) {
    // 输入值：inputs.a / inputs.b / inputs.c / inputs.sel1In / inputs.dispIn
    // 参数值：p.sel1 / p.sel2 / p.txt
    // 实例状态：st.xxx（每个实例独立）
    // 示例：每帧把实例向下移动一格
    // inst.y += 1;
  },
  // 数据输出（端口化：第 5 参 fromSock 区分输出哪个端口）
  value: function (inputs, inst, p, st, fromSock) {
    if (fromSock === 'outB') return (inputs.b === null || inputs.b === undefined) ? 0 : inputs.b;
    if (fromSock === 'outC') return (inputs.c === null || inputs.c === undefined) ? 0 : inputs.c;
    if (fromSock === 'sel2Out') return p.sel2 === 'y' ? 1 : 0;
    if (fromSock === 'txtOut') return (p.txt === undefined || p.txt === null || p.txt === '') ? 0 : p.txt;
    // 输出A / 显示框1：优先显示显示框1输入值，否则输出输入A
    if (inputs.dispIn !== null && inputs.dispIn !== undefined) return inputs.dispIn;
    return (inputs.a === null || inputs.a === undefined) ? 0 : inputs.a;
  },
});
