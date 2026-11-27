/**
 * 窄视口下截表头：验证「列名 + 排序指示器 + 过滤输入框」三层结构
 * 在 380px 时不会把表头挤爆、也不会溢出单元格。
 *
 * 为什么要单独写：Chrome 的 --window-size 有 500px 下限，
 * 传 380 实际还是 500（踩过，会得到假通过的结果）。
 * 必须用 CDP 的 Emulation.setDeviceMetricsOverride 硬压视口。
 *
 * 用法：node scripts/shot-narrow-th.js
 * 产物：screenshots/narrow-th-380.png / narrow-th-520.png
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXT_ROOT = path.join(__dirname, '..');
const OUT = path.join(EXT_ROOT, 'screenshots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8941;
const DEBUG_PORT = 9339;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(EXT_ROOT, rel);
  if (!file.startsWith(EXT_ROOT)) return res.writeHead(403).end('forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end('nf: ' + rel);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  });
});

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(EXT_ROOT, '.theme-dark-table.html'))) {
    console.error('缺少 .theme-dark-table.html，请先运行 node scripts/shot-theme.js dark');
    process.exit(1);
  }
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'iris-shot-profile'),
    'about:blank',
  ], { stdio: 'ignore' });

  // 等 devtools 端口起来
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${DEBUG_PORT}/json/list`, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve(JSON.parse(b)));
        }).on('error', reject);
      });
      const page = list.find((t) => t.type === 'page');
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 端口还没起来 */ }
    await sleep(150);
  }
  if (!wsUrl) { chrome.kill(); server.close(); throw new Error('Chrome devtools 未就绪'); }

  const c = await cdp(wsUrl);
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/.theme-dark-table.html` });
  await sleep(2500);

  let bad = 0;
  for (const width of [380, 520]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height: 420, deviceScaleFactor: 1, mobile: false });
    await sleep(300);

    // 量三件事：表头是否溢出单元格、过滤框是否落在格内、行高是否合理
    const raw = await c.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(function () {
        var ths = document.querySelectorAll('th.sortable');
        var out = { vw: window.innerWidth, ths: [], overflow: 0 };
        [].forEach.call(ths, function (th) {
          var bar = th.querySelector('.th-bar');
          var inp = th.querySelector('.col-filter');
          var cr = th.getBoundingClientRect();
          var br = bar.getBoundingClientRect();
          var ir = inp.getBoundingClientRect();
          // 过滤框右边缘超出单元格右边缘 >= 2px 视为溢出
          if (ir.right - cr.right > 2 || ir.left - cr.left < -2) out.overflow++;
          out.ths.push({
            head: (bar.textContent || '').replace(/[▲▼]/g, ''),
            thW: Math.round(cr.width),
            barW: Math.round(br.width),
            inpW: Math.round(ir.width),
            inpRightOver: Math.round(ir.right - cr.right)
          });
        });
        return JSON.stringify(out);
      })()`,
    });
    const info = JSON.parse(raw.result.value);

    // 换个干净的视口再截（setDeviceMetricsOverride 后 height 也要给够）
    await c.send('Emulation.setDeviceMetricsOverride', { width, height: 380, deviceScaleFactor: 2, mobile: false });
    await sleep(250);
    const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const p = path.join(OUT, `narrow-th-${width}.png`);
    fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));

    const widest = info.ths.reduce((a, b) => (a.inpW > b.inpW ? a : b), info.ths[0] || {});
    console.log(
      `[${width}] 列数=${info.ths.length} 溢出=${info.overflow} 最宽过滤框=${widest.inpW}px「${widest.head}」 -> ${path.basename(p)}`
    );
    if (info.overflow > 0) bad++;
    if (!info.ths.length) bad++;
  }

  c.close();
  chrome.kill();
  await new Promise((r) => server.close(r));
  console.log(bad ? '\nFAIL 表头在窄视口下溢出' : '\nPASS 表头在窄视口下完整');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
