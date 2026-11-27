// 探针：把每个请求画成时间轴，判断 SQL 是否串行、串行在哪一段
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');

const T0 = Date.now();
const evts = [];
function hook(mod) {
  const orig = mod.request;
  mod.request = function (opts, cb) {
    const p = String(opts.path || '');
    const kind = /action\/query/.test(p) ? 'SQL' : /\/doc\//.test(p) ? 'UDL' : 'OTHER';
    const name = /action\/query/.test(p) ? 'action/query' : p.split('/').pop();
    const start = Date.now() - T0;
    evts.push({ kind, name, start, end: null });
    const e = evts[evts.length - 1];
    return orig.call(this, opts, (res) => {
      res.on('end', () => { e.end = Date.now() - T0; e.status = res.statusCode; });
      if (cb) cb(res);
    });
  };
}
hook(http); hook(https);

const C = require(path.join(__dirname, '..', 'out', 'irisClient.js'));
const ops = require(path.join(__dirname, '..', 'out', 'ops.js'));

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
  const total = Date.now();
  await ops.execute(cfg, { op: 'er', table: 'SQLUser.ARC_Alias' });
  console.log('er 总耗时', Date.now() - total + 'ms  请求数', evts.length);

  // 按开始时间排序，画成时间轴（每 100ms 一格）
  const span = Math.max(...evts.map((e) => e.end || e.start));
  const W = 60;
  const scale = span / W;
  console.log('\n时间轴（# = 进行中）:');
  evts.sort((a, b) => a.start - b.start).forEach((e) => {
    const s = Math.round(e.start / scale);
    const len = Math.max(1, Math.round(((e.end || span) - e.start) / scale));
    const bar = ' '.repeat(s) + '#'.repeat(len);
    console.log('  ' + (e.kind === 'SQL' ? 'SQL ' : e.kind === 'UDL' ? 'UDL ' : 'OTHR') +
      String(e.start).padStart(5) + 'ms +' + String((e.end || 0) - e.start).padStart(5) + 'ms  ' + bar);
  });

  // 关键指标：串行区段（没有并发的时间窗口）
  const sql = evts.filter((e) => e.kind === 'SQL').sort((a, b) => a.start - b.start);
  let serial = 0;
  for (let i = 1; i < sql.length; i++) serial += Math.max(0, sql[i].start - (sql[i - 1].end || sql[i - 1].start));
  console.log('\nSQL 首尾串行间隙累计:', serial + 'ms （若接近 SQL 总耗时，说明 SQL 是一条条串行发的）');
  await C.logout(cfg);
})().catch((e) => { console.error('FATAL', e.message || e); process.exit(1); });
