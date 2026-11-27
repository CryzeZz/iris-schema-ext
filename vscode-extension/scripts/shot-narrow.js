/**
 * 任意宽度截图（走 DevTools Protocol，能突破 Chrome 的 ~500px 最小视口）。
 *
 * 为什么不用 --window-size：
 *   --headless=new 的 --screenshot / --dump-dom 都有最小视口限制，
 *   传 --window-size=380 实际会拿到 500px 宽，截出来的图是 500px 而不是 380px。
 *   这个坑导致过一次误判（以为窄屏没问题）。
 *
 * 用法：node scripts/shot-narrow.js [width] [theme] [scene]
 *   theme: dark | light | hc   默认 dark
 *   scene: table | sql | error 默认 table
 * 产物：screenshots/narrow-<width>-<theme>-<scene>.png
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXT_ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(EXT_ROOT, 'screenshots');
const PORT = 8953;
const DEBUG_PORT = 9334;

const WIDTH = Number(process.argv[2] || 380);
const THEME = process.argv[3] || 'dark';
const SCENE = process.argv[4] || 'table';

const THEME_CLASS = { dark: 'vscode-dark', light: 'vscode-light', hc: 'vscode-high-contrast' };

const DATA = {
  profiles: {
    type: 'profiles',
    profiles: [
      { name: '138', host: 'iris.example.com', port: 52773, protocol: 'http', user: '_SYSTEM', namespace: 'APP', description: 'HIS 测试库', origin: 'vscode' },
    ],
    default: '138',
    configPath: 'C:/Users/zhang/.iris-schema.json',
    state: {},
  },
  ns: { type: 'namespaces', profile: '138', namespaces: ['APP', '%SYS'], current: 'APP' },
  table: {
    type: 'result',
    result: {
      kind: 'table',
      title: 'SQLUser.ARC_Alias',
      subtitle: '5 列',
      headers: ['列名', '类型', '主键', '说明', 'Global 位置'],
      rows: [
        ['ARCIM_RowId', 'numeric', 'PK', 'RowID', '$P(^ARC("ALIAS",ARCIM_RowId))'],
        ['ARCIM_Desc', '%String(60)', '', '别名描述', '$P(^ARC("ALIAS",ARCIM_RowId),"^",2)'],
      ],
      meta: { indexes: [{ name: 'AliasIdx', structure: 'On ARCIM_Alias [ Unique ]' }] },
    },
    elapsed: 412,
    target: { profile: '138', host: 'iris.example.com', port: 52773, namespace: 'APP' },
  },
  sql: {
    type: 'result',
    result: {
      kind: 'table',
      title: '自由 SQL 结果',
      headers: ['ARCIM_RowId', 'ARCIM_Desc'],
      rows: [
        [1, '门诊挂号'],
        [2, '住院登记'],
      ],
    },
    elapsed: 336,
    target: { profile: '138', host: 'iris.example.com', port: 52773, namespace: 'APP' },
  },
  error: {
    type: 'error',
    text: '未找到表 SQLUser.NotExists。',
    candidates: [{ schema: 'SQLUser', table: 'ARC_Alias' }],
  },
};

const baseHtml = fs.readFileSync(path.join(EXT_ROOT, 'panel-real.html'), 'utf8');
const nonce = (baseHtml.match(/nonce-([A-Za-z0-9]+)/) || [])[1] || '';
const wantSql = SCENE === 'sql';

const headInject = `<script nonce="${nonce}">
(function () {
  var st = {};
  window.__sent = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) { window.__sent.push(m); },
      getState: function () { return st; },
      setState: function (s) { for (var k in s) st[k] = s[k]; }
    };
  };
  window.__host = { send: function (m) { window.dispatchEvent(new MessageEvent('message', { data: m })); } };
  window.__DATA = ${JSON.stringify(DATA)};
}());
</script>`;

const tailInject = `<script nonce="${nonce}">
(function () {
  var n = 0;
  var t = setInterval(function () {
    if (!window.__sent.length) { if (++n > 800) clearInterval(t); return; }
    clearInterval(t);
    document.body.classList.add('${THEME_CLASS[THEME] || 'vscode-dark'}');
    var D = window.__DATA;
    window.__host.send(D.profiles);
    window.__host.send(D.ns);
    ${wantSql ? "document.getElementById('sqlBar').classList.remove('hidden');" : ''}
    window.__host.send(D['${SCENE}']);
    window.__ready = true;
  }, 10);
}());
</script>`;

const pagePath = path.join(EXT_ROOT, '.narrow-shot.html');
fs.writeFileSync(pagePath, baseHtml.replace('</head>', headInject + '\n</head>').replace('</body>', tailInject + '\n</body>'), 'utf8');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  fs.readFile(path.join(EXT_ROOT, rel), (err, buf) => {
    if (err) {
      res.writeHead(404).end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
    res.end(buf);
  });
});

async function waitForDevtools(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('DevTools 未就绪');
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { send, close: () => ws.close() };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = path.join(EXT_ROOT, '.cdp-profile-shot');
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      `http://127.0.0.1:${PORT}/.narrow-shot.html`,
    ],
    { stdio: 'ignore' }
  );

  try {
    const client = await cdp(await waitForDevtools());
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 760, deviceScaleFactor: 1, mobile: false });

    for (let i = 0; i < 80; i++) {
      const r = await client.send('Runtime.evaluate', { expression: '!!window.__ready', returnByValue: true });
      if (r.result?.value) break;
      await new Promise((r2) => setTimeout(r2, 200));
    }
    // 等布局稳定（mermaid / 表格列宽分配在下一帧完成）
    await new Promise((r) => setTimeout(r, 600));

    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `narrow-${WIDTH}-${THEME}-${SCENE}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`${WIDTH}px ${THEME}/${SCENE} -> ${fs.statSync(file).size} 字节  (${file})`);
    client.close();
  } finally {
    chrome.kill();
    await new Promise((r) => server.close(r));
    try {
      fs.unlinkSync(pagePath);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
})();
