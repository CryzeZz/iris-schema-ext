/**
 * 伪宿主端到端验证：在浏览器里扮演扩展宿主，跑通「profiles → result」渲染链路。
 *
 * 原理：把 acquireVsCodeApi 换成假实现（记录 postMessage 并允许回灌消息），
 * 这样 panel.js 会以为自己跑在 webview 里，真实的渲染分支全部被覆盖。
 *
 * 踩过的坑（别再重复）：
 *   1. --screenshot 与 --dump-dom 同时给会互相干扰，必须分两次跑。
 *   2. 注入脚本在 </head>，panel.js 在 body 末尾且前面压着 3MB mermaid，
 *      必须等 panel.js 发出第一条 'ready' 再灌数据，不能用 setTimeout(0)。
 *   3. 场景体含函数声明，不能写成 ( body )() 形式，否则是语法错误；
 *      要包在 (function(){ ... })() 里。
 *   4. 拼接 HTML 时不要在 JS 字符串里混用双引号，容易和模板字符串互相破坏。
 *
 * 用法：node scripts/e2e-panel.js
 * 产物：screenshots/e2e-*.png
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXT_ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(EXT_ROOT, 'screenshots');
const PORT = 8933;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

// ---------------------------------------------------------------- 假数据
const TARGET = { profile: '138', namespace: 'APP', host: 'iris.example.com', port: 52773 };

const PROFILES = {
  type: 'profiles',
  profiles: [
    { name: '138', host: 'iris.example.com', port: 52773, protocol: 'http', user: '_SYSTEM', namespace: 'APP', description: 'HIS 测试库' },
    { name: 'dev', host: '10.10.1.60', port: 52773, protocol: 'http', user: '_SYSTEM', namespace: 'APP', description: '开发库' },
  ],
  default: '138',
  configPath: 'C:/Users/zhang/.iris-schema.json',
  state: { profile: null, namespace: null, mode: 'describe', keyword: '' },
};

const NAMESPACES = { type: 'namespaces', profile: '138', namespaces: ['APP', '%SYS', 'USER', 'DOCBOOK'], current: 'APP' };

const RES_DESCRIBE = {
  type: 'result',
  result: {
    kind: 'table',
    title: 'SQLUser.ARC_Alias',
    headers: ['列名', '类型', '主键', '说明', 'Global 位置'],
    rows: [
      ['ARCIM_RowId', 'numeric', 'PK', 'RowID', '$P(^ARC("ALIAS",ARCIM_RowId))'],
      ['ARCIM_Desc', '%String(60)', '', '别名描述', '$P(^ARC("ALIAS",ARCIM_RowId),"^",2)'],
      ['ARCIM_Alias', '%String(30)', '', '别名', '$P(^ARC("ALIAS",ARCIM_RowId),"^",3)'],
      ['ARCIM_DateFrom', '%Date', '', '生效日期', '$P(^ARC("ALIAS",ARCIM_RowId),"^",4)'],
      ['ARCIM_Active', '%Boolean', '', '是否有效', '$P(^ARC("ALIAS",ARCIM_RowId),"^",5)'],
    ],
  },
  elapsed: 412,
  target: TARGET,
};

const UDL = [
  'Class User.ARC_Alias Extends %Persistent [ ClassType = persistent, DdlAllowed, Owner = {_SYSTEM} ]',
  '{',
  '',
  'Property ARCIMDesc As %String(MAXLEN = 60) [ SqlColumnNumber = 2 ];',
  '',
  'Property ARCIMAlias As %String(MAXLEN = 30) [ SqlColumnNumber = 3 ];',
  '',
  'Index AliasIdx On ARCIMAlias [ Unique ];',
  '',
  'Storage Default',
  '{',
  '<Data name="ARC_AliasDefaultData">',
  '<Value name="1"><Value>%%CLASSNAME</Value></Value>',
  '</Data>',
  '<Location>^ARC("ALIAS")</Location>',
  '}',
  '',
  '}',
].join('\n');

const RES_UDL = { type: 'result', result: { kind: 'code', title: 'User.ARC_Alias.cls', code: UDL, language: 'objectscript' }, elapsed: 188, target: TARGET };

const MERMAID = [
  'erDiagram',
  '  SQLUser_ARCItmMast ||--o{ SQLUser_ARC_Alias : "ARCIM_RowId"',
  '  SQLUser_ARC_Alias }o--|| SQLUser_ARC_AliasType : "ALIAS_Type"',
  '  SQLUser_ARCItmMast {',
  '    numeric ARCIM_RowId PK',
  '    string ARCIM_Desc',
  '    date ARCIM_DateFrom',
  '  }',
  '  SQLUser_ARC_Alias {',
  '    numeric ARCIM_RowId PK',
  '    string ARCIM_Desc',
  '    string ARCIM_Alias',
  '  }',
  '  SQLUser_ARC_AliasType {',
  '    numeric ALIA_RowId PK',
  '    string ALIA_Desc',
  '  }',
].join('\n');

const RES_ER = { type: 'result', result: { kind: 'mermaid', title: 'SQLUser.ARC_Alias 关系图（3 张表）', mermaid: MERMAID }, elapsed: 1560, target: TARGET };

const RES_SAMPLE = {  type: 'result',
  result: {
    kind: 'table',
    title: 'SQLUser.ARC_Alias 前 5 行',
    headers: ['ARCIM_RowId', 'ARCIM_Desc', 'ARCIM_Alias', 'ARCIM_DateFrom'],
    rows: [
      [1, '门诊挂号', 'OPREG', '2020-01-01'],
      [2, '住院登记', 'IPREG', '2020-01-01'],
      [3, '急诊挂号', 'ERREG', '2021-06-15'],
      [4, '体检登记', 'PHEXAM', '2022-03-08'],
      [5, '检验申请', 'LABORD', '2023-11-20'],
    ],
  },
  elapsed: 336,
  target: TARGET,
};

// tables 模式：有 Schema + 表名，行可点击跳转（用来验证重绘后 data-jump 还在）
const RES_TABLES = {
  type: 'result',
  result: {
    kind: 'table',
    title: '表列表',
    headers: ['Schema', '表名', '类型'],
    rows: [
      ['SQLUser', 'ARC_Alias', 'table'],
      ['SQLUser', 'ARCItmMast', 'table'],
      ['SQLUser', 'DHCPatient', 'table'],
    ],
  },
  elapsed: 220,
  target: TARGET,
};

const DATA = { PROFILES, NAMESPACES, RES_DESCRIBE, RES_UDL, RES_ER, RES_SAMPLE, RES_TABLES };

// ---------------------------------------------------------------- 服务
const missing = [];
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(EXT_ROOT, rel);
  if (!file.startsWith(EXT_ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { missing.push(rel); res.writeHead(404).end('nf: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  });
});

function run(args) {
  return new Promise((resolve) => {
    execFile(CHROME, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

/**
 * 生成场景页。
 * @param name    文件名后缀
 * @param mode    点击哪个模式按钮（describe/udl/er/sample）
 * @param resKey  回灌哪条 result 数据
 * @param waitMs  report 前的等待（mermaid 渲染慢，需要更久）
 * @param actions 在 report 之前对表格做的动作（字符串数组，会被原样塞进场景体）
 */
