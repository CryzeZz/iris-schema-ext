/**
 * 用无头 Chrome 打开 panel-real.html 并截图，验证：
 *   1. 页面结构与设计稿一致（工具条 + 结果占位）
 *   2. mermaid.min.js 在该 CSP 下能被加载（window.mermaid 存在）
 *   3. 控制台无 CSP 违规 / JS 错误
 *
 * 为什么要起本地 HTTP 服务：panel-real.html 里 mermaid 走相对路径 ./media/...，
 * 而 CSP 的 style-src/script-src 含 'vscode-resource:'。file:// 协议下 Chrome 的
 * 一些加载行为与 webview 差异较大，用 http 更接近真实宿主。
 *
 * 注意：探针页必须和 panel-real.html 放在同一目录，否则 ./media/ 相对路径会断。
 *
 * 用法：node scripts/shot-panel.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXT_ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(EXT_ROOT, 'screenshots');
const PORT = 8931;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const missing = [];

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let rel = url === '/' ? 'panel-real.html' : url.replace(/^\/+/, '');
  const file = path.join(EXT_ROOT, rel);
  // 防目录穿越
  if (!file.startsWith(EXT_ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      missing.push(rel);
      res.writeHead(404).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
});

function run(args) {
  return new Promise((resolve) => {
    execFile(CHROME, args, { timeout: 90000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // chrome 截图偶发非 0 退出码，这里不因退出码判定失败
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const panelPath = path.join(EXT_ROOT, 'panel-real.html');
  if (!fs.existsSync(panelPath)) {
    console.error('缺少 panel-real.html，请先运行 node scripts/render-panel.js');
    process.exit(1);
  }
  const panelHtml = fs.readFileSync(panelPath, 'utf8');

  // 探针页：与 panel-real.html 同目录，复用页面 nonce，在末尾追加状态探测
  const m = panelHtml.match(/nonce-([A-Za-z0-9]+)/);
  const nonce = m ? m[1] : '';
  const probePath = path.join(EXT_ROOT, '.panel-probe.html');
  const probeHtml = panelHtml.replace(
    '</body>',
    `<script nonce="${nonce}">
      window.__probe = {
        mermaidType: typeof window.mermaid,
        hasRender: !!(window.mermaid && typeof window.mermaid.render === 'function'),
        errs: window.__errs || [],
      };
      document.title = 'PROBE:' + JSON.stringify(window.__probe);
    </script></body>`
  );
  fs.writeFileSync(probePath, probeHtml, 'utf8');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`本地服务 http://127.0.0.1:${PORT}/`);

  // --- 1. 空态截图（1440x900，接近编辑器窗口） ---
  // 注意：--headless=new 下截图区域默认 800x600，需同时给 --window-size
  // 和 --force-device-scale-factor 才可靠；这里用 1 倍保证像素尺寸可控。
  const shot = path.join(OUT, 'panel-empty.png');
  await run([
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--virtual-time-budget=5000',
    '--force-device-scale-factor=1',
    '--window-size=1280,800',
    `--screenshot=${shot}`,
    `http://127.0.0.1:${PORT}/`,
  ]);
  const size1 = fs.existsSync(shot) ? fs.statSync(shot).size : 0;
  console.log(`空态截图 -> ${size1} 字节`);

  // --- 2. 探针：mermaid 是否挂到 window 上 + 收集控制台错误 ---
  const dom = await run([
    '--headless=new',
    '--disable-gpu',
    '--virtual-time-budget=6000',
    '--enable-logging=stderr',
    '--v=0',
    '--dump-dom',
    `http://127.0.0.1:${PORT}/.panel-probe.html`,
  ]);
  const titleMatch = dom.stdout.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1] : '(无 title)';
  console.log('探针结果:', title);

  const consoleErrs = dom.stderr
    .split(/\r?\n/)
    .filter((l) => /CONSOLE|Refused to|Content Security/i.test(l))
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim());
  if (consoleErrs.length) {
    console.log('控制台输出:');
    for (const l of consoleErrs.slice(0, 10)) console.log('   ', l);
  }

  await new Promise((r) => server.close(r));
  fs.unlinkSync(probePath);

  // 结论
  let ok = true;
  const expect = [
    ['空态截图有效（>8KB）', size1 > 8000],
    ['无 404 请求', missing.length === 0],
    ['mermaid 已挂载 window', /"mermaidType":"object"/.test(title)],
    ['mermaid.render 可用', /"hasRender":true/.test(title)],
    ['无 acquireVsCodeApi 报错', !consoleErrs.some((l) => /acquireVsCodeApi/.test(l))],
  ];
  for (const [name, pass] of expect) {
    console.log(' ', pass ? 'PASS' : 'FAIL', name);
    if (!pass) ok = false;
  }
  if (missing.length) console.log('  404:', missing.join(', '));
  process.exit(ok ? 0 : 1);
})();
