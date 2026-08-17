// ============================================================
// 空格键：在当前对象（实例）左侧重新生成一个新的同对象实例
// 用法：📂 导入本文件 或 粘贴到「🧩 自制」编辑器后「💾 保存并生效」，
//       然后在「自制」分类选「空格生成左侧对象实例」节点，添加到对象节点图并运行。
//
// 【防卡死】新生成的实例 st 会继承当前空格状态（spacePrev = 当前按下状态），
//   这样按住空格不放时：只有首个实例触发一次，新实例不会连锁触发 → 不会指数爆炸卡死。
// ============================================================
registerNodeType('spawnLeftOnSpace', {
  name: '空格生成左侧对象实例',
  category: '自制',
  flowIn: true, flowOut: true,
  desc: '按下空格键时，在当前实例左侧重新生成一个新的同对象实例（每次按下生成 1 个，按住不重复；新实例不会连锁触发，不会卡死；可调间隔格数）',
  params: [
    { key: 'gap', label: '间隔格数', type: 'number', def: 1, min: 0, max: 20, step: 1 },
  ],
  run: function (inputs, inst, p, st) {
    // 空格「按下瞬间」检测（边沿触发：按住不放不会每帧重复生成）
    var down = !!keys.has('Space');
    if (down && !st.spacePrev) {
      var obj = state.objects[inst.objectIdx];
      if (!obj) return;
      // 目标位置：当前实例左侧 gap 格
      var nx = Math.round(inst.x) - (Math.round(p.gap) >= 0 ? Math.round(p.gap) : 1);
      var ny = Math.round(inst.y);
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
          // 关键：新实例继承当前空格状态，避免按住空格时新实例首帧连锁触发导致卡死
          st: { spacePrev: down },
          layerIdx: inst.layerIdx,
        });
        requestRender();
      }
    }
    st.spacePrev = down;
  },
});
