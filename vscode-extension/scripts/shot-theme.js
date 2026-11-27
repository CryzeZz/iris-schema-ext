/**
 * 面板主题对照截图：在「深色」和「浅色」两种 VS Code 主题下各截一组，
 * 覆盖空态 / 表格 / 代码 / ER 图 / SQL 栏 / 错误态六个场景。
 *
 * 为什么需要这个脚本：
 *   面板样式全部走 --vscode-* 变量，光看代码判断不出深色下的对比度和层次是否成立。
 *   唯一可靠的验收方式是两种主题各出一张图，用眼睛看。
 *
 * 怎么模拟主题：
 *   webview 里 VS Code 会做两件事 ——
 *     1) 给 <body> 加 vscode-dark / vscode-light class
 *     2) 在 :root 上写一整套 --vscode-* 自定义属性（值来自当前主题）
 *   所以这里把两种主题的变量表各写死一份，注入到 <html> 上即可等价复现。
 *   变量值取自 VS Code 默认的 Dark+ 和 Light+ 主题，够贴近真实。
 *
 * 用法：node scripts/shot-theme.js            # dark + light
 *      node scripts/shot-theme.js dark       # 只截深色
 *      node scripts/shot-theme.js light
 *      node scripts/shot-theme.js hc         # 高对比度
 *      node scripts/shot-theme.js dark light hc
 * 产物：screenshots/theme-<theme>-<scene>.png
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXT_ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(EXT_ROOT, 'screenshots');
const PORT = 8937;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------- 主题变量
// 只列面板实际用到（或可能用到）的键。缺的键会回落到 CSS 里的兜底值，
// 这本身也是一种保护：真实主题里某些键可能不存在。
const THEMES = {
  dark: {
    cls: 'vscode-dark',
    vars: {
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-foreground': '#cccccc',
      '--vscode-descriptionForeground': '#9d9d9d',
      '--vscode-disabledForeground': '#7f7f7f',
      '--vscode-panel-border': '#2b2b2b',
      '--vscode-widget-border': '#303031',
      '--vscode-editorWidget-background': '#202020',
      '--vscode-editorWidget-border': '#454545',
      '--vscode-sideBar-background': '#181818',
      '--vscode-titleBar-activeBackground': '#181818',
      '--vscode-button-background': '#0078d4',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-button-hoverBackground': '#026ec1',
      '--vscode-button-secondaryBackground': '#313131',
      '--vscode-button-secondaryForeground': '#cccccc',
      '--vscode-button-secondaryHoverBackground': '#3c3c3c',
      '--vscode-button-border': 'transparent',
      '--vscode-input-background': '#313131',
      '--vscode-input-foreground': '#cccccc',
      '--vscode-input-border': '#3c3c3c',
      '--vscode-input-placeholderForeground': '#989898',
      '--vscode-focusBorder': '#0078d4',
      '--vscode-list-hoverBackground': '#2a2d2e',
      '--vscode-list-activeSelectionBackground': '#04395e',
      '--vscode-list-activeSelectionForeground': '#ffffff',
      '--vscode-toolbar-hoverBackground': '#5a5d5e50',
      '--vscode-menu-background': '#1f1f1f',
      '--vscode-menu-foreground': '#cccccc',
      '--vscode-menu-border': '#454545',
      '--vscode-menu-selectionBackground': '#0078d4',
      '--vscode-menu-selectionForeground': '#ffffff',
      '--vscode-badge-background': '#616161',
      '--vscode-badge-foreground': '#f8f8f8',
      '--vscode-textLink-foreground': '#4daafc',
      '--vscode-textLink-activeForeground': '#4daafc',
      '--vscode-errorForeground': '#f14c4c',
      '--vscode-notifications-background': '#1f1f1f',
      '--vscode-notifications-foreground': '#cccccc',
      '--vscode-notifications-border': '#2b2b2b',
      '--vscode-charts-orange': '#d18616',
      '--vscode-charts-blue': '#3794ff',
      '--vscode-charts-green': '#89d185',
      '--vscode-scrollbarSlider-background': '#79797966',
      '--vscode-scrollbarSlider-hoverBackground': '#646464b3',
      '--vscode-font-family': '"Segoe WPC", "Segoe UI", "Microsoft YaHei", sans-serif',
      '--vscode-font-size': '13px',
      '--vscode-editor-font-family': '"Cascadia Mono", Consolas, "Courier New", monospace',
      '--vscode-editor-font-size': '12px',
    },
  },
  light: {
    cls: 'vscode-light',
    vars: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-foreground': '#3b3b3b',
      '--vscode-descriptionForeground': '#717171',
      '--vscode-disabledForeground': '#8d8d8d',
      '--vscode-panel-border': '#e5e5e5',
      '--vscode-widget-border': '#e5e5e5',
      '--vscode-editorWidget-background': '#f8f8f8',
      '--vscode-editorWidget-border': '#d4d4d4',
      '--vscode-sideBar-background': '#f8f8f8',
      '--vscode-titleBar-activeBackground': '#f8f8f8',
      '--vscode-button-background': '#005fb8',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-button-hoverBackground': '#0258a8',
      '--vscode-button-secondaryBackground': '#e5e5e5',
      '--vscode-button-secondaryForeground': '#3b3b3b',
      '--vscode-button-secondaryHoverBackground': '#cccccc',
      '--vscode-button-border': 'transparent',
      '--vscode-input-background': '#ffffff',
      '--vscode-input-foreground': '#3b3b3b',
      '--vscode-input-border': '#cecece',
      '--vscode-input-placeholderForeground': '#767676',
      '--vscode-focusBorder': '#005fb8',
      '--vscode-list-hoverBackground': '#f2f2f2',
      '--vscode-list-activeSelectionBackground': '#e8e8e8',
      '--vscode-list-activeSelectionForeground': '#000000',
      '--vscode-toolbar-hoverBackground': '#b8b8b850',
      '--vscode-menu-background': '#ffffff',
      '--vscode-menu-foreground': '#3b3b3b',
      '--vscode-menu-border': '#cecece',
      '--vscode-menu-selectionBackground': '#005fb8',
      '--vscode-menu-selectionForeground': '#ffffff',
      '--vscode-badge-background': '#cccccc',
      '--vscode-badge-foreground': '#3b3b3b',
      '--vscode-textLink-foreground': '#005fb8',
      '--vscode-textLink-activeForeground': '#005fb8',
      '--vscode-errorForeground': '#e51400',
      '--vscode-notifications-background': '#ffffff',
      '--vscode-notifications-foreground': '#3b3b3b',
      '--vscode-notifications-border': '#e5e5e5',
      '--vscode-charts-orange': '#d18616',
      '--vscode-charts-blue': '#0066bf',
      '--vscode-charts-green': '#388a34',
      '--vscode-scrollbarSlider-background': '#64646466',
      '--vscode-scrollbarSlider-hoverBackground': '#646464b3',
      '--vscode-font-family': '"Segoe WPC", "Segoe UI", "Microsoft YaHei", sans-serif',
      '--vscode-font-size': '13px',
      '--vscode-editor-font-family': '"Cascadia Mono", Consolas, "Courier New", monospace',
      '--vscode-editor-font-size': '12px',
    },
  },
};

// 高对比度（HC Dark）：VS Code 的高对比度主题几乎只用黑白黄三色 + 强制边框，
// 阴影、半透明底、color-mix 在这类主题下都可能失效，所以单独验证一次。
// 这是最容易崩、也最容易被忽略的主题。
THEMES['hc'] = {
  cls: 'vscode-high-contrast',
  vars: {
    '--vscode-editor-background': '#000000',
    '--vscode-editor-foreground': '#ffffff',
    '--vscode-foreground': '#ffffff',
    '--vscode-descriptionForeground': '#ffffff',
    '--vscode-disabledForeground': '#cccccc',
    '--vscode-panel-border': '#6fc3df',
    '--vscode-widget-border': '#6fc3df',
    '--vscode-contrastBorder': '#6fc3df',
    '--vscode-editorWidget-background': '#0c141f',
    '--vscode-sideBar-background': '#000000',
    '--vscode-button-background': '#000000',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#000000',
    '--vscode-button-border': '#6fc3df',
    '--vscode-input-background': '#000000',
    '--vscode-input-foreground': '#ffffff',
    '--vscode-input-border': '#6fc3df',
    '--vscode-input-placeholderForeground': '#ffffff',
    '--vscode-focusBorder': '#f38518',
    '--vscode-list-hoverBackground': '#000000',
    '--vscode-menu-background': '#000000',
    '--vscode-menu-foreground': '#ffffff',
    '--vscode-menu-selectionBackground': '#000000',
    '--vscode-menu-selectionForeground': '#ffffff',
    '--vscode-textLink-foreground': '#3794ff',
    '--vscode-errorForeground': '#f48771',
    '--vscode-notifications-background': '#000000',
    '--vscode-notifications-foreground': '#ffffff',
    '--vscode-charts-orange': '#f38518',
    '--vscode-font-family': '"Segoe WPC", "Segoe UI", "Microsoft YaHei", sans-serif',
    '--vscode-font-size': '13px',
    '--vscode-editor-font-family': '"Cascadia Mono", Consolas, monospace',
    '--vscode-editor-font-size': '12px',
  },
};

// ---------------------------------------------------------------- 场景数据
const TARGET = { profile: '138', namespace: 'APP', host: 'iris.example.com', port: 52773 };

const PROFILES = {
  type: 'profiles',
  profiles: [
    { name: '138', host: 'iris.example.com', port: 52773, protocol: 'http', user: '_SYSTEM', namespace: 'APP', description: 'HIS 测试库', origin: 'vscode' },
    { name: 'dev', host: '10.10.1.60', port: 52773, protocol: 'http', user: '_SYSTEM', namespace: 'APP', description: '开发库', origin: 'file' },
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
    subtitle: '5 列 · 主键 ARCIM_RowId',
    headers: ['列名', '类型', '主键', '说明', 'Global 位置'],
    rows: [
      ['ARCIM_RowId', 'numeric', 'PK', 'RowID', '$P(^ARC("ALIAS",ARCIM_RowId))'],
      ['ARCIM_Desc', '%String(60)', '', '别名描述', '$P(^ARC("ALIAS",ARCIM_RowId),"^",2)'],
      ['ARCIM_Alias', '%String(30)', '', '别名', '$P(^ARC("ALIAS",ARCIM_RowId),"^",3)'],
      ['ARCIM_DateFrom', '%Date', '', '生效日期', '$P(^ARC("ALIAS",ARCIM_RowId),"^",4)'],
      ['ARCIM_Active', '%Boolean', '', '是否有效', '$P(^ARC("ALIAS",ARCIM_RowId),"^",5)'],
    ],
    meta: {
      indexes: [
        { name: 'AliasIdx', structure: 'On ARCIM_Alias [ Unique ]' },
        { name: 'DescIdx', structure: 'On ARCIM_Desc' },
      ],
      foreignKeys: [{ name: 'FK_Alias_Type', structure: 'ALIAS_Type → SQLUser.ARC_AliasType' }],
    },
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

const RES_UDL = {
  type: 'result',
  result: { kind: 'code', title: '类定义 — User.ARC_Alias', subtitle: 'User.ARC_Alias.cls', code: UDL, language: 'objectscript' },
  elapsed: 188,
  target: TARGET,
};

const MERMAID = [
  'erDiagram',
  '  SQLUser_ARCItmMast ||--o{ SQLUser_ARC_Alias : "ARCIM_RowId"',
  '  SQLUser_ARC_Alias }o--|| SQLUser_ARC_AliasType : "ALIAS_Type"',
  '  SQLUser_ARCItmMast {',
  '    numeric ARCIM_RowId PK',
  '    string ARCIM_Desc',
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

const RES_ER = {
  type: 'result',
  result: { kind: 'mermaid', title: 'ER 图 — SQLUser.ARC_Alias', subtitle: '3 张表 · 2 条关系', mermaid: MERMAID },
  elapsed: 1560,
  target: TARGET,
};

const RES_SAMPLE = {
  type: 'result',
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

const RES_ERROR = {
  type: 'error',
  text: '未找到表 SQLUser.NotExists。\n可能的原因：命名空间 %SYS 下没有该 Schema，或表名拼写有误。',
  // 真实扩展里 candidates 来自 ops.ts，是 {schema, table} 对象而非字符串
  candidates: [
    { schema: 'SQLUser', table: 'ARC_Alias' },
    { schema: 'SQLUser', table: 'ARC_AliasType' },
    { schema: 'SQLUser', table: 'ARCItmMast' },
  ],
};

const DATA = { PROFILES, NAMESPACES, RES_DESCRIBE, RES_UDL, RES_ER, RES_SAMPLE, RES_ERROR };

// 场景：{ 名字, 回灌的消息序列, 是否展开 SQL 栏, 等待毫秒 }
const SCENES = [
  { name: 'empty', msgs: ['NAMESPACES'], sql: false, wait: 500 },
  { name: 'table', msgs: ['NAMESPACES', 'RES_DESCRIBE'], sql: false, wait: 600 },
  // 排序 + 过滤同时生效的样子：第 2 列点一次升序，第 4 列填「别名」
  {
    name: 'sorted',
    msgs: ['NAMESPACES', 'RES_DESCRIBE'],
    sql: false,
    wait: 600,
    act: [
      "var ths = document.querySelectorAll('th.sortable');",
      'if (ths[1]) ths[1].click();',
      "var fs = document.querySelectorAll('.col-filter');",
      "if (fs[3]) { fs[3].value = '别名'; fs[3].dispatchEvent(new Event('input', { bubbles: true })); }",
    ],
  },
  { name: 'code', msgs: ['NAMESPACES', 'RES_UDL'], sql: false, wait: 600 },
  { name: 'er', msgs: ['NAMESPACES', 'RES_ER'], sql: false, wait: 2000 },
  { name: 'sql', msgs: ['NAMESPACES', 'RES_SAMPLE'], sql: true, wait: 600 },
  { name: 'error', msgs: ['NAMESPACES', 'RES_ERROR'], sql: false, wait: 600 },
];

// ---------------------------------------------------------------- 服务
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(EXT_ROOT, rel);
  if (!file.startsWith(EXT_ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('nf: ' + rel);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  });
});

function run(args) {
  return new Promise((resolve) => {
    execFile(CHROME, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

/** 把主题变量写成 :root 内的声明块（注入到 <head> 最前面，方便覆盖） */
function themeCss(theme) {
  const decls = Object.entries(THEMES[theme].vars)
    .map(([k, v]) => `      ${k}: ${v};`)
    .join('\n');
  return `:root {\n${decls}\n    }`;
}

