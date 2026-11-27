/**
 * ER 图渲染验证：用本地 mermaid.min.js 渲染真实 ER 数据，截图确认离线可用。
 * 用法：node scripts/probe-er-render.js [profile]
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const ops = require(path.join(__dirname, '..', 'out', 'ops.js'));
const C = require(path.join(__dirname, '..', 'out', 'irisClient.js'));

function loadCfg(name) {
  const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.iris-schema.json'), 'utf8'));
  const conns = data.connections || data;
  const key = name || data.default || Object.keys(conns)[0];
  const raw = conns[key];
  return {
    profile: key, host: raw.host, namespace: raw.namespace, user: raw.user, password: raw.password,
    protocol: raw.protocol || 'https', web_port: raw.web_port, verify_ssl: raw.verify_ssl !== false,
  };
}

(async () => {
  const cfg = loadCfg(process.argv[2]);
  const table = process.argv[3] || 'SQLUser.ARC_Alias';
  const res = await ops.execute(cfg, { op: 'er', table });
  await C.logout(cfg);

  const lines = res.mermaid.split('\n');
  const diagram = lines.filter((l) => !l.trim().startsWith('--')).join('\n');
  const notes = lines.filter((l) => l.trim().startsWith('--')).map((l) => l.replace(/^\s*--\s?/, ''));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background:#fff; color:#1f2328; margin:0; padding:24px; }
  h1 { font-size:17px; margin:0 0 4px; font-weight:600; }
  .sub { font-size:12px; color:#6e7781; margin-bottom:16px; }
  .card { border:1px solid #d0d7de; border-radius:8px; padding:16px; background:#fff; overflow:auto; }
  #diagram { text-align:center; }
  h3 { font-size:13px; margin:18px 0 8px; color:#424a53; }
  pre { font-size:11.5px; line-height:1.6; background:#f6f8fa; border:1px solid #d0d7de; border-radius:6px; padding:10px; overflow:auto; margin:0; }
  #err { color:#cf222e; font-size:12px; padding:8px; background:#ffebe9; border-radius:6px; margin-bottom:12px; }
</style></head>
<body>
<h1>ER 图 — ${esc(table)}</h1>
<div class="sub">${esc(res.subtitle || '')}</div>
<div id="err"></div>
<div class="card"><div id="diagram">加载中…</div></div>
<h3>Global 位置</h3>
<pre>${esc(notes.join('\n'))}</pre>
<script src="./media/mermaid.min.js"></script>
<script>
// 同步执行即可：<script src> 已保证 mermaid 在上面的脚本执行前加载完毕
(function () {
  try {
    if (!window.mermaid) throw new Error('本地 mermaid.min.js 未加载');
    mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose', fontFamily: 'inherit' });
    var diagram = ${JSON.stringify(diagram)};
    mermaid.render('erm', diagram).then(function (out) {
      document.getElementById('diagram').innerHTML = out.svg;
      document.title = 'OK';
    }).catch(function (e) {
      document.getElementById('err').textContent = '渲染失败: ' + (e && e.message ? e.message : e);
      document.getElementById('diagram').innerHTML = '';
      document.title = 'FAIL';
    });
  } catch (e) {
    document.getElementById('err').textContent = '渲染失败: ' + (e && e.message ? e.message : e);
    document.getElementById('diagram').innerHTML = '';
    document.title = 'FAIL';
  }
})();
</script></body></html>`;

  const out = path.join(__dirname, '..', 'er-render-test.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('已生成', out);
  console.log('mermaid 行数', diagram.split('\n').length, '/ 注释', notes.length);
})().catch((e) => { console.error('FATAL', e.message || e); process.exit(1); });
