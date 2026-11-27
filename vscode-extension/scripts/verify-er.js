/**
 * 回归：ER 图里的引用类型不能带点号。
 *
 * 起因（用户实测截图）：DHC_AntCVReport 的 DPRP_UserDR 类型是 User.SSUser，
 * 生成成了 `User.SSUser DPRP_UserDR`。mermaid 10.9.8 的 erDiagram 词法里
 * ATTRIBUTE_WORD 不认 `.`，整张图报：
 *   Parse error on line 8: ... DPRP_Time    User.SSUser DPRP_UserDR
 *   Expecting 'ATTRIBUTE_WORD', got '.'
 * 而界面把任何异常都吞成"可能是离线环境"，排查方向完全错了。
 *
 * 本脚本两层校验：
 *   1) 对真库跑 er，断言生成的 mermaid 实体块里没有裸点号；
 *   2) 把生成的 mermaid 丢给本地打包的 mermaid.min.js 真渲染（无头 Chrome），断言出 SVG。
 *
 * 用法：node scripts/verify-er.js [表名] [profile]
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const fake = { workspace: { getConfiguration: () => ({ get: (_k, d) => d, inspect: () => undefined }) } };
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'vscode') return 'vscode-fake';
  return orig.call(this, r, ...a);
};
require.cache['vscode-fake'] = { id: 'vscode-fake', filename: 'vscode-fake', loaded: true, exports: fake };

const ops = require(path.join(root, 'out/ops.js'));
const { loadProfiles, findProfile } = require(path.join(root, 'out/config.js'));

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let failed = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  PASS ' + msg);
  else {
    failed++;
    console.log('  FAIL ' + msg + (extra ? '  →  ' + extra : ''));
  }
};

(async () => {
  const target = process.argv[2] || 'DHC_AntCVReport';
  const pname = process.argv[3] || null;
  const src = loadProfiles();
  const prof = findProfile(src, pname);
  if (!prof) {
    console.log('没有可用连接，跳过');
    process.exit(0);
  }
  const cfg = { ...prof };
  delete cfg.profile;
  delete cfg.namespaceExplicit;
  delete cfg.origin;

  console.log(`\n--- 生成（真库 ${prof.profile} / ${target}）---`);
  const r = await ops.execute(cfg, { op: 'er', table: target });
  const mmd = r.mermaid;
  console.log(mmd.split('\n').slice(0, 14).join('\n'));

  // 实体块 = 缩进 4 空格的行（属性行）
  const bodyLines = mmd.split('\n').filter((l) => /^\s{4}\S/.test(l));
  const dotted = bodyLines.filter((l) => /\./.test(l));
  ok(!dotted.length, `属性行无点号（共 ${bodyLines.length} 行）`, dotted[0]);
  ok(/User_SSUser\s+DPRP_UserDR/.test(mmd), '引用类型被拍平为 User_SSUser');
  const aliases = (r.meta && r.meta.typeAliases) || {};
  ok(aliases['User_SSUser'] === 'User.SSUser', 'typeAliases 记下原名供 hover', JSON.stringify(aliases));

  // 真渲染
  const probe = path.join(root, '.er-verify.html');
  fs.writeFileSync(probe, renderProbe(mmd), 'utf8');
  console.log(`\n--- 真渲染（无头 Chrome + 本地 mermaid.min.js）---`);
  const { execFileSync } = require('child_process');
  let dom = '';
  try {
    dom = execFileSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--allow-file-access-from-files',
        '--virtual-time-budget=20000',
        '--dump-dom',
        'file:///' + probe.replace(/\\/g, '/'),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (e) {
    ok(false, 'Chrome 启动失败', e.message);
  }
  const m = dom.match(/<pre id="res">([\s\S]*?)<\/pre>/);
  const out = m ? m[1] : '(无结果)';
  ok(/^OK/.test(out), 'mermaid 渲染成功（按面板的过滤逻辑）', out.slice(0, 200));
  ok(/raw-fail/.test(out), '原文带注释直接喂 mermaid 会失败（证实过滤是必要的）', out.slice(0, 200));

  fs.unlinkSync(probe);
  if (failed) {
    console.log(`\n${failed} 项失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function renderProbe(raw) {
  // 必须复现 panel.js 的真实处理：把 `--` 注释行整行摘掉再交给 mermaid。
  // 直接喂原文会得到假失败（mermaid 不认 SQL 风格注释）。
  const clean = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8">
<script src="./media/mermaid.min.js"></script></head><body>
<script>
const keep = ${JSON.stringify(clean)};
const raw = ${JSON.stringify(raw)};
(async () => {
  let res;
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    // 两个都试：keep = 面板实际喂给 mermaid 的内容，raw = 原文（应报错，证明过滤是必要的）
    const out = await mermaid.render('v1', keep);
    let rawRes;
    try { await mermaid.render('v2', raw); rawRes = 'raw-ok'; }
    catch (e2) { rawRes = 'raw-fail'; }
    res = 'OK len=' + out.svg.length + ' ' + rawRes;
  } catch (e) { res = 'FAIL ' + (e && (e.message || String(e))); }
  const p = document.createElement('pre');
  p.id = 'res'; p.textContent = res;
  document.body.appendChild(p);
})();
</script></body></html>`;
}
