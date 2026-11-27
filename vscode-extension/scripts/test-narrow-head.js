/**
 * 窄窗口下「导出 CSV」按钮是否仍在可视区内的量化检查。
 *
 * 为什么不用 --window-size 判定：
 *   Chrome 的 --dump-dom 模式和 --screenshot 模式都有最小视口限制（实测约 500px），
 *   传 --window-size=380 实际拿到的 innerWidth 仍是 500，
 *   于是「380px 下按钮可见」会是个假结论（这个坑踩过一次）。
 *   正确做法是用 DevTools Protocol 的 Emulation.setDeviceMetricsOverride 强制视口，
 *   它没有最小宽度限制。
 *
 * 检查项：
 *   1. 结果头里的「导出 CSV」按钮左右边界都在视口内
 *   2. .result 的横向滚动只发生在表格上（说明头部没被表格撑宽）
 *
 * 用法：node scripts/test-narrow-head.js [width...]
 * 默认跑 380 / 520 / 760 / 1100 四档。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const EXT_ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8952;
const DEBUG_PORT = 9333;

const DATA = {
  profiles: {
    type: 'profiles',
    profiles: [{ name: '138', host: 'iris.example.com', port: 52773, protocol: 'http', user: '_SYSTEM', namespace: 'APP', description: 'HIS 测试库', origin: 'vscode' }],
    default: '138',
    configPath: 'C:/x.json',
    state: {},
  },
  ns: { type: 'namespaces', profile: '138', namespaces: ['APP'], current: 'APP' },
  res: {
    type: 'result',
    result: {
      kind: 'table',
      title: 'SQLUser.ARC_Alias',
      subtitle: '5 列',
      headers: ['列名', '类型', '主键', '说明', 'Global 位置'],
      rows: [
        ['A', 'numeric', 'PK', 'x', '$P(^A("B",C))'],
        ['B', '%String(60)', '', '别名描述', '$P(^A("B",C),"^",2)'],
      ],
      meta: { indexes: [{ name: 'AliasIdx', structure: 'On ARCIM_Alias [ Unique ]' }] },
    },
    elapsed: 412,
    target: { profile: '138', host: 'iris.example.com', port: 52773, namespace: 'APP' },
  },
};

// ---------------------------------------------------------------- 页面
const baseHtml = fs.readFileSync(path.join(EXT_ROOT, 'panel-real.html'), 'utf8');
const nonce = (baseHtml.match(/nonce-([A-Za-z0-9]+)/) || [])[1] || '';

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
  window.__measure = function () {
    var btn = document.querySelector('.result-actions button');
    var head = document.querySelector('.result-head');
    var res = document.getElementById('result');
    var r = btn ? btn.getBoundingClientRect() : null;
    var hr = head ? head.getBoundingClientRect() : null;
    return {
      vw: window.innerWidth,
      btnFound: !!btn,
      btnLeft: r ? Math.round(r.left) : null,
      btnRight: r ? Math.round(r.right) : null,
      headWidth: hr ? Math.round(hr.width) : null,
      resScroll: res ? res.scrollWidth : null,
      resClient: res ? res.clientWidth : null,
    };
  };
}());
</script>`;

const tailInject = `<script nonce="${nonce}">
(function () {
  var n = 0;
  var t = setInterval(function () {
    if (!window.__sent.length) {
      if (++n > 800) clearInterval(t);
      return;
    }
    clearInterval(t);
    document.body.classList.add('vscode-dark');
    var D = window.__DATA;
    window.__host.send(D.profiles);
    window.__host.send(D.ns);
    window.__host.send(D.res);
    window.__ready = true;
  }, 10);
}());
</script>`;

const pagePath = path.join(EXT_ROOT, '.narrow-head.html');
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

// ---------------------------------------------------------------- 最小 CDP 客户端
const request = (url) => fetch(url).then((r) => r.json());

async function waitForDevtools(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await request(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('DevTools 端口未就绪');
}

/** 极简 CDP：Node 22 自带 WebSocket，不需要第三方包 */
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

// ---------------------------------------------------------------- 主流程
(async () => {
  const widths = process.argv.slice(2).map(Number).filter((n) => n > 0);
  const targets = widths.length ? widths : [380, 520, 760, 1100];

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${path.join(EXT_ROOT, '.cdp-profile')}`,
      '--no-first-run',
      '--no-default-browser-check',
      `http://127.0.0.1:${PORT}/.narrow-head.html`,
    ],
    { stdio: 'ignore' }
  );

  let bad = 0;
  try {
    const wsUrl = await waitForDevtools();
    const client = await cdp(wsUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    // 等 panel.js 就绪并渲染完
    for (let i = 0; i < 60; i++) {
      const r = await client.send('Runtime.evaluate', { expression: '!!window.__ready', returnByValue: true });
      if (r.result?.value) break;
      await new Promise((r2) => setTimeout(r2, 200));
    }

    console.log('\n宽度     视口   按钮左  按钮右  头部宽  结果区(可见/内容)  结论');
    for (const w of targets) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: 760,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await new Promise((r) => setTimeout(r, 250));
      const res = await client.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__measure())', returnByValue: true });
      const m = JSON.parse(res.result.value);
      const visible = m.btnFound && m.btnLeft >= 0 && m.btnRight <= m.vw + 1;
      const headOk = m.headWidth <= m.vw + 1;
      const pass = visible && headOk;
      if (!pass) bad++;
      console.log(
        `${String(w).padEnd(8)} ${String(m.vw).padEnd(6)} ${String(m.btnLeft).padEnd(7)} ${String(m.btnRight).padEnd(7)} ${String(m.headWidth).padEnd(7)} ${String(m.resClient + '/' + m.resScroll).padEnd(18)} ${pass ? 'PASS' : 'FAIL'}`
      );
    }
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
      fs.rmSync(path.join(EXT_ROOT, '.cdp-profile'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(bad ? `\nFAIL ${bad} 档不通过` : '\nPASS 各宽度下结果头均完整可见');
  process.exit(bad ? 1 : 0);
})();