function makePage(theme, scene) {
  const html = fs.readFileSync(path.join(EXT_ROOT, 'panel-real.html'), 'utf8');
  const nonce = (html.match(/nonce-([A-Za-z0-9]+)/) || [])[1] || '';
  if (!html.includes('</head>')) throw new Error('panel-real.html 缺少 </head>');

  // ---- 第一段：注入 <head> 末尾、panel.js 之前 ----
  // 只做两件事：装假 API（panel.js 一执行就会调 acquireVsCodeApi）、挂主题 class。
  // 真正的数据回灌必须等 panel.js 发出 'ready'，所以放到第二段。
  const headInject = [
    '<style>' + themeCss(theme) + '</style>',
    '<script nonce="' + nonce + '">',
    '(function () {',
    '  var state = {};',
    '  window.__sent = [];',
    '  window.acquireVsCodeApi = function () {',
    '    return {',
    '      postMessage: function (m) { window.__sent.push(m); },',
    '      getState: function () { return state; },',
    '      setState: function (s) { for (var k in s) state[k] = s[k]; }',
    '    };',
    '  };',
    '  window.__DATA = ' + JSON.stringify(DATA) + ';',
    '  window.__host = {',
    '    send: function (msg) { window.dispatchEvent(new MessageEvent("message", { data: msg })); }',
    '  };',
    '  window.__apply = function () {',
    '    document.body.classList.add(' + JSON.stringify(THEMES[theme].cls) + ');',
    '    var D = window.__DATA;',
    '    window.__host.send(D.PROFILES);',
    '      ' + scene.msgs.map((k) => 'window.__host.send(D.' + k + ');').join('\n      '),
    scene.sql
      ? '    var bar = document.getElementById("sqlBar"); if (bar) bar.classList.remove("hidden");\n' +
        '    var ta = document.getElementById("sqlInput");\n' +
        '    if (ta) ta.value = "SELECT TOP 50 *\\nFROM SQLUser.ARC_Alias\\nWHERE ARCIM_Active = 1\\nORDER BY ARCIM_RowId DESC";'
      : '',
    // 场景动作：点表头排序 / 填过滤词，必须在数据灌完之后做
    ...(scene.act || []).map((line) => '    ' + line),
    '  };',
    '}());',
    '</script>',
  ]
    .filter(Boolean)
    .join('\n');

  // ---- 第二段：body 末尾、panel.js 之后 ----
  // panel.js 末尾会立刻 postMessage({type:'ready'})，所以这里只需轮询 __sent 非空即可。
  const tailInject = [
    '<script nonce="' + nonce + '">',
    '(function () {',
    '  var n = 0;',
    '  var timer = setInterval(function () {',
    '    if (window.__sent.length > 0) {',
    '      clearInterval(timer);',
    '      try { window.__apply(); } catch (e) { document.title = "ERR:" + e.message; }',
    '    } else if (++n > 1200) {',
    '      clearInterval(timer);',
    '      document.title = "ERR: panel.js 未就绪";',
    '    }',
    '  }, 10);',
    '}());',
    '</script>',
  ].join('\n');

  const out = html.replace('</head>', headInject + '\n</head>').replace('</body>', tailInject + '\n</body>');
  const p = path.join(EXT_ROOT, `.theme-${theme}-${scene.name}.html`);
  fs.writeFileSync(p, out, 'utf8');
  return p;
}

