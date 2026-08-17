// ============================================================
// 显示值：左侧【连接】入口连接变量 / 运算 / 常量等任意输出，
// 节点的「值」显示框会实时显示上一个连接节点输出的值（运行中每帧刷新）。
// 用法：📂 导入本文件 或 粘贴到「🧩 自制」编辑器后「💾 保存并生效」，
//       在「自制」分类选「显示值」节点，左侧端口连上要查看的输出，点运行。
// ============================================================
registerNodeType('showVal', {
  name: '显示值',
  category: '自制',
  flowIn: true, flowOut: true,
  displayVal: true,
  desc: '左侧【连接】入口连接变量/运算等输出后，节点的「值」显示框实时显示上一个连接节点输出的值（运行中每帧刷新）；也可连入动作链显示每一帧经过的值',
  sockets: [
    { key: 'v', dir: 'in', type: 'num', label: '连接' },
  ],
  run: function (inputs, inst, p, st) {
    return inputs.v; // 值由引擎显示在「值」显示框中
  },
  value: function (inputs, inst, p, st, fromSock) {
    return inputs.v;
  },
});
