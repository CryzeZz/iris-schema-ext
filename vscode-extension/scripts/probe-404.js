// 探针：看「类不存在」时 Atelier 到底返回什么（状态码 + body），以及并发下是否稳定
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
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

  for (const cls of ['User.ARCAlias', 'User.NO_SUCH_CLASS_XYZ', 'User.PA_Adm']) {
    try {
      const lines = await C.fetchClassUdl(cfg, cls, false);
      console.log('[OK ]', cls, '->', lines.length, '行');
    } catch (e) {
      console.log('[ERR]', cls, '-> status=' + (e.status || '?'), '| body=', JSON.stringify(String(e.body || e.message).replace(/\s+/g, ' ').slice(0, 220)));
    }
  }

  // 并发 12 个真实类，重复 3 轮，确认稳定性
  const names = await C.postQuery(cfg,
    "SELECT TOP 12 ID FROM %Dictionary.ClassDefinition WHERE ID %STARTSWITH 'User.' AND ID %MATCHES '*Mast*' ORDER BY ID", 30000);
  const classes = names.rows.map((r) => String(r[0]));
  for (let round = 1; round <= 3; round++) {
    C.resetSessions();
    const t0 = Date.now();
    const rs = await Promise.allSettled(classes.map((c) => C.fetchClassUdl(cfg, c, false)));
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    const errs = rs.filter((r) => r.status === 'rejected').map((r) => (r.reason.status || '?') + ':' + String(r.reason.message).slice(0, 50));
    console.log('并发 n=' + classes.length + ' 第' + round + '轮: ok=' + ok + '/' + classes.length + ' 耗时=' + (Date.now() - t0) + 'ms' + (errs.length ? ' errs=' + errs.slice(0, 2).join(' ; ') : ''));
  }

  await C.logout(cfg);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
