const path = require('path'), os = require('os'), fs = require('fs');
const c = require('../out/irisClient.js');
const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.iris-schema.json'), 'utf8'));
const raw = (data.connections || data)['138'];
const cfg = { host: raw.host, namespace: raw.namespace, user: raw.user, password: raw.password,
  protocol: 'https', web_port: raw.web_port, verify_ssl: false };
(async () => {
  const sc = await c.parseClassSchema(cfg, 'SQLUser', 'ARC_Alias');
  console.log('前 6 行 desc:');
  sc.rows.slice(0, 6).forEach((r) => console.log('  ', JSON.stringify(r.name), '=>', JSON.stringify(r.desc)));
  await c.logout(cfg);
})().catch((e) => { console.error(e); process.exit(1); });
