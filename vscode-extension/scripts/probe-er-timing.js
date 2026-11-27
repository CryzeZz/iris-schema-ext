// 探针：拆解 ER 图各阶段耗时
const path = require('path');
const os = require('os');
const fs = require('fs');
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

const t = async (label, fn) => {
  const t0 = Date.now();
  const r = await fn();
  console.log('  ' + label.padEnd(26) + (Date.now() - t0) + 'ms');
  return r;
};

(async () => {
  const cfg = loadCfg(process.argv[2]);
  const schema = 'SQLUser';
  const table = 'ARC_Alias';

  console.log('冷启动（无缓存）');
  C.resetSessions();
  const r1 = await t('locate', () => ops.locate(cfg, `${schema}.${table}`));
  console.log('    -> cls =', r1.cls);
  const p1 = await t('parseClassSchema', () => C.parseClassSchema(cfg, schema, table, r1.cls));
  console.log('    -> 列数', p1.rows.length, '外键', p1.foreignKeys.length, '关系', p1.relationships.length);
  await t('describe(整体，命中缓存)', () => ops.execute(cfg, { op: 'describe', table: `${schema}.${table}` }));

  const t0 = Date.now();
  const er = await ops.execute(cfg, { op: 'er', table: `${schema}.${table}` });
  console.log('  er 总计'.padEnd(28) + (Date.now() - t0) + 'ms  mermaid=' + er.mermaid.split('\n').length + '行');

  console.log('\n再次（全命中缓存）');
  const t1 = Date.now();
  await ops.execute(cfg, { op: 'er', table: `${schema}.${table}` });
  console.log('  er 总计'.padEnd(28) + (Date.now() - t1) + 'ms');

  await C.logout(cfg);
})().catch((e) => { console.error('FATAL', e.message || e); process.exit(1); });
