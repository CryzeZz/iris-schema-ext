// 探针：打印 ER 期间实际发送的 SQL 语句（去重后按次数排序）
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');

const sqls = [];
function hook(mod) {
  const orig = mod.request;
  mod.request = function (opts, cb) {
    return orig.call(this, opts, (res) => {
      if (res.statusCode === 200 && /action\/query/.test(opts.path || '')) {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.on('end', () => {
          try { sqls.push(JSON.parse(buf).result?.content?.query || JSON.parse(buf)?.params?.[0]?.query || '?'); }
          catch { sqls.push('?'); }
        });
      }
      if (cb) cb(res);
    });
  };
}
hook(http); hook(https);

// 请求体的 SQL 拿不到（在 write 里），补充 hook write
const origW = http.ClientRequest.prototype.write;
const origE = http.ClientRequest.prototype.end;

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
  // 直接包一层 postQuery 统计
  const orig = C.postQuery;
  const calls = [];
  C.postQuery = async function (c, q, t) {
    const t0 = Date.now();
    try { return await orig.call(this, c, q, t); }
    finally { calls.push({ q, ms: Date.now() - t0 }); }
  };

  const t0 = Date.now();
  await ops.execute(cfg, { op: 'er', table: 'SQLUser.ARC_Alias' });
  console.log('er 总耗时', Date.now() - t0 + 'ms');
  console.log('SQL 调用', calls.length, '次，累计', calls.reduce((a, b) => a + b.ms, 0) + 'ms');
  console.log('\n去重后的 SQL（次数 / 累计耗时）:');
  const agg = new Map();
  for (const c of calls) {
    const a = agg.get(c.q) || { n: 0, ms: 0 };
    a.n++; a.ms += c.ms;
    agg.set(c.q, a);
  }
  [...agg.entries()].sort((a, b) => b[1].ms - a[1].ms).forEach(([q, v]) => {
    console.log('  ' + String(v.n).padStart(2) + 'x ' + String(v.ms + 'ms').padStart(7) + '  ' + q.replace(/\s+/g, ' ').slice(0, 150));
  });
  await C.logout(cfg);
})().catch((e) => { console.error('FATAL', e.message || e); process.exit(1); });
