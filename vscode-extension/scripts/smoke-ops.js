/**
 * 端到端验证所有 op：直接调 ops.execute，检查返回结构。
 *
 * 连接来自 config.js（与扩展运行时同一套加载逻辑，含
 * intersystems.servers 与 ~/.iris-schema.json 的合并），
 * 因此这个脚本同时验证了配置加载链路。
 *
 * 用法：node scripts/smoke-ops.js [profile]
 */
const path = require('path');
const Module = require('module');

const ops = require('../out/ops.js');
const c = require('../out/irisClient.js');

// config.js 顶部 require('vscode')，脚本里没有宿主，给个最小假实现
const fake = { workspace: { getConfiguration: () => ({ get: (_k, d) => d, inspect: () => undefined }) } };
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'vscode') return 'vscode-fake';
  return orig.call(this, r, ...a);
};
require.cache['vscode-fake'] = { id: 'vscode-fake', filename: 'vscode-fake', loaded: true, exports: fake };

const { loadProfiles, findProfile } = require('../out/config.js');

const pname = process.argv[2] || null;
const src = loadProfiles();
const prof = findProfile(src, pname);
if (!prof) {
  console.error('找不到连接配置。');
  console.error('  VS Code 来源:', src.vscodePath || '（无）');
  console.error('  文件来源   :', src.path || '（无）');
  process.exit(1);
}
if (pname || src.profiles.length > 1) {
  console.log(`使用 ${prof.profile}  ${prof.protocol}://${prof.host}:${prof.web_port}  ns=${prof.namespace}`);
}
const cfg = { ...prof };
delete cfg.profile;
delete cfg.namespaceExplicit;
delete cfg.origin;

function brief(r) {
  const bits = [`kind=${r.kind}`, `title=${r.title}`];
  if (r.rows) bits.push(`rows=${r.rows.length}`);
  if (r.headers) bits.push(`cols=${r.headers.length}`);
  if (r.code) bits.push(`code=${r.code.split('\n').length}行`);
  if (r.mermaid) bits.push(`mermaid=${r.mermaid.split('\n').length}行`);
  if (r.items) bits.push(`kv=${r.items.length}`);
  return bits.join('  ');
}

const cases = [
  ['test', { op: 'test' }],
  ['namespaces', { op: 'namespaces' }],
  ['tables', { op: 'tables', keyword: 'ARC_A', limit: 5 }],
  ['findColumn', { op: 'findColumn', keyword: 'UpdateUser', limit: 5 }],
  ['describe', { op: 'describe', table: 'SQLUser.ARC_Alias' }],
  ['udl', { op: 'udl', table: 'SQLUser.ARC_Alias' }],
  ['ddl', { op: 'ddl', table: 'SQLUser.ARC_Alias' }],
  ['er', { op: 'er', table: 'SQLUser.ARC_Alias' }],
  ['sample', { op: 'sample', table: 'SQLUser.ARC_Alias', limit: 3 }],
  ['sql', { op: 'sql', sql: 'SELECT TOP 2 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES' }],
  ['sql-拒绝写', { op: 'sql', sql: 'DELETE FROM SQLUser.ARC_Alias' }],
  ['模糊表名', { op: 'describe', table: 'ARC_Alias' }],
];

(async () => {
  for (const [label, req] of cases) {
    const t0 = Date.now();
    try {
      const r = await ops.execute(cfg, req);
      console.log(`✓ ${label.padEnd(12)} ${Date.now() - t0}ms  ${brief(r)}`);
      if (label === 'ddl') {
        console.log('---- DDL ----');
        console.log(r.code.split('\n').slice(0, 10).join('\n'));
        console.log('---- /DDL ----');
      }
      if (label === 'er') {
        console.log('---- Mermaid ----');
        console.log(r.mermaid.split('\n').slice(0, 8).join('\n'));
        console.log('---- /Mermaid ----');
      }
      if (label === 'findColumn' && r.rows) console.log('    示例:', JSON.stringify(r.rows[0]));
      if (label === 'tables' && r.rows) console.log('    示例:', JSON.stringify(r.rows.slice(0, 3)));
    } catch (e) {
      const expected = label === 'sql-拒绝写';
      console.log(`${expected ? '✓(预期报错)' : '✕'} ${label.padEnd(12)} ${e.message.split('\n')[0].slice(0, 110)}`);
    }
  }
  await c.logout(cfg);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