function makeScenario(name, mode, resKey, waitMs, actions) {
  const html = fs.readFileSync(path.join(EXT_ROOT, 'panel-real.html'), 'utf8');
  const nonce = (html.match(/nonce-([A-Za-z0-9]+)/) || [])[1] || '';
  if (!html.includes('</head>')) throw new Error('panel-real.html 缺少 </head>');

  // 场景体单独拼，全用单引号，避免与 HTML 属性/模板字符串打架
  const scene = [
    'var D = window.__DATA;',
    'window.__host.send(D.PROFILES);',
    'window.__host.send(D.NAMESPACES);',
    "var btn = document.querySelector('.seg-btn[data-mode=\"" + mode + "\"]');",
    'if (btn) btn.click();',
    'window.__host.send(D.' + resKey + ');',
    // 查询请求到这里已经发完了，先钉一个基线，后面任何新 query 都算「不该发生」
    'window.__sentBefore = window.__sent.length;',
    ...(actions || []),
    'window.__result = function () {',
    "  var t = document.getElementById('result');",
    "  var e = document.getElementById('elapsed');",
    "  var g = document.getElementById('targetInfo');",
    "  var rows = [].map.call(t.querySelectorAll('tbody tr'), function (tr) {",
    "    return [].map.call(tr.querySelectorAll('td'), function (td) { return td.textContent; });",
    '  });',
    "  var extra = window.__sent.slice(window.__sentBefore).map(function (m) { return m.type; });",
    "  document.title = 'RPT:' + JSON.stringify({",
    "    mode: '" + mode + "',",
    "    hasTable: !!t.querySelector('table'),",
    '    tableRows: rows.length,',
    '    rows: rows,',
    '    afterQuery: extra,',
    "    hasSvg: !!t.querySelector('svg'),",
    "    svgNodes: t.querySelectorAll('svg path, svg line, svg text').length,",
    "    codeLen: (t.querySelector('pre') ? t.querySelector('pre').textContent.length : 0),",
    "    elapsed: e ? e.textContent : '',",
    "    target: g ? g.textContent : '',",
    "    sent: window.__sent.map(function (m) { return m.type; }),",
    "    snippet: (t.textContent || '').replace(/\\\\s+/g, ' ').slice(0, 90)",
    '  });',
    '};',
    'setTimeout(window.__result, ' + waitMs + ');',
  ].join('\n');

  const inject = [
    '<script nonce="' + nonce + '">',
    '(function () {',
    '  window.__sent = [];',
    '  var state = {};',
    '  window.acquireVsCodeApi = function () {',
    '    return {',
    '      postMessage: function (m) { window.__sent.push(m); },',
    '      getState: function () { return state; },',
    '      setState: function (s) { for (var k in s) state[k] = s[k]; }',
    '    };',
    '  };',
    '  window.__host = {',
    '    send: function (msg) { window.dispatchEvent(new MessageEvent("message", { data: msg })); }',
    '  };',
    '  window.__DATA = ' + JSON.stringify(DATA) + ';',
    '  var n = 0;',
    '  var timer = setInterval(function () {',
    '    if (window.__sent.length > 0) {',
    '      clearInterval(timer);',
    '      try {',
    '        (function () {',
    scene,
    '        })();',
    '      } catch (err) {',
    '        document.title = "ERR:" + err.message;',
    '      }',
    '    } else if (++n > 800) {',
    '      clearInterval(timer);',
    '      document.title = "ERR: panel.js 未就绪";',
    '    }',
    '  }, 10);',
    '}());',
    '</script>',
  ].join('\n');

  const out = html.replace('</head>', inject + '\n</head>');
  const p = path.join(EXT_ROOT, '.scenario-' + name + '.html');
  fs.writeFileSync(p, out, 'utf8');
  return p;
}

