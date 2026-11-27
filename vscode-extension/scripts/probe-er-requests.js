// 探针：统计 ER 图期间的真实网络请求（按 URL 归类），定位耗时来源
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');

// 在加载客户端之前挂钩，统计 http(s) 请求
const stats = new Map();
let seq = 0;
const recs = [];
function hook(mod, proto) {
  const orig = mod.request;
  mod.request = function (opts, cb) {
    const url = (typeof opts === 'string' ? opts : (proto === 'https' ? 'https://' : 'http://') +
      (opts.hostname || opts.host) + ':' + (opts.port || '') + (opts.path || '/'));
    const key = url.replace(/\?.*$/, '').replace(/\/v1\/[^/]+\//, '/v1/<ns>/');
    const id = ++seq;
    const t0 = Date.now();
    const req = orig.call(this, opts, (res) => {
      res.on('end', () => {
        recs.push({ id, key, ms: Date.now() - t0, status: res.statusCode });
        stats.set(key, (stats.get(key) || 0) + 1);
      });
      if (cb) cb(res);
    });
    return req;
  };
}
hook(http, 'http');
hook(https, 'https');

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
  C.resetSessions();
  const t0 = Date.now();
  const er = await ops.execute(cfg, { op: 'er', table: 'SQLUser.ARC_Alias' });
  const ms = Date.now() - t0;
  console.log('er 总耗时', ms + 'ms  mermaid=' + er.mermaid.split('\n').length + '行');
  console.log('请求总数', recs.length);
  console.log('\n按路径归类（次数 / 总耗时 / 平均）:');
  const byKey = new Map();
  for (const r of recs) {
    const a = byKey.get(r.key) || { n: 0, ms: 0 };
    a.n++; a.ms += r.ms;
    byKey.set(r.key, a);
  }
  [...byKey.entries()].sort((a, b) => b[1].ms - a[1].ms).forEach(([k, v]) => {
    console.log('  ' + String(v.n).padStart(3) + 'x  ' + String(v.ms + 'ms').padStart(8) + '  avg ' + String(Math.round(v.ms / v.n) + 'ms').padStart(6) + '  ' + k);
  });
  console.log('\n最慢的 8 个请求:');
  recs.slice().sort((a, b) => b.ms - a.ms).slice(0, 8).forEach((r) => {
    console.log('  ' + String(r.ms + 'ms').padStart(7) + '  ' + r.status + '  ' + r.key);
  });
  await C.logout(cfg);
})().catch((e) => { console.error('FATAL', e.message || e); process.exit(1); });
