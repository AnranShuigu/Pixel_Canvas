// ============================================================
// WASD：按下 W/A/S/D 分别在上/左/下/右生成一个新的同对象实例
// 用法：📂 导入本文件 或 粘贴到「🧩 自制」编辑器后「💾 保存并生效」，
//       然后在「自制」分类选「WASD 生成实例」节点，添加到对象节点图并运行。
//
// 【防卡死】每个按键独立边沿检测（按住不重复生成）；
//   新生成的实例 st 会继承当前 4 键的按下状态 → 按住不放时新实例不会连锁触发，不会指数爆炸卡死。
//
// 【反向】勾选后方向反转：W→下、S→上、A→右、D→左。
// 【速度】属性 + 右侧【速度】输出点：可把速度值连给其他节点使用。
//   反向值也可通过右侧【反向】输出点输出（0 或 1）。
// ============================================================
registerNodeType('spawnWasd', {
  name: 'WASD 生成实例',
  category: '自制',
  flowIn: true, flowOut: true,
  desc: '按 W/A/S/D 分别在上/左/下/右生成一个新的同对象实例（每次按下各方向生成 1 个，按住不重复；可调间隔格数；新实例不连锁触发，不会卡死）。「反向」勾选后方向反转；「速度」「反向」属性可在右侧输出点输出',
  sockets: [
    { key: 'speed', dir: 'out', type: 'num', label: '速度' },
    { key: 'reverse', dir: 'out', type: 'num', label: '反向' },
  ],
  params: [
    { key: 'gap', label: '间隔格数', type: 'number', def: 1, min: 0, max: 20, step: 1 },
    { key: 'speed', label: '速度', type: 'number', def: 1, min: 0.1, max: 100, step: 0.5 },
    { key: 'reverse', label: '反向', type: 'select', num: true, def: 0, options: function () { return [{ v: 0, label: '否' }, { v: 1, label: '是' }]; } },
  ],
  run: function (inputs, inst, p, st) {
    st.wasdSpeed = (p.speed === undefined || p.speed === null) ? 1 : p.speed;
    st.wasdReverse = p.reverse ? 1 : 0;
    var gap = Math.round(p.gap) >= 0 ? Math.round(p.gap) : 1;
    // 当前 4 键按下状态
    var down = {
      w: !!keys.has('KeyW'), a: !!keys.has('KeyA'),
      s: !!keys.has('KeyS'), d: !!keys.has('KeyD'),
    };
    // 各键上次状态（边沿检测：只有「刚按下」那一帧触发）
    var prev = { w: !!st.wPrev, a: !!st.aPrev, s: !!st.sPrev, d: !!st.dPrev };
    // 反向：W↔S、A↔D
    var dirs = p.reverse
      ? [
        { k: 'w', dx: 0, dy: 1, label: '下' },
        { k: 'a', dx: 1, dy: 0, label: '右' },
        { k: 's', dx: 0, dy: -1, label: '上' },
        { k: 'd', dx: -1, dy: 0, label: '左' },
      ]
      : [
        { k: 'w', dx: 0, dy: -1, label: '上' },
        { k: 'a', dx: -1, dy: 0, label: '左' },
        { k: 's', dx: 0, dy: 1, label: '下' },
        { k: 'd', dx: 1, dy: 0, label: '右' },
      ];
    for (var di = 0; di < dirs.length; di++) {
      var d = dirs[di];
      if (down[d.k] && !prev[d.k]) {
        var nx = Math.round(inst.x) + d.dx * gap;
        var ny = Math.round(inst.y) + d.dy * gap;
        // 目标格已有同对象实例则跳过（避免叠放）
        var occupied = false;
        for (var i = 0; i < state.instances.length; i++) {
          var it = state.instances[i];
          if (it.objectIdx === inst.objectIdx && Math.round(it.x) === nx && Math.round(it.y) === ny) {
            occupied = true; break;
          }
        }
        if (!occupied) {
          state.instances.push({
            id: nextInstId++,
            objectIdx: inst.objectIdx,
            x: nx,
            y: ny,
            // 关键：新实例继承当前 4 键状态，避免按住时新实例首帧连锁触发导致卡死
            st: { wPrev: down.w, aPrev: down.a, sPrev: down.s, dPrev: down.d },
            layerIdx: inst.layerIdx,
          });
          requestRender();
        }
      }
    }
    st.wPrev = down.w; st.aPrev = down.a; st.sPrev = down.s; st.dPrev = down.d;
  },
  // 右侧输出点：速度 / 反向（端口化：第 5 参 fromSock 区分输出哪个）
  value: function (inputs, inst, p, st, fromSock) {
    if (fromSock === 'reverse') return (st && st.wasdReverse !== undefined) ? st.wasdReverse : (p.reverse ? 1 : 0);
    return (st && st.wasdSpeed !== undefined) ? st.wasdSpeed : ((p.speed === undefined || p.speed === null) ? 1 : p.speed);
  },
});
