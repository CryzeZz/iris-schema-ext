/**
 * 本地预览：用真实数据渲染面板 UI，验证布局与样式。
 * 生成 preview.html，用浏览器打开即可。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const c = require('../out/irisClient.js');
const ops = require('../out/ops.js');

const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.iris-schema.json'), 'utf8'));
const conns = data.connections || data;

function cfgOf(name) {
  const raw = conns[name];
  return {
    host: raw.host,
    namespace: raw.namespace,
    user: raw.user,
    password: raw.password,
    protocol: raw.protocol || 'https',
    web_port: raw.web_port,
    verify_ssl: raw.verify_ssl !== false,
  };
}

const profileList = Object.entries(conns).map(([name, raw]) => ({
  name,
  host: raw.host,
  port: raw.web_port,
  protocol: raw.protocol || 'https',
  user: raw.user,
  namespace: raw.namespace,
  description: raw.description || '',
}));

(async () => {
  const pname = data.default || Object.keys(conns)[0];
  const cfg = cfgOf(pname);

  console.log('拉取真实数据…');
  const describe = await ops.execute(cfg, { op: 'describe', table: 'SQLUser.ARC_Alias' });
  const tables = await ops.execute(cfg, { op: 'tables', keyword: '', limit: 40 });
  const er = await ops.execute(cfg, { op: 'er', table: 'SQLUser.ARC_Alias' });
  const nsList = await c.namespaces(cfg);
  await c.logout(cfg);

  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');

  // 构造一个假的 acquireVsCodeApi，把真实数据喂给面板脚本
  const payload = {
    profiles: profileList,
    default: pname,
    configPath: path.join(os.homedir(), '.iris-schema.json'),
    state: { profile: pname, namespace: cfg.namespace, mode: 'describe', keyword: 'SQLUser.ARC_Alias' },
    namespaces: nsList,
    current: cfg.namespace,
    describe,
    tables,
    er,
  };

  const shim = `
    (function () {
      const data = ${JSON.stringify(payload)};
      let state = {};
      window.__sent = [];
      window.acquireVsCodeApi = function () {
        return {
          postMessage(msg) {
            window.__sent.push(msg);
            if (msg.type === 'ready') {
              setTimeout(() => feed('profiles', {
                profiles: data.profiles, default: data.default, configPath: data.configPath, state: data.state
              }), 10);
            }
            if (msg.type === 'loadNamespaces') {
              setTimeout(() => feed('namespaces', {
                profile: msg.profile, namespaces: data.namespaces, current: data.current
              }), 10);
            }
            if (msg.type === 'query') {
              const which = msg.mode === 'tables' ? 'tables' : msg.mode === 'er' ? 'er' : 'describe';
              setTimeout(() => feed('result', {
                result: data[which],
                elapsed: 412,
                target: { profile: msg.profile, namespace: msg.namespace, host: '10.0.0.138', port: 52773 }
              }), 60);
            }
          },
          getState() { return state; },
          setState(s) { state = s; }
        };
      };
      function feed(type, body) {
        window.postMessage(Object.assign({ type: type }, body), '*');
      }
      // 自动演示：先表结构，再表清单
      window.__demo = function (mode) {
        window.__sent.push({ type: 'query', mode: mode, profile: data.default, namespace: data.current, keyword: mode === 'tables' ? '' : 'SQLUser.ARC_Alias' });
        const which = mode === 'tables' ? 'tables' : mode === 'er' ? 'er' : 'describe';
        feed('result', { result: data[which], elapsed: 412, target: { profile: data.default, namespace: data.current, host: '10.0.0.138', port: 52773 } });
      };
    })();
  `;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>iris schema — 预览</title>
<style>
  /* 模拟 VS Code 浅色主题变量 */
  body.vscode-light {
    --vscode-foreground: #3b3b3b;
    --vscode-editor-background: #ffffff;
    --vscode-descriptionForeground: #717171;
    --vscode-button-background: #005fb8;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #0258a8;
    --vscode-input-background: #ffffff;
    --vscode-input-foreground: #3b3b3b;
    --vscode-input-border: #cecece;
    --vscode-focusBorder: #005fb8;
    --vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.12);
    --vscode-editorWidget-background: #f8f8f8;
    --vscode-list-hoverBackground: rgba(90, 93, 94, 0.08);
    --vscode-menu-background: #ffffff;
    --vscode-menu-selectionBackground: #005fb8;
    --vscode-menu-selectionForeground: #ffffff;
    --vscode-panel-border: rgba(128, 128, 128, 0.25);
    --vscode-charts-orange: #d18616;
    --vscode-errorForeground: #e51400;
    --vscode-textLink-foreground: #005fb8;
    --vscode-editor-font-family: Consolas, "Courier New", monospace;
    --vscode-disabledForeground: #a0a0a0;
    --vscode-editor-foreground: #3b3b3b;
    --vscode-notifications-background: #f8f8f8;
    --vscode-notifications-foreground: #3b3b3b;
  }
