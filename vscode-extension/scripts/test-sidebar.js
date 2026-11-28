/**
 * 验证活动栏入口（侧边图标 + 侧边栏视图）。
 *
 * 这几处出错时 VS Code 不会报错，只会「图标不显示」或「侧边栏一片空白」，
 * 所以必须静态校验 —— 光靠 tsc 查不出来：
 *   1) package.json 的 viewsContainers / views / activationEvents 结构；
 *   2) 图标符合 VS Code 活动栏要求（24x24、单色、只用 currentColor）；
 *   3) 侧边栏视图 HTML 在「有配置 / 无配置」两种状态下都能正确渲染。
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const root = path.resolve(__dirname, '..');
let failed = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  PASS ' + msg);
  else {
    failed++;
    console.log('  FAIL ' + msg + (extra ? '  →  ' + extra : ''));
  }
};

// ---------------- 1. package.json ----------------
console.log('\n--- 标识与显示名 ---');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// 与 iris-xml2udl 保持一致的命名规则：name 用 kebab-case，displayName 全小写空格分隔
ok(pkg.name === 'iris-schema', 'name 为 iris-schema', pkg.name);
ok(pkg.displayName === 'iris schema', 'displayName 为 iris schema（全小写）', pkg.displayName);
ok(/^[a-z0-9-]+$/.test(pkg.name), 'name 是合法的 kebab-case 标识符', pkg.name);
ok(pkg.displayName === pkg.displayName.toLowerCase(), 'displayName 没有大写字母', pkg.displayName);

console.log('\n--- package.json 活动栏贡献点 ---');
const bar = ((pkg.contributes.viewsContainers || {}).activitybar || []).find((x) => x.id === 'irisSchema');
ok(!!bar, 'viewsContainers.activitybar 有 irisSchema');
ok(bar && bar.title === pkg.displayName, '侧边栏标题与 displayName 一致', bar && bar.title);
ok(bar && fs.existsSync(path.join(root, bar.icon)), 'icon 文件存在', bar && bar.icon);

// 文档里不能再残留旧名
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
ok(!/IRIS Schema Explorer/.test(readme), 'README 里没有旧名 IRIS Schema Explorer');
ok(/# iris schema/.test(readme), 'README 一级标题是新名');

const views = (pkg.contributes.views || {}).irisSchema || [];
ok(views.length === 1 && views[0].id === 'irisSchema.welcome', '挂了一个视图 irisSchema.welcome');
ok(views[0] && views[0].type === 'webview', '视图类型是 webview');

const acts = pkg.activationEvents || [];
ok(acts.includes('onView:irisSchema.welcome'), 'activationEvents 含 onView（缺了点图标不会激活扩展）');

// ---------------- 2. 图标 ----------------
console.log('\n--- 活动栏图标规范 ---');
const svg = fs.readFileSync(path.join(root, 'media', 'activity.svg'), 'utf8');
ok(/viewBox="0 0 24 24"/.test(svg), 'viewBox 为 0 0 24 24');
ok(/<svg[^>]*\swidth="24"/.test(svg) && /<svg[^>]*\sheight="24"/.test(svg), 'width/height 都是 24');
ok(/currentColor/.test(svg), '用 currentColor 跟随主题');
const paints = svg.match(/(?:fill|stroke)="([^"]*)"/g) || [];
const bad = paints.filter((p) => !/"(none|currentColor|var\(--vscode-)/.test(p));
ok(!bad.length, '没有写死颜色', bad.join(' '));
ok(!/<script/i.test(svg), 'SVG 里没有 script');

// 图标内容：必须是从 icon.png 描出来的「IR」字标，不能退回原来的表格+放大镜
// （换图标的动机就是品牌统一，形状被改回去要能立刻发现）
ok(/<rect[^>]*width="3\.\d+"/.test(svg), '有 I 的细竖条（宽度 ~3.5，来自 icon.png 实测）');
ok(/<path[^>]*fill-rule="nonzero"/.test(svg), 'R 的实心部分用 nonzero 求并集');
ok(/<path[^>]*fill-rule="evenodd"/.test(svg), 'R 的字腔用 evenodd 挖空');
ok(/A[\d.]+ [\d.]+ 0 0 1/.test(svg), '字腔用圆弧（否则会画成正圆顶，与原图不像）');
ok(!/<circle/.test(svg), '没有放大镜的 circle（旧图标残留）');
ok(!/--vscode-activityBar-background/.test(svg), '没有依赖活动栏背景色挖空（换主题会露馅）');

// 市场列表图标：PNG 格式（vsce 明确拒绝 SVG），尺寸不小于 128x128 且为正方形。
// vsce 自身只校验「文件存在」和「不是 SVG」，尺寸是 Marketplace 页面的要求：
// 最小 128x128，官方建议 256x256。原来这条断言写死 512x512，是错的。
const mpIcon = path.join(root, pkg.icon || '');
ok(!!pkg.icon && fs.existsSync(mpIcon), 'package.json 声明了市场图标且文件存在', pkg.icon);
if (fs.existsSync(mpIcon)) {
  const buf = fs.readFileSync(mpIcon);
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  ok(isPng, '市场图标是合法 PNG');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  ok(w === h, '市场图标是正方形', `${w}x${h}`);
  ok(w >= 128, '市场图标不小于 128x128（Marketplace 下限）', `${w}x${h}`);
}

// ---------------- 3. 侧边栏视图 HTML ----------------
console.log('\n--- 侧边栏视图渲染 ---');

// 用假 vscode 模块加载 extension.js，抓出 provider 实例。
// executeCommand 要记录调用 —— 侧边栏按钮是 postMessage → executeCommand 这条链，
// 只断言 HTML 里有按钮是不够的（曾经 enableScripts:false 导致点了完全没反应）。
const fakePath = path.join(root, '.fake-vscode-sidebar.js');
fs.writeFileSync(
  fakePath,
  `global.__cmds = [];
   module.exports = {
     env: { language: process.env.IRIS_TEST_LANG || 'zh-cn' },
     window: { registerWebviewViewProvider: (id, prov) => { global.__prov = prov; return { dispose() {} }; } },
     commands: {
       registerCommand: () => ({ dispose() {} }),
       executeCommand: (cmd) => { global.__cmds.push(cmd); return Promise.resolve(); },
     },
     workspace: { getConfiguration: () => ({ get: (_k, d) => d, inspect: () => undefined }) },
   };`,
  'utf8'
);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'vscode') return fakePath;
  return origResolve.call(this, r, ...a);
};
require(path.join(root, 'out', 'extension.js')).activate({ subscriptions: [], extensionUri: { fsPath: root } });
const provider = global.__prov;
Module._resolveFilename = origResolve;
fs.unlinkSync(fakePath);

ok(!!provider && typeof provider.resolveWebviewView === 'function', 'provider 已注册且实现 resolveWebviewView');

function renderWith(profiles, from) {
  // 直接替换 out/config.js 的 loadProfiles 导出，模拟不同配置状态
  const cfgMod = require(path.join(root, 'out', 'config.js'));
  const real = cfgMod.loadProfiles;
  cfgMod.loadProfiles = () => ({ profiles, defaultProfile: profiles[0]?.profile || null, path: from, vscodePath: from });
  const captured = { messages: [] };
  provider.resolveWebviewView({
    webview: {
      set options(v) {
        captured.options = v;
      },
      set html(v) {
        captured.html = v;
      },
      onDidReceiveMessage(cb) {
        captured.onMessage = cb;
        return { dispose() {} };
      },
    },
  });
  cfgMod.loadProfiles = real;
  return captured;
}

const cap = renderWith(
  [{ profile: '138', host: '10.0.0.138', web_port: 52773 }, { profile: 'local', host: '127.0.0.1', web_port: 52773 }],
  'settings.json › intersystems.servers'
);
const withCfg = cap.html || '';

// 文案断言从词条表取，不写死中文字面量。
// 原来这里写的是 /已读取 2 个连接/ —— 界面双语化之后，英文环境下这条必然失败，
// 但失败原因跟侧边栏渲染无关。改成按当前语言的词条来断言，两种语言下都验证真实文案。
// 语言由 IRIS_TEST_LANG 环境变量决定（默认 zh-cn，与 fake vscode 里的 env.language 一致）。
const i18n = require(path.join(root, 'out', 'i18n.js'));
const LANG = (process.env.IRIS_TEST_LANG || 'zh-cn').startsWith('zh') ? 'zh' : 'en';
i18n.setLanguage(LANG);
const msg = (k, ...a) => i18n.t(k, ...a);
console.log(`  （当前断言语言：${LANG}）`);

ok(withCfg.includes(msg('sidebar.connected', 2)), '有配置时显示连接数量', msg('sidebar.connected', 2));
ok(/intersystems\.servers/.test(withCfg), '显示配置来源');
ok(/acquireVsCodeApi\(\)/.test(withCfg), '含 acquireVsCodeApi');
ok(/Content-Security-Policy/.test(withCfg), '含 CSP');
ok(/id="open"/.test(withCfg) && /id="reload"/.test(withCfg), '两个按钮都在');
ok(/<h3>iris schema<\/h3>/.test(withCfg), '侧边栏标题用新名 iris schema');
// <html lang> 跟着界面语言走
ok(withCfg.includes(`<html lang="${LANG === 'zh' ? 'zh-CN' : 'en'}"`), '<html lang> 跟随界面语言', LANG);

// 按钮能点的前提有三个，缺一个就静默失效：
//   a) enableScripts 必须 true —— 否则 <script> 整段不执行
//   b) CSP 的 script-src 必须允许内联 —— 否则脚本被拦
//   c) 消息回调要真的分发到命令
ok(cap.options && cap.options.enableScripts === true, 'enableScripts 为 true（否则按钮点了没反应）', JSON.stringify(cap.options));
ok(/script-src[^;]*'unsafe-inline'/.test(withCfg), "CSP 的 script-src 允许内联脚本");

// c) 真正模拟点击消息，验证命令被调起。
//    假 vscode 里 executeCommand 必须记录调用，否则「点了没反应」这类问题查不出来。
ok(typeof cap.onMessage === 'function', '注册了 onDidReceiveMessage');

global.__cmds.length = 0;
cap.onMessage({ type: 'open' });
ok(global.__cmds.includes('irisSchema.openPanel'), '点「打开查询面板」调起 irisSchema.openPanel', JSON.stringify(global.__cmds));

global.__cmds.length = 0;
cap.onMessage({ type: 'reload' });
ok(global.__cmds.includes('irisSchema.refreshConnections'), '点「重新加载连接配置」调起 irisSchema.refreshConnections', JSON.stringify(global.__cmds));

global.__cmds.length = 0;
cap.onMessage({ type: 'unknown-op' });
ok(global.__cmds.length === 0, '未知消息不误触发命令');

const noCfgCap = renderWith([], null);
const noCfg = noCfgCap.html || '';
ok(noCfg.includes(msg('sidebar.notConfigured')), '无配置时提示未找到', msg('sidebar.notConfigured'));
ok(/intersystems\.servers/.test(noCfg), '无配置时给出配置指引');
// 无配置不应因为 from 为 null 渲染出 "null" 字样
ok(!/>null</.test(noCfg), '来源为空时不渲染 null');

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
