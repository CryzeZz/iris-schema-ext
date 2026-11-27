/**
 * 诊断：点「更多查询」三个点按钮，菜单到底有没有出来。
 *
 * 只做三件事：
 *   1) 打开面板页，等 JS 跑完
 *   2) 点 #moreBtn，记录 #moreMenu 的 computed display / opacity / 尺寸
 *   3) 再点一次，确认能收起
 *
 * 输出每一项的实测值，不猜。用法：node scripts/probe-more-menu.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXT_ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8943;
const DEBUG_PORT = 9341;
const PAGE = 'probe-more.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// 深色主题变量：只为让布局接近真实，不影响菜单逻辑
const DARK_VARS = {
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-sideBar-background': '#252526',
  '--vscode-editorWidget-background': '#252526',
  '--vscode-panel-border': '#3c3c3c',
  '--vscode-button-background': '#0e639c',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-focusBorder': '#007fd4',
  '--vscode-input-background': '#3c3c3c',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-menu-background': '#252526',
  '--vscode-menu-foreground': '#cccccc',
  '--vscode-menu-selectionBackground': '#094771',
  '--vscode-menu-selectionForeground': '#ffffff',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-scrollbarSlider-background': '#79797966',
  '--vscode-badge-background': '#4d4d4d',
  '--vscode-badge-foreground': '#ffffff',
  '--vscode-textCodeBlock-background': '#2d2d2d',
};

function buildPage() {
  const css = fs.readFileSync(path.join(EXT_ROOT, 'media/panel.css'), 'utf8');
  const js = fs.readFileSync(path.join(EXT_ROOT, 'media/panel.js'), 'utf8');
  const vars = Object.entries(DARK_VARS)
    .map(([k, v]) => `    ${k}: ${v};`)
    .join('\n');

  // 复用 src/panel.ts 里的 header 结构，裁到工具条部分
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html {
${vars}
  }
  ${css}
</style>
</head>
<body class="vscode-dark">
  <header class="toolbar">
    <div class="seg" id="modeSeg">
      <button class="seg-btn active" data-mode="describe">表结构</button>
      <button class="seg-btn" data-mode="udl">类定义</button>
      <button class="seg-btn" data-mode="er">ER 图</button>
      <button class="seg-btn" data-mode="sample">数据</button>
    </div>
    <select id="profileSel" title="服务器"></select>
    <select id="nsSel" title="命名空间"></select>
    <input id="keyword" type="text" placeholder="表名 / 类名" spellcheck="false" />
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
    <textarea id="sqlInput" rows="4" spellcheck="false"></textarea>
    <div class="sqlbar-actions">
      <button id="sqlRun" class="primary">执行</button>
      <button id="sqlClose">收起</button>
    </div>
  </div>
  <div id="statusBar" class="statusline"><span id="elapsed"></span></div>
  <main class="result" id="result"></main>
  <div id="toast" class="toast hidden"></div>
<script>
  // 假 vscode API，只吞掉 postMessage
  window.acquireVsCodeApi = function () {
    return { postMessage: function (m) { (window.__sent = window.__sent || []).push(m); },
             getState: function () { return null; },
             setState: function () {} };
  };
  ${js}
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '/' + PAGE) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildPage());
    return;
  }
  const file = path.join(EXT_ROOT, url.replace(/^\/+/, ''));
  if (!file.startsWith(EXT_ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// ---------------------------------------------------------------- CDP
function connect() {
  return new Promise((resolve, reject) => {
    const get = (p, cb) => http.get({ host: '127.0.0.1', port: DEBUG_PORT, path: p }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(JSON.parse(d)));
    }).on('error', reject);
    get('/json/list', (list) => {
      const page = list.find((t) => t.type === 'page');
      if (!page) return reject(new Error('没有可用的 page target'));
      resolve(page.webSocketDebuggerUrl);
    });
  });
}

function client(wsUrl) {
  return makeWS(wsUrl);
}

// 简易 WebSocket 客户端（避免装 ws 依赖）
function makeWS(url) {
  const net = require('net');
  const crypto = require('crypto');
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let handshook = false, buf = Buffer.alloc(0), id = 0;
    const pending = new Map();
    const api = {
      send(method, params) {
        return new Promise((res, rej) => {
          const msg = JSON.stringify({ id: ++id, method, params: params || {} });
          pending.set(id, { res, rej });
          sock.write(frame(msg));
        });
      },
      close() { try { sock.destroy(); } catch {} },
    };
    function frame(str) {
      const payload = Buffer.from(str);
      const mask = crypto.randomBytes(4);
      const len = payload.length;
      let header;
      if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
      else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
      header[0] = 0x81;
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      return Buffer.concat([header, mask, masked]);
    }
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        handshook = true;
        buf = buf.slice(idx + 4);
        resolve(api);
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 1) {
          const msg = JSON.parse(payload.toString());
          if (msg.id && pending.has(msg.id)) {
            const { res, rej } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
          }
        }
      }
    });
    sock.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在页面里测量菜单状态
const MEASURE = `(function () {
  var btn = document.getElementById('moreBtn');
  var menu = document.getElementById('moreMenu');
  if (!btn || !menu) return JSON.stringify({ error: '找不到 #moreBtn 或 #moreMenu' });
  var cs = getComputedStyle(menu);
  var bcs = getComputedStyle(btn);
  var r = menu.getBoundingClientRect();
  var br = btn.getBoundingClientRect();
  // 菜单的 offsetParent 决定了它按谁定位：应该是 moreBtn 本身
  var op = menu.offsetParent;
  return JSON.stringify({
    btn: { w: Math.round(br.width), h: Math.round(br.height), x: Math.round(br.x), y: Math.round(br.y) },
    btnPosition: bcs.position,
    btnOffsetParent: op ? (op.id || op.className || op.tagName) : 'null',
    menuClass: menu.className,
    display: cs.display,
    top: cs.top,
    right: cs.right,
    position: cs.position,
    zIndex: cs.zIndex,
    rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    hitAtBtnCenter: (function () {
      var e = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
      return e ? (e.id || e.tagName + '.' + e.className) : 'null';
    })()
  });
})()`;

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const profile = path.join(EXT_ROOT, '.cdp-probe-more');
  const chrome = execFile(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1100,700',
    `http://127.0.0.1:${PORT}/${PAGE}`,
  ], () => {});

  try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try { wsUrl = await connect(); } catch {}
    }
    if (!wsUrl) throw new Error('连不上 Chrome 调试端口');

    const c = await makeWS(wsUrl);
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await sleep(1200);

    const evalJS = async (expr) => {
      const res = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return res.result && res.result.value;
    };

    console.log('=== 1. 初始状态（应隐藏）===');
    console.log(JSON.parse(await evalJS(MEASURE)));

    console.log('\n=== 2. 点击 #moreBtn 之后 ===');
    // 用 JS 直接 click()，绕开坐标命中问题，先确认逻辑本身
    await evalJS("document.getElementById('moreBtn').click()");
    await sleep(300);
    console.log(JSON.parse(await evalJS(MEASURE)));

    console.log('\n=== 2b. 窄屏 380px ===');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 600, deviceScaleFactor: 1, mobile: false });
    await evalJS("document.getElementById('moreMenu').classList.remove('hidden')");
    await sleep(250);
    const narrow = JSON.parse(await evalJS(MEASURE));
    console.log({
      btn: narrow.btn,
      menu: narrow.rect,
      viewport: narrow.viewport,
      菜单在视口内: narrow.rect.y + narrow.rect.h <= narrow.viewport.h,
    });
    await c.send('Emulation.clearDeviceMetricsOverride');
    await evalJS("document.getElementById('moreMenu').classList.add('hidden')");
    await sleep(150);

    console.log('\n=== 3. 真实鼠标点击（CDP 派发，带坐标）===');
    // 先收起，再用真实鼠标事件点一次
    await evalJS("document.getElementById('moreMenu').classList.add('hidden')");
    await sleep(100);
    const pos = JSON.parse(await evalJS(MEASURE)).btn;
    const cx = pos.x + pos.w / 2, cy = pos.y + pos.h / 2;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', {
        type, x: cx, y: cy, button: 'left', clickCount: 1,
      });
    }
    await sleep(300);
    const after = JSON.parse(await evalJS(MEASURE));
    console.log(after);

    console.log('\n=== 4. 结论 ===');
    const visible = after.display !== 'none';
    console.log('菜单可见:', visible ? '是' : '否');
    console.log('按钮中心命中元素:', after.hitAtBtnCenter);
    if (!visible) {
      console.log('↑ 点击没让菜单出来。若 hitAtBtnCenter 不是 moreBtn，说明按钮被别的元素盖住了。');
    }

    c.close();
  } catch (e) {
    console.error('失败:', e.message);
  } finally {
    chrome.kill();
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(0);
  }
})();
