// 探针：测试 IRIS Web 网关对并发的容忍度（只使用确定存在的类名）
const path = require('path');
const os = require('os');
const fs = require('fs');
const C = require(path.join(__dirname, '..', 'out', 'irisClient.js'));

function loadCfg(name) {
  const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.iris-schema.json'), 'utf8'));
  const conns = data.connections || data;
  const key = name || data.default || Object.keys(conns)[0];
  const raw = conns[key];
  return {
    profile: key,
    host: raw.host,
    namespace: raw.namespace,
    user: raw.user,
    password: raw.password,
    protocol: raw.protocol || 'https',
    web_port: raw.web_port,
    verify_ssl: raw.verify_ssl !== false,
  };
}

(async () => {
  const cfg = loadCfg(process.argv[2]);
  console.log('profile:', cfg.profile, cfg.host + ':' + cfg.web_port, cfg.namespace);

  // 先列出 SQLUser 下真实存在的类
  const rows = await C.postQuery(cfg,
    "SELECT ID FROM %Dictionary.ClassDefinition WHERE ID %STARTSWITH 'User.' ORDER BY ID", 30000);
  const all = rows.rows.map((r) => String(r[0]));
  console.log('User.* 类总数:', all.length, '前 8 个:', all.slice(0, 8).join(', '));

  const pool = all.filter((n) => /Mast|Adm|Order|Alias/i.test(n)).slice(0, 12);
  const classes = (pool.length >= 8 ? pool : all).slice(0, 8);
  console.log('测试用类:', classes.join(', '));

  const errOf = (e) => String(e.message || e).replace(/\s+/g, ' ').slice(0, 100);

  async function trial(label, n) {
    const t0 = Date.now();
    const rs = await Promise.allSettled(classes.slice(0, n).map((c) => C.fetchClassUdl(cfg, c, false)));
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    const errs = rs.filter((r) => r.status === 'rejected').map((r) => errOf(r.reason));
    const ms = Date.now() - t0;
    console.log('  ' + label + ' n=' + n + ': ok=' + ok + ' 耗时=' + ms + 'ms' + (errs.length ? '  err[0]=' + errs[0] : ''));
  }

  async function serial(n) {
    const t0 = Date.now();
    let ok = 0;
    let firstErr = '';
    for (const c of classes.slice(0, n)) {
      try { await C.fetchClassUdl(cfg, c, false); ok++; }
      catch (e) { if (!firstErr) firstErr = errOf(e); }
    }
    const ms = Date.now() - t0;
    console.log('  serial n=' + n + ': ok=' + ok + ' 耗时=' + ms + 'ms' + (firstErr ? '  err[0]=' + firstErr : ''));
  }

  for (const n of [2, 4, 8]) { C.resetSessions(); await trial('并发', n); }
  for (const n of [4, 8]) { C.resetSessions(); await serial(n); }

  await C.logout(cfg);
  console.log('已注销');
})().catch((e) => { console.error('FATAL', e.message || e); process.exit(1); });
