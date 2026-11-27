const path=require('path'),os=require('os'),fs=require('fs');
const c=require('../out/irisClient.js');
const data=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.iris-schema.json'),'utf8'));
const raw=(data.connections||data)['138'];
const cfg={host:raw.host,namespace:raw.namespace,user:raw.user,password:raw.password,protocol:'https',web_port:raw.web_port,verify_ssl:false};
(async()=>{
  const sql="SELECT TOP 5 TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE LOWER(TABLE_NAME) LIKE '%arc_a%' AND TABLE_SCHEMA NOT LIKE '%' AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA' ORDER BY TABLE_SCHEMA, TABLE_NAME";
  const r=await c.postQuery(cfg,sql);
  console.log('带过滤条件 行数:',r.rows.length);
  const sql2="SELECT TOP 5 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE LOWER(TABLE_NAME) LIKE '%arc_a%' AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA'";
  const r2=await c.postQuery(cfg,sql2);
  console.log('去掉 NOT LIKE 后 行数:',r2.rows.length, JSON.stringify(r2.rows.slice(0,3)));
  await c.logout(cfg);
})().catch(e=>{console.error(e);process.exit(1)});