const CASES = [
  { name: 'describe', mode: 'describe', res: 'RES_DESCRIBE', wait: 400 },
  { name: 'udl', mode: 'udl', res: 'RES_UDL', wait: 400 },
  { name: 'er', mode: 'er', res: 'RES_ER', wait: 1800 },
  { name: 'sample', mode: 'sample', res: 'RES_SAMPLE', wait: 400 },
  // 点两次表头 = 升序 → 降序。断言看「第一行的 RowId 变了」和「没有新 query」。
  {
    name: 'sort',
    mode: 'sample',
    res: 'RES_SAMPLE',
    wait: 400,
    actions: [
      "var th0 = document.querySelectorAll('th.sortable')[0];",
      'if (th0) th0.click();',
      'if (th0) th0.click();',
    ],
  },
  // 在「说明」列（第 4 列）输入「别名」，应只剩 2 行（别名描述 / 别名）且不发 query。
  {
    name: 'filter',
    mode: 'describe',
    res: 'RES_DESCRIBE',
    wait: 400,
    actions: [
      "var inp = document.querySelectorAll('.col-filter')[3];",
      "if (inp) { inp.value = '别名'; inp.dispatchEvent(new Event('input', { bubbles: true })); }",
    ],
  },
  // 过滤到 0 行：应显示占位行，而不是空表格
  {
    name: 'nohit',
    mode: 'describe',
    res: 'RES_DESCRIBE',
    wait: 400,
    actions: [
      "var inp = document.querySelectorAll('.col-filter')[0];",
      "if (inp) { inp.value = '不存在的东西'; inp.dispatchEvent(new Event('input', { bubbles: true })); }",
    ],
  },
  // 行点击跳转：重绘后 data-jump 必须还在，否则委托失效
  {
    name: 'jump',
    mode: 'tables',
    res: 'RES_TABLES',
    wait: 400,
    actions: [
      "var th = document.querySelectorAll('th.sortable')[1];",
      'if (th) th.click();',            // 先排序，逼表格走一次重绘
      "var tr = document.querySelector('tbody tr[data-jump]');",
      'if (tr) tr.click();',            // 再点行
    ],
  },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const reports = {};
  for (const c of CASES) {
    const page = makeScenario(c.name, c.mode, c.res, c.wait, c.actions);
    const url = `http://127.0.0.1:${PORT}/${path.basename(page)}`;
    const shot = path.join(OUT, `e2e-${c.name}.png`);

    await run(['--headless=new', '--disable-gpu', '--virtual-time-budget=20000', '--window-size=1280,860', '--hide-scrollbars', `--screenshot=${shot}`, url]);
    const dom = await run(['--headless=new', '--disable-gpu', '--virtual-time-budget=20000', '--dump-dom', url]);

    const tm = dom.stdout.match(/<title>([^<]*)<\/title>/);
    const title = tm ? tm[1] : '(none)';
    let rpt = null;
    if (title.startsWith('RPT:')) { try { rpt = JSON.parse(title.slice(4)); } catch { rpt = null; } }
    reports[c.name] = rpt || { error: title };
    console.log(
      rpt
        ? `[${c.name}] OK  table=${rpt.hasTable} rows=${rpt.tableRows} svg=${rpt.hasSvg}/${rpt.svgNodes} code=${rpt.codeLen} elapsed=${rpt.elapsed} after=${(rpt.afterQuery || []).join(',') || '-'}`
        : `[${c.name}] ERR ${title}`
    );
    fs.unlinkSync(page);
  }

  await new Promise((r) => server.close(r));

  // 行内容的小工具：取某一列的全部值
  const col = (name, idx) => ((reports[name].rows || []).map((r) => r[idx + 1])); // +1 跳过行号列

  const checks = [
    ['describe 渲染表格 5 行', () => reports.describe.tableRows === 5],
    ['describe 显示耗时', () => /\d+/.test(reports.describe.elapsed)],
    ['describe 显示目标 138 / APP', () => /138/.test(reports.describe.target) && /APP/.test(reports.describe.target)],
    ['udl 渲染代码（>200 字符）', () => reports.udl.codeLen > 200],
    ['er 渲染 SVG', () => reports.er.hasSvg],
    ['er SVG 图形元素 >10', () => reports.er.svgNodes > 10],
    ['sample 渲染表格 5 行', () => reports.sample.tableRows === 5],
    ['无 404 请求', () => missing.length === 0],

    // ---- 表头排序：连点两次 = 升序后降序，RowId 首行应从 1 变 5
    ['表头排序后行数不变', () => reports.sort.tableRows === 5],
    ['降序后首行 RowId = 5', () => col('sort', 0)[0] === '5'],
    ['降序后末行 RowId = 1', () => col('sort', 0)[4] === '1'],
    ['降序后整列逆序', () => col('sort', 0).join(',') === '5,4,3,2,1'],

    // ---- 列过滤：说明列含「别名」的只有 2 行
    ['过滤后只剩 2 行', () => reports.filter.tableRows === 2],
    ['过滤命中的都含别名', () => (reports.filter.rows || []).every((r) => r.join('').includes('别名'))],
    ['行数提示显示 2 / 5', () => /2 \/ 5 行/.test(reports.filter.elapsed)],

    // ---- 核心约束：排序/过滤不允许触发新的后端请求
    ['排序未发起新查询', () => (reports.sort.afterQuery || []).length === 0],
    ['过滤未发起新查询', () => (reports.filter.afterQuery || []).length === 0],

    // ---- 边界：过滤到 0 行要有占位，不能只剩空壳
    ['过滤无命中时显示占位行', () => (reports.nohit.rows || []).some((r) => r.join('').includes('没有匹配的行'))],
    ['无命中时提示 0 / 5 行', () => /0 \/ 5 行/.test(reports.nohit.elapsed)],

    // ---- 回归：排序重绘之后，行点击跳转仍然有效（data-jump 必须写回）
    ['排序重绘后行仍可跳转', () => (reports.jump.afterQuery || []).includes('query')],
  ];

  let bad = 0;
  console.log('\n--- 断言 ---');
  for (const [name, fn] of checks) {
    let pass = false;
    try { pass = !!fn(); } catch { pass = false; }
    console.log(' ', pass ? 'PASS' : 'FAIL', name);
    if (!pass) bad++;
  }
  if (missing.length) console.log('  404:', [...new Set(missing)].join(', '));
  if (bad) console.log('\n失败详情:\n' + JSON.stringify(reports, null, 2));
  process.exit(bad ? 1 : 0);
})();
