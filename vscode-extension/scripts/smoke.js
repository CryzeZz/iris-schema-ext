/**
 * 冒烟测试：不启动 VS Code，直接验证 Atelier 客户端与 UDL 解析。
 * 用法：node scripts/smoke.js [profile] [schema.table]
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const c = require('../out/irisClient.js');

const profileName = process.argv[2] || '138';
const target = process.argv[3] || '';

function loadProfile(name) {
  const p = path.join(os.homedir(), '.iris-schema.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const conns = data.connections || data;
  const raw = conns[name];
  if (!raw) throw new Error('profile not found: ' + name);
  return {
    host: raw.host,
    namespace: raw.namespace,
    user: raw.user,
    password: raw.password,
    protocol: raw.protocol || 'https',
    web_port: raw.web_port,
    verify_ssl: raw.verify_ssl !== false,
    web_path: raw.web_path || '',
  };
}

(async () => {
  const cfg = loadProfile(profileName);
  console.log('== 目标', cfg.protocol + '://' + cfg.host + ':' + cfg.web_port, cfg.namespace);

  const t0 = Date.now();
  const info = await c.serverInfo(cfg);
  console.log('== GetServer ok', Date.now() - t0 + 'ms, version =', info.version, ', namespaces =', (info.namespaces || []).length);
  console.log('   包含目标命名空间:', (info.namespaces || []).includes(cfg.namespace));
  console.log('   会话 cookies:', c.sessionCookieNames(cfg));

  const q = await c.postQuery(cfg, 'SELECT 1 AS OK');
  console.log('== SQL ok', JSON.stringify(q));

  if (target) {
    const [schema, table] = target.includes('.') ? target.split('.') : ['SQLUser', target];
    const t1 = Date.now();
    const sc = await c.parseClassSchema(cfg, schema, table);
    console.log('== describe', Date.now() - t1 + 'ms  类=' + sc.class + ' 存储=' + sc.storage + ' ref=' + sc.ref);
    console.log('   RowID 列:', sc.rowidName, ' 列数:', sc.rows.length);
    console.table(
      sc.rows.map((r) => ({
        col: r.col,
        field: r.name,
        prop: r.prop,
        type: r.length ? r.type + '(' + r.length + ')' : r.type,
        pk: r.pk,
        global: r.global,
      }))
    );
    console.log('   索引:', sc.indexes.rows.length, '条, notes:', sc.indexes.notes);
    for (const ix of sc.indexes.rows.slice(0, 6)) console.log('    ', ix.name, '=>', ix.structure);
    console.log('   外键:', sc.foreignKeys.length, ' 关系:', sc.relationships.length);

    const sample = await c.postQuery(cfg, `SELECT TOP 3 * FROM ${schema}.${table}`);
    console.log('== sample headers:', sample.headers.slice(0, 10).join(', '), ' rows:', sample.rows.length);
  }

  const ok = await c.logout(cfg);
  console.log('== logout:', ok, ' 剩余 cookies:', c.sessionCookieNames(cfg).length);
})().catch((e) => {
  console.error('!! 失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});
