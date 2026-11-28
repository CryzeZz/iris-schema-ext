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

// 断言里要用的界面文案从词条表取，不写死字面量 —— 这样同一套断言
// 在中英两种语言下都能跑（IRIS_TEST_LANG=zh-cn / en）。
// 语言必须与 render-panel.js 生成 panel-real.html 时用的一致，否则断言查的
// 是另一种语言的文案，而页面里渲染的是另一种，必挂。
const i18n = require(path.join(EXT_ROOT, 'out', 'i18n.js'));
const LANG = (process.env.IRIS_TEST_LANG || 'zh-cn').startsWith('zh') ? 'zh' : 'en';
i18n.setLanguage(LANG);
const msg = (k, ...a) => i18n.t(k, ...a);

// panel-real.html 里内联的是「生成那一刻」的语言。改了语言却没重渲染，
// 页面文案和这里 msg() 取到的就会是两种语言 —— 断言会挂得莫名其妙
// （典型表现：中文环境只挂了带文案的三条，英文环境因为两边都是默认值反而全绿）。
{
  const html = fs.readFileSync(path.join(EXT_ROOT, 'panel-real.html'), 'utf8');
  const m = html.match(/__I18N__ = ({[\s\S]*?});?<\/script>/);
  const pageLabel = m ? (JSON.parse(m[1])['common.rows'] || '') : '';
  if (pageLabel !== msg('common.rows')) {
    console.error(
      `panel-real.html 的语言与 IRIS_TEST_LANG=${LANG} 不一致（页面 "common.rows" = "${pageLabel}"）。\n` +
        `先执行：npx tsc -p . && IRIS_TEST_LANG=${LANG} node scripts/render-panel.js`
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------- 假数据
const TARGET = { profile: '138', namespace: 'APP', host: 'iris.example.com', port: 52773 };

const PROFILES = {
  type: 'profiles',
  profiles: [
    { name: '138', host: 'iris.example.com', port: 52773, protocol: 'http', user: '_SYSTEM', namespace: 'APP', description: 'HIS 测试库', passwordSource: 'keychain' },
    { name: 'dev', host: '10.10.1.60', port: 52773, protocol: 'http', user: '_SYSTEM', namespace: 'APP', description: '开发库', passwordSource: 'none' },
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
    headers: [msg('hdr.column'), msg('hdr.type'), msg('hdr.pk'), msg('hdr.note'), msg('hdr.globalPos')],
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

// tables 模式：有 Schema + 表名，行可点击跳转（用来验证重绘后 data-jump 还在）。
// 列头必须用当前语言的词条，不能用中文字面量 —— panel.js 的跳转判定是拿
// t('hdr.table') 去比对列头，英文界面下渲染的是 "Table"，数据里若还写「表名」
// 就永远对不上，行点击静默失效。这恰恰是这次双语化要防的那类问题。
const RES_TABLES = {
  type: 'result',
  result: {
    kind: 'table',
    title: '表列表',
    headers: [msg('hdr.schema'), msg('hdr.table'), msg('hdr.type')],
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
    // 状态栏当前对应的服务器与密码来源。只读 textContent 分不清
    // 「提示文字对但属于上一台服务器」，必须把口径单独带出来。
    "    targetProfile: g ? (g.dataset.profile || '') : '',",
    "    targetPwd: g ? (g.dataset.pwd || '') : '',",
    "    sent: window.__sent.map(function (m) { return m.type; }),",
    '    errs: window.__ERRS,',
    "    snippet: (t.textContent || '').replace(/\\\\s+/g, ' ').slice(0, 90)",
    '  });',
    '};',
    'setTimeout(window.__result, ' + waitMs + ');',
  ].join('\n');

  const inject = [
    '<script nonce="' + nonce + '">',
    '(function () {',
    '  window.__sent = [];',
    // 收集页面内未捕获错误。渲染分支抛错时表格会是空的，
    // 但标题只显示 "RPT:{...}" —— 没有这一层，看到的只有
    // 「tableRows=0」这种结果，查不到根因。
    '  window.__ERRS = [];',
    "  window.addEventListener('error', function (e) { window.__ERRS.push(String(e.message)); });",
    "  window.addEventListener('unhandledrejection', function (e) { window.__ERRS.push('REJ: ' + String(e.reason)); });",
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
  // 行点击跳转：重绘后 data-jump 必须还在，否则委托失效。
  // 排序点哪一列不重要（只要有列在变），这里点第 1 个可排序列，位置与语言无关。
  // 关键是要在「重绘之后」点行 —— data-jump 写不回 td 的话，这里就跳不动。
  {
    name: 'jump',
    mode: 'tables',
    res: 'RES_TABLES',
    wait: 400,
    actions: [
      "var th = document.querySelectorAll('th.sortable')[0];",
      'if (th) th.click();',            // 先排序，逼表格走一次重绘
      "var tr = document.querySelector('tbody tr[data-jump]');",
      'if (tr) tr.click();',            // 再点行
    ],
  },

  // 切到没有密码的服务器：状态栏应提示「未设置密码」。
  // 这条看着琐碎，但它验证的是「密码来源会跟着 profile 切换刷新」——
  // 如果 updateTargetInfo 只在初次渲染时调，切服务器后提示会错位，
  // 用户会以为 dev 上有密码、或者以为 138 上没密码。
  {
    name: 'noPwd',
    mode: 'describe',
    res: 'RES_DESCRIBE',
    wait: 400,
    actions: [
      "var sel = document.getElementById('profileSel');",
      "sel.value = 'dev';",
      "sel.dispatchEvent(new Event('change', { bubbles: true }));",
    ],
  },

  // 「设置密码…」菜单项：点下去必须发出 setPassword 消息（而不是当成查询模式）。
  {
    name: 'setPwd',
    mode: 'describe',
    res: 'RES_DESCRIBE',
    wait: 300,
    actions: [
      "document.getElementById('moreBtn').click();",
      "var b = document.getElementById('setPwdBtn');",
      'if (b) b.click();',
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
    // 密码来源只在「不是 keychain」时提示：有 keychain 密码是正常状态，不该在状态栏刷存在感。
    // 138 的 passwordSource 是 keychain → 不显示；切到 dev（none）→ 显示「未设置密码」。
    ['状态栏不提示 keychain 密码', () => reports.describe.targetPwd === 'keychain'
      && !reports.describe.target.includes(msg('pwd.notSet'))
      && !reports.describe.target.includes(msg('pwd.inConfig'))],
    // 断言必须同时看「切到了哪台」和「提示了什么」。
    // 早先这里只查文字，而 msg('pwd.notSet') 的中英文串恰好也出现在引导文案里，
    // 于是切换没生效时断言照样通过 —— 一条永远为真的断言比没有更糟。
    ['缺密码的服务器会提示未设置', () => reports.noPwd.targetProfile === 'dev'
      && reports.noPwd.targetPwd === 'none'
      && reports.noPwd.target.includes(msg('pwd.notSet'))],
    // 菜单里的「设置密码…」必须真的发消息，否则点了没反应
    ['菜单提供设置密码入口', () => (reports.setPwd.sent || []).includes('setPassword')],
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
    // 行数后缀跟语言走：中文「2 / 5 行」，英文「2 / 5 rows」。
    // 这里写死过 /2 \/ 5 行/，英文渲染下必然失败 —— 失败原因跟行数无关。
    ['行数提示显示 2 / 5', () => /\b2 \/ 5\b/.test(reports.filter.elapsed)],
    ['行数单位跟语言一致', () => reports.filter.elapsed.includes(msg('common.rows'))],

    // ---- 核心约束：排序/过滤不允许触发新的后端请求
    ['排序未发起新查询', () => (reports.sort.afterQuery || []).length === 0],
    ['过滤未发起新查询', () => (reports.filter.afterQuery || []).length === 0],

    // ---- 边界：过滤到 0 行要有占位，不能只剩空壳
    ['过滤无命中时显示占位行', () => (reports.nohit.rows || []).some((r) => r.join('').includes(msg('body.noMatch')))],
    ['无命中时提示 0 / 5 行', () => /\b0 \/ 5\b/.test(reports.nohit.elapsed)],

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
