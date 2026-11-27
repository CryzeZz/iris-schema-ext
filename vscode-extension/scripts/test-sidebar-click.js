/**
 * 真浏览器点击验证：把侧边栏视图的 HTML 落到一个 .html 里，
 * 用无头 Chrome 打开、真的点一下「打开查询面板」，看 acquireVsCodeApi().postMessage
 * 有没有被调到。
 *
 * 为什么要真浏览器：node 里只能断言「HTML 里有按钮 + 有 onclick」，
 * 但 enableScripts / CSP 配置错时，脚本根本不会执行 —— 这是纯静态断言查不出的，
 * 也正是本次 bug 的成因（enableScripts:false 导致两个按钮全哑）。
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let failed = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  PASS ' + msg);
  else {
    failed++;
    console.log('  FAIL ' + msg + (extra ? '  →  ' + extra : ''));
  }
};

// 用假 vscode 拿 provider，再取到 HTML
const fakePath = path.join(root, '.fake-vscode-click.js');
fs.writeFileSync(
  fakePath,
  `global.__cmds=[];
   module.exports={
     window:{registerWebviewViewProvider:(id,p)=>{global.__prov=p;return{dispose(){}}}},
     commands:{registerCommand:()=>({dispose(){}}),executeCommand:(c)=>{global.__cmds.push(c);return Promise.resolve()}},
     workspace:{getConfiguration:()=>({get:(_k,d)=>d,inspect:()=>undefined})},
   };`,
  'utf8'
);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'vscode') return fakePath;
  return origResolve.call(this, r, ...a);
};
require(path.join(root, 'out', 'extension.js')).activate({ subscriptions: [], extensionUri: { fsPath: root } });
Module._resolveFilename = origResolve;
fs.unlinkSync(fakePath);

const cap = {};
global.__prov.resolveWebviewView({
  webview: {
    set options(v) {
      cap.options = v;
    },
    set html(v) {
      cap.html = v;
    },
    onDidReceiveMessage() {
      return { dispose() {} };
    },
  },
});

console.log('\n--- 真浏览器点击 ---');
ok(cap.options && cap.options.enableScripts === true, 'enableScripts 为 true', JSON.stringify(cap.options));

// 把 HTML 里的 acquireVsCodeApi 换成本地记录器，其余原样保留（含 CSP）
let html = cap.html.replace(
  'acquireVsCodeApi()',
  `({ postMessage: (m) => { window.__sent = window.__sent || []; window.__sent.push(m); }, getState: () => ({}), setState: () => {} })`
);

// 关键：VS Code 在 enableScripts:false 时会把 webview 的 sandbox 关掉，
// 表现等价于给 <head> 加一条 script-src 'none'。浏览器的 --dump-dom 不会因为
// options.enableScripts 变化而改变行为，所以必须显式模拟，否则这个测试
// 在 enableScripts:false 的 bug 版本上也会「通过」，等于没测。
if (!(cap.options && cap.options.enableScripts)) {
  html = html.replace(
    '</head>',
    `<meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head>`
  );
  console.log('  （模拟 enableScripts:false：注入 script-src none）');
}
const page = path.join(root, '.sidebar-click-test.html');
// 注入一个「点完把结果写进 DOM」的收尾脚本，放在原有脚本之后
const withProbe = html.replace(
  '</body>',
  `<script>
     window.addEventListener('load', () => {
       setTimeout(() => {
         const out = document.createElement('pre');
         out.id = 'probe';
         document.getElementById('open').click();
         document.getElementById('reload').click();
         out.textContent = JSON.stringify(window.__sent || []);
         document.body.appendChild(out);
       }, 0);
     });
   </script></body>`
);
fs.writeFileSync(page, withProbe, 'utf8');

let dom = '';
try {
  dom = execFileSync(
    CHROME,
    ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--virtual-time-budget=4000', '--dump-dom', 'file:///' + page.replace(/\\/g, '/')],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
} catch (e) {
  ok(false, 'Chrome 启动失败', e.message);
}

const m = dom.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
const sent = m ? m[1] : '';
ok(!!m, '页面加载并执行了脚本（拿得到探针结果）');
ok(/"type":"open"/.test(sent), '点「打开查询面板」发出了 open 消息', sent);
ok(/"type":"reload"/.test(sent), '点「重新加载连接配置」发出了 reload 消息', sent);

fs.unlinkSync(page);

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
