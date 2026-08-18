'use strict';
const fs = require('fs');
let s = fs.readFileSync('node-system.js', 'utf8');
const crlf = function (x) { return x.replace(/\n/g, '\r\n'); };

// 1. fillScratchPalette 变量区控制：scratchVarRow → scratchVarBlock
const old1 = crlf("  if (els.scratchVarRow) els.scratchVarRow.style.display = (scratchCat === '变量') ? 'flex' : 'none';");
const new1 = crlf("  const vb = document.getElementById('scratchVarBlock');\n  if (vb) vb.style.display = (scratchCat === '变量') ? '' : 'none';");
if (s.indexOf(old1) < 0) { console.log('变量区锚点未找到'); process.exit(1); }
s = s.replace(old1, new1);

// 2. 编辑器：高亮 + 滚动同步 + 导入导出 + 打开时刷新高亮
const old2 = crlf("function openNodeJsEditor(code, title) {\n  nodeJsEl('nodeJsCode').value = code;\n  nodeJsEl('nodeJsTitle').textContent = title || '编辑自制节点';\n  nodeJsEl('nodeJsErr').textContent = '';\n  nodeJsEl('nodeJsModal').classList.add('open');\n  nodeJsEl('nodeJsCode').focus();\n}");
const new2 = crlf(`function openNodeJsEditor(code, title) {
  nodeJsEl('nodeJsCode').value = code;
  nodeJsEl('nodeJsTitle').textContent = title || '编辑自制节点';
  nodeJsEl('nodeJsErr').textContent = '';
  updateNodeJsHighlight();
  nodeJsEl('nodeJsModal').classList.add('open');
  nodeJsEl('nodeJsCode').focus();
}
// ---------- JS 语法高亮（VSCode 风格配色） ----------
function escHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function hlJS(code) {
  let h = escHtml(code);
  // 注释（优先，避免内部被字符串/关键字染色）
  h = h.replace(/(\/\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)/g, function (m) { return '<span class="tok-cmt">' + m + '</span>'; });
  // 字符串
  h = h.replace(/('(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|`(?:[^`\\\\]|\\\\.)*`)/g, function (m) { return '<span class="tok-str">' + m + '</span>'; });
  // 关键字
  h = h.replace(/\\b(function|return|const|let|var|if|else|for|while|new|typeof|instanceof|true|false|null|undefined|this|in|of|break|continue|switch|case|default|try|catch|throw|delete|void|class|extends|import|export|yield|async|await)\\b/g, '<span class="tok-kw">$1</span>');
  // 数字
  h = h.replace(/\\b(\\d+\\.?\\d*)\\b/g, '<span class="tok-num">$1</span>');
  return h;
}
function updateNodeJsHighlight() {
  const ta = nodeJsEl('nodeJsCode'), p = nodeJsEl('nodeJsHighlight');
  const st = ta.scrollTop, sl = ta.scrollLeft;
  p.innerHTML = hlJS(ta.value) || ' ';
  p.scrollTop = st; p.scrollLeft = sl;
}
nodeJsEl('nodeJsCode').addEventListener('input', updateNodeJsHighlight);
nodeJsEl('nodeJsCode').addEventListener('scroll', function () {
  const p = nodeJsEl('nodeJsHighlight');
  p.scrollTop = this.scrollTop; p.scrollLeft = this.scrollLeft;
});
// ---------- 导入 / 导出 JS ----------
nodeJsEl('nodeJsImport').addEventListener('click', function () { nodeJsEl('nodeJsImportFile').click(); });
nodeJsEl('nodeJsImportFile').addEventListener('change', function () {
  const f = this.files && this.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = function () {
    nodeJsEl('nodeJsCode').value = String(rd.result || '');
    updateNodeJsHighlight();
  };
  rd.readAsText(f);
  this.value = '';
});
nodeJsEl('nodeJsExport').addEventListener('click', function () {
  const code = nodeJsEl('nodeJsCode').value;
  const blob = new Blob([code], { type: 'text/javascript;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const m = code.match(/registerNodeType\\(\\s*['"]([^'"]+)['"]/);
  a.download = (m ? m[1] : 'custom-node') + '.js';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
});`);
if (s.indexOf(old2) < 0) { console.log('openNodeJsEditor 未找到'); process.exit(1); }
s = s.replace(old2, new2);

fs.writeFileSync('node-system.js', s);
console.log('node-system.js 已更新');
