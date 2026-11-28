/**
 * 截「⋯」菜单展开的样子，确认「设置密码…」这一项的位置与文案。
 *
 * 为什么要单独截：菜单是绝对定位的浮层，e2e 只验证消息发出，
 * 看不出它有没有被裁掉、有没有超出面板边缘（面板很窄时最容易出问题）。
 *
 * 用法：node scripts/shot-more-menu.js [zh|en]
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile, execFileSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const LANG = (process.argv[2] || process.env.IRIS_TEST_LANG || 'zh-cn').startsWith('zh') ? 'zh-cn' : 'en';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

process.env.IRIS_TEST_LANG = LANG;
// 先渲染一份当前语言的 panel-real.html
execFileSync(process.execPath, [path.join(EXT_ROOT, 'scripts', 'render-panel.js')], {
  stdio: 'ignore',
  env: { ...process.env, IRIS_TEST_LANG: LANG },
});

const src = fs.readFileSync(path.join(EXT_ROOT, 'panel-real.html'), 'utf8');
const CSS = fs.readFileSync(path.join(EXT_ROOT, 'media', 'panel.css'), 'utf8');

// 只留工具栏：菜单在页面顶部，把结果区清空免得截一大堆空白
const trimmed = src.replace(
  /<main id="result" class="result">[\s\S]*?<\/main>/,
  '<main id="result" class="result"><div class="placeholder"><div class="ph-title">menu</div></div></main>'
);
// 载入后点开菜单。
// panel.js 里 moreBtn 的 click 处理器会 stopPropagation，而 document 上还有个
// 「点任意位置关闭菜单」的监听 —— 用 el.click() 合成的事件不走 stopPropagation，
// 会在同一轮被 document 关掉，截出来菜单是收起的。这里直接去掉 hidden 类。
//
// nonce 必须沿用页面自己那个：panel-real.html 的 CSP 是
// `script-src 'nonce-xxx'`，不带 nonce 的 <script> 会被浏览器直接拒绝执行，
// 表现就是「改了探针、截出来的图却一模一样」。
const nonceMatch = src.match(/<script nonce="([^"]+)"/);
const nonce = nonceMatch ? nonceMatch[1] : '';
const probe = `<script nonce="${nonce}">
document.addEventListener('DOMContentLoaded', function () {
  var m = document.getElementById('moreMenu');
  if (m) m.classList.remove('hidden');
});
</script>`;
const page = trimmed.replace('</body>', probe + '</body>');
const pagePath = path.join(EXT_ROOT, `.shot-menu-${LANG}.html`);
fs.writeFileSync(pagePath, page, 'utf8');

const server = http.createServer((req, res) => {
  const rel = req.url === '/' ? '' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = rel ? path.join(EXT_ROOT, rel) : pagePath;
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(file);
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    // 禁缓存：headless Chrome 会复用上一轮的渲染结果，改了页面却截出一模一样的图
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  });
  res.end(fs.readFileSync(file));
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const out = path.join(EXT_ROOT, 'screenshots', `more-menu-${LANG}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // 独立且每次都新建的 user-data-dir：不指定的话 Chrome 会去抢默认 profile 的
  // 单例锁，已在运行的 Chrome 会接管这次启动；复用旧目录又会命中磁盘缓存。
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `iris-menu-${LANG}-`));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-application-cache',
    '--incognito',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=3000',
    '--force-device-scale-factor=1',
    '--window-size=760,420',
    `--screenshot=${out}`,
    `http://127.0.0.1:${port}/${path.basename(pagePath)}`,
  ];
  // 用异步 execFile：sync 版本会把事件循环钉住，本地 HTTP 服务无法响应 Chrome 的请求，
  // Chrome 等页面等不到，于是整条流程互相卡死到超时。
  execFile(CHROME, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (err, _stdout, stderr) => {
    // Chrome 截图偶发非 0 退出码，不据此判失败，看文件有没有落地
    const ok = fs.existsSync(out) && fs.statSync(out).size > 1000;
    console.log(ok ? `已生成 ${out}（${fs.statSync(out).size} 字节）` : `截图失败：${err ? err.message : stderr}`);
    server.close();
    try {
      fs.unlinkSync(pagePath);
    } catch {
      /* ignore */
    }
    // 临时的 Chrome profile 目录有几十 MB（首次运行还会下模型、组件），不删就会
    // 在工作区里留一个隐藏目录。删不掉也不影响截图结果，Windows 上偶尔会被
    // 杀毒软件抓着手柄，所以只吞错不报。
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(ok ? 0 : 1);
  });
});
