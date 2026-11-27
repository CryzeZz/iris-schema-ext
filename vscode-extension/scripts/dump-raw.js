const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');

const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.iris-schema.json'), 'utf8'));
const raw = (data.connections || data)['138'];
const cfg = {
  host: raw.host,
  namespace: raw.namespace,
  user: raw.user,
  password: raw.password,
  protocol: raw.protocol || 'https',
  web_port: raw.web_port,
};

const query = process.argv[2] || 'SELECT TOP 2 Name FROM %Dictionary.ClassDefinition';
const body = Buffer.from(JSON.stringify({ query }));
const url =
  cfg.protocol +
  '://' +
  cfg.host +
  ':' +
  cfg.web_port +
  '/api/atelier/v1/' +
  cfg.namespace.replace(/%/g, '%25') +
  '/action/query';

const req = https.request(
  url,
  {
    method: 'POST',
    rejectUnauthorized: false,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(cfg.user + ':' + cfg.password).toString('base64'),
      'Content-Length': body.length,
    },
  },
  (res) => {
    let s = '';
    res.on('data', (d) => (s += d));
    res.on('end', () => {
      console.log('STATUS', res.statusCode);
      try {
        console.log(JSON.stringify(JSON.parse(s), null, 2).slice(0, 2000));
      } catch {
        console.log(s.slice(0, 1500));
      }
    });
  }
);
req.write(body);
req.end();
