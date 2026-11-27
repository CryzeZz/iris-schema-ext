/**
 * 面板样式断言：确认「Bootstrap 风格 + 兼容 VS Code 深色模式」这两件事
 * 是靠约束保证的，而不是靠某次截图恰好看着还行。
 *
 * 检查的是 media/panel.css 的文本，分四类：
 *   A. 主题安全   —— 不许出现写死的颜色（写死的颜色必然在某个主题下失效）
 *   B. 令牌体系   —— 语义令牌必须由 --vscode-* 驱动
 *   C. 深色/高对比适配 —— body.vscode-dark / high-contrast 分支必须存在
 *   D. Bootstrap 语言 —— 卡片 / 按钮层级 / focus ring / 表格节奏等关键特征
 *
 * 为什么用文本断言而不是截图比对：
 *   像素比对对字体渲染和 OS 太敏感，容易假失败；而这里要守住的规则
 *   （比如「不许写死 #ffffff」）本身是文本层面的，直接查更准。
 *
 * 用法：node scripts/test-panel-style.js
 */
const fs = require('fs');
const path = require('path');

const EXT_ROOT = path.join(__dirname, '..');
const CSS_PATH = path.join(EXT_ROOT, 'media', 'panel.css');
const JS_PATH = path.join(EXT_ROOT, 'media', 'panel.js');
const TS_PATH = path.join(EXT_ROOT, 'src', 'panel.ts');

const css = fs.readFileSync(CSS_PATH, 'utf8');
const js = fs.readFileSync(JS_PATH, 'utf8');
const ts = fs.readFileSync(TS_PATH, 'utf8');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name) {
  if (cond) {
    pass++;
    console.log('  PASS', name);
  } else {
    fail++;
    failures.push(name);
    console.log('  FAIL', name);
  }
}

/** 去掉注释，避免注释里提到的颜色值被当成违规 */
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');

console.log(`\n--- A. 主题安全（不许写死颜色） ---`);