// ---------------------------------------------------------------- 主流程
(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const wanted = process.argv.slice(2).filter((a) => a in THEMES);
  const themes = wanted.length ? wanted : ['dark', 'light'];
  // --keep：保留生成的场景页，供别的脚本（如 shot-narrow-th.js）复用同一套主题注入
  const keep = process.argv.includes('--keep');

  if (!fs.existsSync(path.join(EXT_ROOT, 'panel-real.html'))) {
    console.error('缺少 panel-real.html，请先运行 node scripts/render-panel.js');
    process.exit(1);
  }

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`本地服务 http://127.0.0.1:${PORT}/`);

  const made = [];
  for (const theme of themes) {
    for (const scene of SCENES) {
      const page = makePage(theme, scene);
      made.push(page);
      const url = `http://127.0.0.1:${PORT}/${path.basename(page)}`;
      const shot = path.join(OUT, `theme-${theme}-${scene.name}.png`);
      await run([
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--virtual-time-budget=' + (scene.wait + 3000),
        '--window-size=1100,760',
        `--screenshot=${shot}`,
        url,
      ]);
      const size = fs.existsSync(shot) ? fs.statSync(shot).size : 0;
      console.log(`  ${theme}/${scene.name} -> ${size} 字节`);
    }
  }

  await new Promise((r) => server.close(r));
  if (keep) {
    console.log('已保留场景页（--keep）：', made.map((p) => path.basename(p)).join(', '));
  } else {
    for (const p of made) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
  console.log('完成，输出目录', OUT);
})();
