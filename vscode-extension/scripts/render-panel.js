/**
 * 用模拟的 vscode API 驱动 IrisPanel，导出真实的 webview HTML。
 *
 * 目的：在没有扩展宿主的情况下，验证 renderHtml 产出的页面（CSP、资源 URI、
 * 脚本注入）到底能不能正常跑起来。产出的 HTML 会把 vscode:// 资源 URI 替换成
 * 本地相对路径，便于直接用浏览器打开。
 *
 * 用法：node scripts/render-panel.js
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const EXT_ROOT = path.join(__dirname, '..');
const MEDIA = path.join(EXT_ROOT, 'media');

// ---- 模拟 vscode 模块 ----
class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, '/');
    this.scheme = 'file';
  }
  toString() {
    return 'file:///' + this.path.replace(/^\//, '');
  }
  static file(p) {
    return new Uri(p);
  }
  static joinPath(base, ...segs) {
    return new Uri(path.join(base.fsPath || base.path, ...segs));
  }
}

const fakeVscode = {
  Uri,
  ViewColumn: { Active: -1, Beside: -2 },
  window: {
    createWebviewPanel: () => {
      throw new Error('不应在渲染脚本里创建真实面板');
    },
    showSaveDialog: async () => undefined,
    showTextDocument: async () => undefined,
    showWarningMessage: () => undefined,
    showInformationMessage: () => undefined,
    activeColorTheme: { kind: 1 },
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_k, d) => d }),
    openTextDocument: async () => ({}),
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  env: { clipboard: { writeText: async () => undefined } },
  Disposable: class { dispose() {} },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-fake';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode-fake'] = { id: 'vscode-fake', filename: 'vscode-fake', loaded: true, exports: fakeVscode };

const { IrisPanel } = require(path.join(EXT_ROOT, 'out', 'panel.js'));

// ---- 构造一个最简 panel / ctx ----
const webview = {
  cspSource: 'vscode-resource:',
  asWebviewUri: (uri) => {
    // 真实环境是 https://file+.vscode-resource.vscode-cdn.net/...，
    // 这里换成本地相对路径，方便浏览器直接打开
    const rel = path.relative(EXT_ROOT, uri.fsPath).replace(/\\/g, '/');
    return { toString: () => './' + rel };
  },
  postMessage: (msg) => {
    console.log('[postMessage]', JSON.stringify(msg).slice(0, 160));
    return Promise.resolve(true);
  },
  onDidReceiveMessage: () => ({ dispose() {} }),
  html: '',
};

const panel = {
  webview,
  iconPath: undefined,
  onDidDispose: () => ({ dispose() {} }),
  reveal: () => undefined,
  dispose: () => undefined,
};

const ctx = { extensionUri: new Uri(EXT_ROOT), subscriptions: [] };

// 直接调 private 方法（编译后就是普通方法）
const inst = Object.create(IrisPanel.prototype);
inst.panel = panel;
inst.ctx = ctx;
const html = inst.renderHtml();

const outFile = path.join(EXT_ROOT, 'panel-real.html');
fs.writeFileSync(outFile, html, 'utf8');
console.log('已生成', outFile);
console.log('HTML 字节数', Buffer.byteLength(html));

// 关键检查
const checks = [
  ['CSP 含 script-src', /Content-Security-Policy/.test(html)],
  ['mermaid 脚本已注入', /<script[^>]+src="\.\/media\/mermaid\.min\.js"/.test(html)],
  ['panel.js 已内联', /acquireVsCodeApi/.test(html)],
  ['panel.css 已内联', /--vscode-editor-background|\.toolbar/.test(html)],
  ['无残留绝对路径', !/file:\/\/\/[A-Za-z]:/.test(html)],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(' ', ok ? 'PASS' : 'FAIL', name);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