// 找出所有十六进制色值，逐个判断是否在「允许清单」里。
// 允许的只有两种：
//   1. 作为 var(--vscode-xxx, #fallback) 的 fallback
//   2. 纯黑/纯白的 rgba() 阴影（阴影本来就不该跟随主题色，只在深色下调强度）
const hexMatches = [...cssNoComment.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
const allowedHex = new Set(['#f14c4c', '#d18616']); // 分别是 errorForeground / charts-orange 的 fallback
const badHex = hexMatches.filter((h) => !allowedHex.has(h.toLowerCase()));
ok(badHex.length === 0, `没有游离的写死十六进制色值${badHex.length ? '（发现 ' + badHex.join(', ') + '）' : ''}`);

// 写死的具名颜色同样不行（transparent / currentColor / inherit 除外）
const namedColors = [...cssNoComment.matchAll(/:\s*(white|black|red|green|blue|gray|grey|silver|orange|yellow)\s*[;!]/gi)].map((m) => m[1]);
ok(namedColors.length === 0, `没有写死的具名颜色${namedColors.length ? '（发现 ' + namedColors.join(', ') + '）' : ''}`);

ok(/--vscode-editor-background/.test(css), '背景取自 --vscode-editor-background');
ok(/--vscode-foreground/.test(css), '文字色取自 --vscode-foreground');
ok(/--vscode-button-background/.test(css), '强调色取自 --vscode-button-background');
ok(/--vscode-input-background/.test(css), '输入框底色取自 --vscode-input-background');
ok(/--vscode-focusBorder/.test(css), '焦点环取自 --vscode-focusBorder');
ok(/--vscode-list-hoverBackground/.test(css), '悬停色取自 --vscode-list-hoverBackground');
ok(/--vscode-descriptionForeground/.test(css), '次要文字取自 --vscode-descriptionForeground');
ok(/--vscode-errorForeground/.test(css), '危险色取自 --vscode-errorForeground');

console.log(`\n--- B. 语义令牌体系 ---`);

// 令牌必须定义在 :root，且值必须是 var(--vscode-*)
const tokenBlock = (css.match(/:root\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(tokenBlock.length > 200, ':root 里有完整的令牌定义块');

const requiredTokens = [
  '--surface',
  '--surface-raised',
  '--text',
  '--text-muted',
  '--line',
  '--accent',
  '--accent-fg',
  '--focus-ring',
  '--radius',
  '--shadow',
];
for (const t of requiredTokens) {
  ok(new RegExp(`${t}:`).test(tokenBlock), `令牌 ${t} 已定义`);
}

// 关键：表面 / 文字 / 强调三类令牌的值必须含 --vscode-，否则主题切换会失效
const tokenIsThemed = (name) => {
  const m = tokenBlock.match(new RegExp(`${name}:\\s*([^;]+);`));
  return !!m && /--vscode-/.test(m[1]);
};
ok(tokenIsThemed('--surface'), '--surface 由 --vscode-* 驱动（不是写死的色）');
ok(tokenIsThemed('--surface-raised'), '--surface-raised 由 --vscode-* 驱动');
ok(tokenIsThemed('--text'), '--text 由 --vscode-* 驱动');
ok(tokenIsThemed('--accent'), '--accent 由 --vscode-* 驱动');

// 下游规则不应再直接引用 --vscode-editor-background（应走 --surface），
// 否则令牌层就形同虚设。只允许出现在 :root 定义里。
const bodyCss = cssNoComment.replace(/:root\s*\{[\s\S]*?\n\}/, '');
const directBg = (bodyCss.match(/var\(--vscode-editor-background/g) || []).length;
ok(directBg <= 2, `下游规则不滥用 --vscode-editor-background（实际 ${directBg} 处，应为 0~2 处兜底）`);

console.log(`\n--- C. 深色 / 高对比度适配 ---`);

ok(/body\.vscode-dark\s*\{/.test(css), '存在 body.vscode-dark 分支');
ok(/body\.vscode-high-contrast/.test(css), '存在 body.vscode-high-contrast 分支');

// 深色分支里必须减弱阴影：黑底上压黑影会变成「洞」
const darkBlock = (css.match(/body\.vscode-dark\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(/--shadow/.test(darkBlock), '深色分支调整了阴影令牌');

// 高对比度分支里必须把阴影关掉、边框换成 contrastBorder
const hcBlock = (css.match(/body\.vscode-high-contrast[^{]*\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(/--shadow[^;]*:\s*none/.test(hcBlock), '高对比度下关闭阴影');
ok(/--vscode-contrastBorder/.test(hcBlock), '高对比度下边框改用 contrastBorder');

// HC 主题的 button-background 常与页面背景同为纯黑，实心按钮会「消失」。
// 必须有一个描边令牌在 HC 下被点亮（--accent-border），否则主按钮和选中态不可见。
ok(/--accent-border/.test(css), '存在按钮描边令牌 --accent-border');
ok(/--accent-border:\s*transparent/.test(css), '普通主题下 --accent-border 默认为 transparent（不改变外观）');
ok(/--accent-border:\s*var\(--vscode-contrastBorder/.test(hcBlock), '高对比度下 --accent-border 指向 contrastBorder');
ok(/button\.primary\s*\{[\s\S]{0,120}border:\s*1px solid var\(--accent-border\)/.test(css), '主按钮使用 --accent-border');
ok(/\.seg-btn\.active[\s\S]{0,220}--accent-border/.test(css), '分段控件选中态在 HC 下仍有可见轮廓');

// 浅色主题的 panel-border 很淡，表格必须有自己的线色，否则看不出行
ok(/--table-line:/.test(css), '表格线有独立令牌 --table-line（不直接复用 panel-border）');
ok(/border-bottom:\s*1px solid var\(--table-line\)/.test(css), '表格行线使用 --table-line');
ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), '尊重 prefers-reduced-motion');

console.log(`\n--- D. Bootstrap 视觉语言 ---`);

ok(/--sp-1:\s*4px/.test(css) && /--sp-4:\s*16px/.test(css), '采用 4px 栅格间距（Bootstrap 节奏）');
ok(/--radius-sm:\s*4px/.test(css) && /--radius-lg:\s*10px/.test(css), '圆角分级（4/6/10）');
ok(/--shadow-sm:/.test(css) && /--shadow-pop:/.test(css), '阴影分级（sm / card / popover）');
ok(/--ctrl-h:\s*30px/.test(css), '控件统一高度 --ctrl-h（工具条内元素严格对齐）');

// focus ring：Bootstrap 的标志性特征
ok(/focus[^{]*\{[\s\S]{0,120}box-shadow:\s*0 0 0 2px/.test(css), '表单控件有 Bootstrap 式 focus ring');
ok(/:focus-visible/.test(css), '按钮有 :focus-visible 键盘焦点样式');

// 按钮层级：primary / 次级
ok(/button\.primary\s*\{[\s\S]{0,200}background:\s*var\(--accent\)/.test(css), '主按钮用 --accent 实底');
ok(/--neutral-btn/.test(css), '次级按钮有独立的 neutral 令牌');

// 卡片：section / result-head
ok(/\.result-head\s*\{[\s\S]{0,400}border-bottom:\s*1px solid var\(--line\)/.test(css), '结果头是 card-header 式粘顶条');
ok(/\.section\s*\{[\s\S]{0,300}border-radius:\s*var\(--radius\)/.test(css), '小节是圆角卡片');
ok(/--th-bg/.test(css), '表头有独立底色令牌 --th-bg');
ok(/--zebra/.test(css), '表格有斑马纹令牌 --zebra');

// 错误块：Bootstrap alert 语言
ok(/\.err\s*\{[\s\S]{0,500}border-left-width:\s*3px/.test(css), '错误块是左粗边 alert 样式');
ok(/\.result\s*>\s*\.err/.test(css), '结果区顶部的错误块去掉上圆角（页面级 banner）');

console.log(`\n--- E. 不改动 DOM 契约（样式改造不应要求改 JS/TS） ---`);

// 样式脚本引用的每个类名，都必须真的出现在 JS 或 TS 产物里，否则是死样式
const cssClasses = new Set();
for (const m of cssNoComment.matchAll(/\.([a-z][a-z0-9-]*)/gi)) cssClasses.add(m[1]);
const jsClasses = new Set();
for (const m of js.matchAll(/className\s*=\s*'([^']+)'/g)) m[1].split(/\s+/).forEach((c) => jsClasses.add(c));
for (const m of js.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => jsClasses.add(c));
for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)) jsClasses.add(m[1]);
for (const m of ts.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => jsClasses.add(c));

// 这些类名由外部注入或只在样式内部使用，JS 侧本来就不会出现：
//   - vscode-dark / vscode-light / vscode-high-contrast*：VS Code 宿主写在 <body> 上的主题标记
//   - 其余是样式内部用的修饰类
const CSS_ONLY = new Set([
  'hidden', 'mono', 'grow', 'clickable', 'num', 'null', 'pk', 'body', 'html',
  'vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light',
]);
const orphan = [...cssClasses].filter((c) => !jsClasses.has(c) && !CSS_ONLY.has(c) && c.length > 2);
ok(orphan.length === 0, `没有悬空类名（JS/TS 里不存在的样式）${orphan.length ? '：' + orphan.join(', ') : ''}`);

// 关键结构不能被样式改造带偏
ok(/\.tablewrap/.test(css) && jsClasses.has('tablewrap'), 'tablewrap 容器仍由 JS 生成');
ok(/\.result-actions/.test(css) && jsClasses.has('result-actions'), 'result-actions 仍由 JS 生成');
ok(/\.mermaid-wrap/.test(css) && jsClasses.has('mermaid-wrap'), 'mermaid-wrap 仍由 JS 生成');

// 「更多查询」菜单的包含块必须落在 .toolbar 上。
// .menu 是 #moreBtn 的兄弟节点，按钮自己的 relative 管不到它；
// 少了 .toolbar 的 relative，菜单的 absolute 会一路找到 body，
// 按 body 高度算 100%，整个菜单被推到视口底部之外 —— 表现就是「点了没反应」。
// 先剥掉注释再判断：注释里为了解释这件事也会出现 "position: relative" 字样，
// 不剥离的话，把声明删干净了断言反而还是绿的。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const toolbarRule = stripComments((css.match(/\.toolbar\s*\{[^}]*\}/) || [''])[0]);
ok(/position\s*:\s*relative/.test(toolbarRule), '.toolbar 是 position: relative（.menu 的定位锚点）');
ok(!/position\s*:\s*fixed/.test(stripComments((css.match(/\.menu\s*\{[^}]*\}/) || [''])[0])),
  '.menu 不用 fixed 定位（会失去按钮锚点）');

console.log(`\n${fail ? 'FAIL' : 'PASS'}  通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('失败项:\n  - ' + failures.join('\n  - '));
}
process.exit(fail ? 1 : 0);
