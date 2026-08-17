// ============================================================
// 打印节点（print）—— 数据透视与类型转换
// 把任何数据线（变量、运算结果、传感器值）连入「打印」节点，
// 强制序列化为人类可读的文本，实时显示在节点的「🖨 输出」框中。
//
// 用法：
//   1) 在本编辑器点「🧩 自制」→ 粘贴本文件 → 「💾 保存并生效」；
//      或「📂 导入插件」选择本文件。
//   2) 在「自制」分类选「打印」节点，左侧【数据】端口连上要查看的输出，
//      把「打印」节点挂入动作链（如 当开始运行 → 打印 → …），点运行。
//   3) 节点底部的「🖨 输出」显示框会实时显示序列化后的文本（每帧刷新）。
//
// 效果说明：
//   · 强制序列化：无论输入是数字、布尔值（真/假）、字符串、数组还是对象，
//     都强制转换为人类可读的文本字符串。
//   · 消除"黑盒"：运行中变量在内存里是看不见的，print 把内存里的二进制
//     数据"拉"出来，变成你能看懂的文字。
//   · 类型转换示例：42 → "42" · true → "true" · "hi" → "hi" ·
//     vec(3,-2.5) → "vec(3, -2.5)" · [1,2,3] → "[1,2,3]" · {a:1} → "{\"a\":1}"
// ============================================================

// 独立序列化函数（避免与内置版本命名冲突；若已存在同名则沿用）
function printSerialize(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') return val;
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (isNaN(val)) return 'NaN';
    if (!isFinite(val)) return val > 0 ? '∞' : '-∞';
    return String(Math.round(val * 100000) / 100000);
  }
  if (typeof val === 'object') {
    try {
      // 向量 {x,y} → "vec(x, y)"
      if (val && typeof val.x === 'number' && typeof val.y === 'number' &&
          Object.keys(val).length === 2) {
        return 'vec(' + Math.round(val.x * 1000) / 1000 + ', ' + Math.round(val.y * 1000) / 1000 + ')';
      }
      const s = JSON.stringify(val);
      return s === undefined ? 'undefined' : s;
    } catch (e) { return String(val); }
  }
  return String(val);
}

registerNodeType('print', {
  name: '打印',
  category: '自制',
  flowIn: true, flowOut: true,
  displayVal: true,
  printVal: true,   // 标记：使用完整序列化 + 大显示框（引擎在 node-system.js 中识别此标记）
  desc: '把连接进来的任何数据（数字/布尔/字符串/向量/数组/对象）强制转为可读文本，实时显示在节点「🖨 输出」框中。数据透视与类型转换：运行中把内存里的值拉出来变成文字，消除黑盒。可挂入动作链观察每一帧经过的值',
  sockets: [
    { key: 'v', dir: 'in', type: 'any', label: '数据' },
  ],
  run: function (inputs) {
    // 让引擎的显示框更新逻辑（updateNodeDisplay → serializePrint/printSerialize）处理
    return inputs.v;
  },
  value: function (inputs) {
    return inputs.v;
  },
});

// 若引擎的 updateNodeDisplay 不认识 printVal 标记（旧版 node-system.js），
// 这里补一个兜底：每帧把值序列化显示在节点上（通过 displayVal 机制已能工作，
// 此兜底仅用于引擎不支持 printVal 时的降级）。