</style>
<style>${css}</style>
</head>
<body class="vscode-light">
<div id="app">
  <header class="toolbar">
    <div class="seg" id="modeSeg" role="tablist">
      <button class="seg-btn active" data-mode="describe">表结构</button>
      <button class="seg-btn" data-mode="udl">类定义</button>
      <button class="seg-btn" data-mode="er">ER 图</button>
      <button class="seg-btn" data-mode="sample">数据</button>
    </div>
    <select id="profileSel" title="服务器"></select>
    <select id="nsSel" title="命名空间"></select>
    <input id="keyword" type="text" placeholder="表名 / 类名，如 SQLUser.Patient" spellcheck="false" />
    <button id="queryBtn" class="primary">查询</button>
    <button id="moreBtn" class="icon" title="更多查询">⋯</button>
    <div id="moreMenu" class="menu hidden">
      <button data-mode="tables">列出全部表</button>
      <button data-mode="findColumn">按列名找表</button>
      <button data-mode="ddl">生成建表 DDL</button>
      <button data-mode="sql">自由 SQL</button>
      <button data-mode="test">测试连接</button>
    </div>
  </header>
  <div id="sqlBar" class="sqlbar hidden">
    <textarea id="sqlInput" rows="4" spellcheck="false" placeholder="-- 仅支持 SELECT / WITH 只读查询"></textarea>
    <div class="sqlbar-actions">
      <button id="sqlRun" class="primary">执行</button>
      <button id="sqlClose">收起</button>
    </div>
  </div>
  <div id="statusbar" class="statusbar">
    <span id="targetInfo" class="muted">—</span>
    <span id="elapsed" class="muted"></span>
  </div>
  <main id="result" class="result">
    <div class="placeholder">
      <div class="ph-title">结果</div>
      <div class="ph-sub">选择服务器与命名空间，填入表名后点击「查询」</div>
    </div>
  </main>
  <div id="toast" class="toast hidden"></div>
  <div id="loading" class="loading hidden"><div class="spinner"></div><span>查询中…</span></div>
</div>
<script>${shim}</script>
<script>${appJs}</script>
<script>
  // 按 URL 参数决定初始视图：?view=tables / er / empty / describe
  (function () {
    var view = (location.search.match(/view=(\w+)/) || [])[1] || 'describe';
    if (view === 'empty') return;
    if (view === 'tables') {
      setTimeout(function () { window.__demo('tables'); }, 120);
      return;
    }
    if (view === 'er') {
      setTimeout(function () { window.__demo('er'); }, 120);
      return;
    }
    setTimeout(function () {
      document.getElementById('keyword').value = 'SQLUser.ARC_Alias';
      window.__demo('describe');
    }, 120);
  })();
</script>
</body>
</html>`;

  const out = path.join(__dirname, '..', 'preview.html');
  fs.writeFileSync(out, html, 'utf8');
  // 同时输出四种视图的独立文件（无头 Chrome 对 file:// 的 query 参数支持不稳定）
  const views = {
    'preview-describe.html': 'describe',
    'preview-tables.html': 'tables',
    'preview-er.html': 'er',
    'preview-empty.html': 'empty',
  };
  for (const [file, view] of Object.entries(views)) {
    const v = html.replace(/var view = \(location\.search[^;]+;/, `var view = '${view}';`);
    fs.writeFileSync(path.join(__dirname, '..', file), v, 'utf8');
  }
  console.log('已生成', out, '及 4 个分视图文件');
  console.log('  表结构行数:', describe.rows.length, ' 表清单行数:', tables.rows.length, ' ER 行数:', er.mermaid.split('\n').length);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
