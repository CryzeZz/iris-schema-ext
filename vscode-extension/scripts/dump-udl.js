/** 打印某个类的 UDL 原文（调试解析用）。用法：node scripts/dump-udl.js <profile> <Class> */
const path = require('path'), os = require('os'), fs = require('fs');
const c = require('../out/irisClient.js');
const p = (process.argv[2] || '138'), cls = process.argv[3];
const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.iris-schema.json'), 'utf8'));
const raw = (data.connections || data)[p];
const cfg = { host: raw.host, namespace: raw.namespace, user: raw.user, password: raw.password,
  protocol: raw.protocol || 'https', web_port: raw.web_port, verify_ssl: raw.verify_ssl !== false };
(async () => {
  const lines = await c.fetchClassUdl(cfg, cls);
  lines.forEach((l, i) => console.log(String(i).padStart(3), l));
  await c.logout(cfg);
})().catch((e) => { console.error(e.message); process.exit(1); });
