/* global acquireVsCodeApi */
(function () {
  /**
   * 词条表由扩展侧注入（panel.ts 里渲染 HTML 时写入 `window.__I18N__`），
   * webview 这边不重复维护一份文案。直接双击打开导出的 HTML 调试样式时没有这张表，
   * 退化成显示 key 本身——布局看得清，也能看出哪条漏注入。
   */
  const MSG = (typeof window !== 'undefined' && window.__I18N__) || {};

  /** 取词条并替换 {0} {1} 占位符。 */
  function t(key) {
    let s = MSG[key];
    if (s === undefined) return key;
    for (let i = 1; i < arguments.length; i++) {
      s = s.split('{' + (i - 1) + '}').join(String(arguments[i]));
    }
    return s;
  }

  /**
   * 按「当前语言的那条列头文案」生成正则，用来认列。
   *
   * 原来这里写的是 `/^(表名|table)$/i` 这类中英双分支的硬编码正则，
   * 双语化之后就成了隐患：实际列头来自 t('hdr.table')，只要哪天把中文
   * 从「表名」改成「表」，或者英文从 "Table" 改成 "Table name"，
   * 正则就会静默失配 —— 表格不会报错，只是列宽分配、行点击跳转、
   * 等宽字体统统失效，很难发现。改成从词条表反查，改文案只改 i18n.ts 一处。
   *
   * 拿不到词条（没注入 __I18N__，比如浏览器里直接打开导出的 HTML）时
   * 返回一个永不匹配的正则，交给调用处的兜底逻辑处理。
   */
  function matchHeader(key) {
    const label = MSG[key];
    if (typeof label !== 'string' || !label) return /(?!)/;
    return new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  }

  /** 用等宽字体显示的列头：属性名/类型这类标识符，等宽更好对齐比较。 */
  const MONO_HEADERS = ['hdr.propName', 'hdr.propType', 'hdr.fieldName', 'hdr.type', 'hdr.length'];

  /**
   * 真实宿主里 acquireVsCodeApi 一定存在。但在浏览器里直接打开导出页
   * （调试布局/样式）时它没有，若直接调用会让整个 IIFE 抛错、页面全白。
   * 这里退化成内存态：能看能点，只是后端消息石沉大海。
   */
  const vscode =
    typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : {
          postMessage: (m) => console.log('[no-host postMessage]', m),
          getState: () => ({}),
          setState: () => undefined,
        };

  const el = {
    modeSeg: document.getElementById('modeSeg'),
    profileSel: document.getElementById('profileSel'),
    nsSel: document.getElementById('nsSel'),
    keyword: document.getElementById('keyword'),
    queryBtn: document.getElementById('queryBtn'),
    moreBtn: document.getElementById('moreBtn'),
    moreMenu: document.getElementById('moreMenu'),
    sqlBar: document.getElementById('sqlBar'),
    sqlInput: document.getElementById('sqlInput'),
    sqlRun: document.getElementById('sqlRun'),
    sqlClose: document.getElementById('sqlClose'),
    targetInfo: document.getElementById('targetInfo'),
    elapsed: document.getElementById('elapsed'),
    result: document.getElementById('result'),
    toast: document.getElementById('toast'),
    loading: document.getElementById('loading'),
  };

  /** 当前模式：工具条上的四个按钮 + 菜单里的命令 */
  let mode = 'describe';
  let profiles = [];
  let savedState = vscode.getState() || {};

  // ------------------------------------------------------------ 初始化

  if (savedState.mode) setMode(savedState.mode, false);
  if (savedState.keyword) el.keyword.value = savedState.keyword;

  el.modeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    setMode(btn.dataset.mode);
    run();
  });

  el.moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.moreMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', () => el.moreMenu.classList.add('hidden'));

  el.moreMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    el.moreMenu.classList.add('hidden');
    setMode(btn.dataset.mode);
    if (btn.dataset.mode === 'sql') {
      el.sqlBar.classList.remove('hidden');
      el.sqlInput.focus();
      return;
    }
    run();
  });

  el.queryBtn.addEventListener('click', () => run());
  el.keyword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });

  el.sqlClose.addEventListener('click', () => el.sqlBar.classList.add('hidden'));
  el.sqlRun.addEventListener('click', () => runSql());
  el.sqlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runSql();
    }
  });

  el.profileSel.addEventListener('change', () => {
    const p = profiles.find((x) => x.name === el.profileSel.value);
    el.nsSel.innerHTML = `<option value="${esc(p ? p.namespace : '')}">${esc(p ? p.namespace : '')}</option>`;
    vscode.postMessage({ type: 'loadNamespaces', profile: el.profileSel.value });
    persist();
  });

  el.nsSel.addEventListener('change', persist);

  function setMode(m, doPersist = true) {
    mode = m;
    document.querySelectorAll('#modeSeg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === m);
    });
    // 模式决定输入框提示语
    const hints = {
      describe: t('ph.describe'),
      udl: t('ph.udl'),
      er: t('ph.er'),
      sample: t('ph.sample'),
      tables: t('ph.tables'),
      findColumn: t('ph.findColumn'),
      ddl: t('ph.ddl'),
      sql: t('ph.sql'),
      test: t('ph.test'),
    };
    el.keyword.placeholder = hints[m] || hints.describe;
    el.keyword.disabled = m === 'sql';
    if (doPersist) persist();
  }

  function persist() {
    const st = {
      mode,
      keyword: el.keyword.value,
      profile: el.profileSel.value,
      namespace: el.nsSel.value,
    };
    vscode.setState(st);
  }

  // ------------------------------------------------------------ 发请求

  function run() {
    const profile = el.profileSel.value;
    if (!profile) {
      toast(t('toast.noProfiles'));
      return;
    }
    const keyword = el.keyword.value.trim();
    const needName = ['describe', 'udl', 'er', 'sample', 'ddl'].includes(mode);
    if (needName && !keyword) {
      toast(t('toast.needTable'));
      el.keyword.focus();
      return;
    }
    persist();
    vscode.postMessage({
      type: 'query',
      mode,
      profile,
      namespace: el.nsSel.value,
      keyword,
      schema: '',
      limit: 100,
    });
  }

  function runSql() {
    const sql = el.sqlInput.value.trim();
    if (!sql) {
      toast(t('toast.needSql'));
      return;
    }
    vscode.postMessage({
      type: 'query',
      mode: 'sql',
      profile: el.profileSel.value,
      namespace: el.nsSel.value,
      sql,
      limit: 500,
    });
  }

  // ------------------------------------------------------------ 接收消息

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'profiles':
        profiles = msg.profiles || [];
        renderProfiles(msg);
        break;
      case 'namespaces':
        renderNamespaces(msg);
        break;
      case 'result':
        renderResult(msg);
        break;
      case 'busy':
        el.loading.classList.toggle('hidden', !msg.on);
        el.queryBtn.disabled = msg.on;
        break;
      case 'error':
        renderError(msg.text, msg.candidates);
        break;
      case 'toast':
        toast(msg.text);
        break;
      default:
        break;
    }
  });

  function renderProfiles(msg) {
    profiles = msg.profiles || [];
    if (!profiles.length) {
      el.profileSel.innerHTML = `<option value="">${t('guide.noneOption')}</option>`;
      el.result.innerHTML =
        `<div class="err">${t('guide.noProfiles')}<br><br>` +
        t('guide.noProfilesDetail') +
        `<br><br>` +
        `<pre class="code">"intersystems.servers": {<br>` +
        `  "dev": {<br>` +
        `    "webServer": { "scheme": "https", "host": "iris.example.com", "port": 52773 },<br>` +
        `    "username": "user", "password": "pass",<br>` +
        `    "description": "${t('guide.exampleDesc')}"<br>` +
        `  }<br>` +
        `}</pre>` +
        `<br>` +
        t('guide.namespaceTip') +
        `<br><br>` +
        t('guide.fileTip') +
        `</div>`;
      return;
    }
    const want = msg.state?.profile || savedState.profile || msg.default;
    el.profileSel.innerHTML = profiles
      .map((p) => {
        // 标签只用「名字 · 描述」，避免下拉太宽；来源用 title 提示
        const label = p.description ? `${p.name} · ${p.description}` : `${p.name} · ${p.host}`;
        const tip = p.origin === 'vscode'
          ? `${t('target.fromVscode')}\n${p.protocol}://${p.host}:${p.port}`
          : `${t('target.fromFile')}\n${p.protocol}://${p.host}:${p.port}`;
        return `<option value="${esc(p.name)}" title="${esc(tip)}"${p.name === want ? ' selected' : ''}>${esc(label)}</option>`;
      })
      .join('');
    const cur = profiles.find((p) => p.name === el.profileSel.value) || profiles[0];
    el.nsSel.innerHTML = `<option value="${esc(cur.namespace)}">${esc(cur.namespace)}</option>`;
    el.targetInfo.textContent = `${cur.protocol}://${cur.host}:${cur.port}　${t('target.account')} ${cur.user}` +
      (msg.configPath ? `　${t('target.config')} ${msg.configPath}` : '');
    vscode.postMessage({ type: 'loadNamespaces', profile: el.profileSel.value });
  }

  function renderNamespaces(msg) {
    const list = msg.namespaces || [];
    if (!list.length) return;
    const p = profiles.find((x) => x.name === msg.profile);
    const want = msg.current || savedState.namespace || (p && p.namespace) || list[0];
    const selected = list.includes(want) ? want : list[0];
    el.nsSel.innerHTML = list.map((n) => `<option value="${esc(n)}"${n === selected ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

  // ------------------------------------------------------------ 渲染结果

  /** 上一次查询的耗时（ms），用于状态栏前缀。 */
  let lastElapsed = null;
  /** 当前结果的可见行数 / 总行数；不含 rows 的结果（代码、ER 图）为 null。 */
  let lastRowCount = null;
  let lastRowTotal = null;

  function updateElapsed() {
    if (lastElapsed === null) return;
    let text = t('status.elapsed', lastElapsed);
    if (lastRowCount !== null) {
      text += '　' + (lastRowCount === lastRowTotal ? lastRowCount : lastRowCount + ' / ' + lastRowTotal);
      text += ' ' + t('common.rows');
    }
    el.elapsed.textContent = text;
  }

  function renderResult(msg) {
    const r = msg.result;
    // 行数拆成独立变量维护：后缀跟着过滤结果变化，
    // 不能用正则去改 el.elapsed.textContent —— 那个正则依赖中文「行」字，
    // 换成英文（"rows"）后匹配不上，过滤时行数就不会更新。
    lastElapsed = msg.elapsed;
    const total = (r.rows || []).length;
    lastRowTotal = total;
    lastRowCount = r.rows ? total : null;
    updateElapsed();
    if (msg.target) {
      el.targetInfo.textContent = `${msg.target.profile}　${msg.target.host}:${msg.target.port}　${msg.target.namespace}`;
    }
    const head = document.createElement('div');
    head.className = 'result-head';
    const actions = [];
    if (r.kind === 'code') actions.push(`<button data-act="open">${t('act.openInEditor')}</button>`);
    if (r.kind === 'code' && metaClass(r)) actions.push(`<button data-act="save">${t('act.saveCls')}</button>`);
    if (r.kind === 'table') actions.push(`<button data-act="csv">${t('act.exportCsv')}</button>`);
    if (r.code || r.mermaid) actions.push(`<button data-act="copy">${t('act.copy')}</button>`);
    head.innerHTML =
      `<span class="result-title">${esc(r.title || '')}</span>` +
      (r.subtitle ? `<span class="result-sub">${esc(r.subtitle)}</span>` : '') +
      `<span class="result-actions">${actions.join('')}</span>`;

    const body = document.createElement('div');
    let tableEl = null;
    switch (r.kind) {
      case 'table':
        tableEl = renderTable(r);
        body.appendChild(tableEl);
        break;
      case 'code':
        body.appendChild(renderCode(r.code || ''));
        break;
      case 'mermaid':
        body.appendChild(renderMermaid(r));
        break;
      case 'kv':
        body.appendChild(renderKv(r.items || []));
        break;
      default:
        body.innerHTML = `<div class="empty">${esc(r.text || t('body.noResult'))}</div>`;
    }

    // describe 附带索引与外键小节
    if (r.meta && (r.meta.indexes || r.meta.foreignKeys)) {
      body.appendChild(renderSections(r.meta));
    }

    el.result.innerHTML = '';
    el.result.appendChild(head);
    el.result.appendChild(body);
    el.result.scrollTop = 0;

    head.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'copy') vscode.postMessage({ type: 'copy', text: r.code || r.mermaid || '' });
      if (act === 'open') vscode.postMessage({ type: 'openAsFile', text: r.code || '', language: 'objectscript' });
      if (act === 'save') vscode.postMessage({ type: 'saveUdl', text: r.code || '', suggested: suggestedCls(r) });
      if (act === 'csv') exportCsv(r, tableEl);
    });

    // 表格行点击 -> 跳到表结构
    if (r.kind === 'table' && r.headers && r.rows) {
      body.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-jump]');
        if (!tr) return;
        const [schema, table] = JSON.parse(tr.dataset.jump);
        el.keyword.value = `${schema}.${table}`;
        setMode('describe');
        run();
      });
    }
  }

  function metaClass(r) {
    // 从 meta 里直接取，不再解析标题文本。
    // 原来用 /^类定义 — (\S+)/ 从 title 里抠类名，一旦界面换成英文
    // （"Class definition — ..."）就整个失效，"保存为 .cls" 按钮会消失。
    if (r && r.meta && r.meta.cls) return r.meta.cls;
    return null;
  }

  function suggestedCls(r) {
    const cls = metaClass(r);
    return cls ? `${cls}.cls` : undefined;
  }

  /**
   * 表格结果。排序与列过滤全部在内存里做 —— 数据一次查询就拿全了，
   * 再回后端要一遍纯属浪费（还要重连、重鉴权、重等 500ms）。
   *
   * 三个状态字段：
   *   sortCol / sortDir  当前排序列与方向（0 = 未排序，回到原始顺序）
   *   filters            列下标 -> 过滤词（多列之间 AND）
   * 重绘只碰表头的指示器和 <tbody>，<thead> / <table> 结构原地不动，
   * 这样粘顶表头和横向滚动位置都不会被打断。
   */
  function renderTable(r) {
    const wrap = document.createElement('div');
    wrap.className = 'tablewrap';
    const headers = r.headers || [];
    const rows = r.rows || [];
    if (!rows.length) {
      wrap.innerHTML = `<div class="empty">${t('body.noData')}</div>`;
      return wrap;
    }
    const tbl = document.createElement('table');
    tbl.className = 'grid';

    // 选一列作为弹性列（吃掉剩余宽度），优先长文本列，避免短列占掉大块宽度。
    // 每一档是一个正则数组：词条表里的当前语言列头 + 几个兜底写法
    // （自定义 SQL 的返回列名不受我们控制，可能压根不叫「说明」）。
    const growPriority = [
      [matchHeader('hdr.table')],
      [matchHeader('hdr.note'), /desc/i],
      [matchHeader('hdr.globalPos'), /global|位/i],
    ];
    let growCol = -1;
    for (const group of growPriority) {
      const i = headers.findIndex((h) => group.some((re) => re.test(h)));
      if (i >= 0) {
        growCol = i;
        break;
      }
    }
    if (growCol < 0 && headers.length > 0) {
      // 兜底：挑平均长度最长的一列
      let best = 0;
      let bestLen = -1;
      headers.forEach((h, c) => {
        const avg =
          rows.slice(0, 30).reduce((s, r) => s + String(r[c] ?? '').length, 0) / Math.max(1, Math.min(30, rows.length));
        if (avg > bestLen) {
          bestLen = avg;
          best = c;
        }
      });
      growCol = best;
    }

    // 列类型推断（用于右对齐数字）
    const numericCols = new Set();
    for (let c = 0; c < headers.length; c++) {
      let allNum = true;
      let seen = 0;
      for (const row of rows.slice(0, 40)) {
        const v = row[c];
        if (v === '' || v === null || v === undefined) continue;
        seen++;
        if (!/^-?\d+(\.\d+)?$/.test(String(v))) {
          allNum = false;
          break;
        }
      }
      if (allNum && seen > 0) numericCols.add(c);
    }

    // 可跳转的列（Schema + 表名 组合）
    const iSchema = headers.findIndex((h) => /^schema$/i.test(h));
    const iTable = headers.findIndex((h) => matchHeader('hdr.table').test(h));

    // 若第一列本身就是 "#"，不再额外加行号列，避免出现两个 #
    const hasOwnIndex = headers.length > 0 && /^#$/.test(headers[0]);
    const jumpable = iSchema >= 0 && iTable >= 0;

    /** 单元格 class：一次性算好，重绘时直接复用，不重复跑正则 */
    const cellClass = headers.map((h, c) =>
      [
        /^pk$/i.test(h) ? 'pk' : '',
        numericCols.has(c) ? 'num' : '',
        /^#$/.test(h) ? 'col-idx' : '',
        c === growCol ? 'grow' : '',
        matchHeader('hdr.globalPos').test(h) || /global|位置/i.test(h) ? 'mono' : '',
        MONO_HEADERS.some((k) => matchHeader(k).test(h)) ? 'mono' : '',
      ]
        .filter(Boolean)
        .join(' ')
    );

    const state = { sortCol: -1, sortDir: 0, filters: {} };

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    if (!hasOwnIndex) {
      const thIdx = document.createElement('th');
      thIdx.className = 'col-idx';
      thIdx.textContent = '#';
      trh.appendChild(thIdx);
    }

    // 表头：列名 + 双三角排序指示器，整体可点；下方嵌一行列过滤输入框
    const thList = [];
    const inputs = [];
    headers.forEach((h, c) => {
      const th = document.createElement('th');
      // sortable 是排序行为的钩子（同时给样式定位），其余是既有列修饰
      th.className = 'sortable' + (c === growCol ? ' grow' : '') + (/^pk$/i.test(h) ? ' col-pk' : '');
      th.dataset.col = String(c);
      th.title = t('table.sortTip');

      const bar = document.createElement('div');
      bar.className = 'th-bar';
      const label = document.createElement('span');
      label.className = 'th-label';
      label.textContent = h;
      const ind = document.createElement('span');
      ind.className = 'th-sort';
      ind.innerHTML = '<i>▲</i><i>▼</i>';
      bar.appendChild(label);
      bar.appendChild(ind);

      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'col-filter';
      inp.placeholder = t('table.filterPlaceholder');
      inp.dataset.col = String(c);
      inp.spellcheck = false;

      th.appendChild(bar);
      th.appendChild(inp);
      trh.appendChild(th);
      thList.push(th);
      inputs.push(inp);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);

    // ---- 排序 / 过滤（纯内存）

    const isEmpty = (v) => v === '' || v === null || v === undefined;

    /** 参与比较的值：空值返回 null（排版末尾），其余统一成字符串/N 比较 */
    function sortKey(v) {
      return isEmpty(v) ? null : v;
    }

    function compare(a, b) {
      const c = state.sortCol;
      const ka = sortKey(a.row[c]);
      const kb = sortKey(b.row[c]);
      // 空值恒排末尾（两个都是空值时按原始顺序）
      if (ka === null && kb === null) return a.i - b.i;
      if (ka === null) return 1;
      if (kb === null) return -1;
      let d;
      if (numericCols.has(c)) {
        const na = Number(ka);
        const nb = Number(kb);
        d = Number.isFinite(na) && Number.isFinite(nb)
          ? na - nb
          : String(ka).localeCompare(String(kb), 'zh');
      } else {
        d = String(ka).localeCompare(String(kb), 'zh');
      }
      // 相等时退回原始顺序，保证排序稳定、多次点击不会乱跳
      return d !== 0 ? d * state.sortDir : a.i - b.i;
    }

    function visible() {
      const words = Object.keys(state.filters)
        .map((c) => [Number(c), String(state.filters[c]).trim().toLowerCase()])
        .filter(([, w]) => w);
      let out = rows.map((row, i) => ({ row, i }));
      if (words.length) {
        out = out.filter((it) =>
          words.every(([c, w]) => {
            const v = it.row[c];
            return !isEmpty(v) && String(v).toLowerCase().includes(w);
          })
        );
      }
      if (state.sortCol >= 0 && state.sortDir !== 0) out.sort(compare);
      return out;
    }

    /** 只重绘 tbody + 表头指示器，thead/table 原地不动 */
    function paint() {
      const list = visible();
      const html = list.map((it, n) => {
        const row = it.row;
        // 重绘必须把 data-jump 写回去：行点击是委托在父容器上的（见 renderResult），
        // 一旦丢了属性，排完序再点行就静默失效。
        const attrs = jumpable
          ? ` class="clickable" data-jump="${escAttr(JSON.stringify([row[iSchema], row[iTable]]))}" title="${t('table.jumpTip')}"`
          : '';
        const cells = hasOwnIndex
          ? []
          : [`<td class="col-idx">${n + 1}</td>`];
        headers.forEach((h, c) => {
          const v = row[c];
          const text = isEmpty(v) ? (/^pk$/i.test(h) ? '' : '—') : String(v);
          const cls = [cellClass[c], isEmpty(v) ? 'null' : ''].filter(Boolean).join(' ');
          cells.push(`<td class="${cls}" title="${escAttr(text)}">${esc(text)}</td>`);
        });
        return `<tr${attrs}>${cells.join('')}</tr>`;
      });
      tbody.innerHTML =
        html.join('') ||
        `<tr><td class="grid-empty" colspan="${headers.length + (hasOwnIndex ? 0 : 1)}">${t('body.noMatch')}</td></tr>`;

      thList.forEach((th, c) => {
        th.classList.toggle('sort-asc', c === state.sortCol && state.sortDir === 1);
        th.classList.toggle('sort-desc', c === state.sortCol && state.sortDir === -1);
        th.classList.toggle('filtered', !!String(state.filters[c] || '').trim());
      });
      // 行数跟着过滤走：没过滤显示「5 行」，过滤后显示「2 / 5 行」
      if (lastRowCount !== null) {
        lastRowCount = list.length;
        updateElapsed();
      }
    }

    trh.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      const th = e.target.closest('th.sortable');
      if (!th) return;
      const c = Number(th.dataset.col);
      if (state.sortCol !== c) {
        state.sortCol = c;
        state.sortDir = 1;
      } else {
        state.sortDir = state.sortDir === 1 ? -1 : state.sortDir === -1 ? 0 : 1;
        if (state.sortDir === 0) state.sortCol = -1;
      }
      paint();
    });

    inputs.forEach((inp) => {
      // 点输入框不能冒泡到 th，否则每按一下就顺带排一次序
      inp.addEventListener('click', (e) => e.stopPropagation());
      inp.addEventListener('mousedown', (e) => e.stopPropagation());
      inp.addEventListener('input', () => {
        state.filters[inp.dataset.col] = inp.value;
        paint();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          inp.value = '';
          delete state.filters[inp.dataset.col];
          paint();
        }
      });
    });

    paint();

    // 把「当前可见行」暴露出去，导出 CSV 时按这个顺序导，跟用户看到的一致
    wrap.__visibleRows = () => visible().map((it) => it.row);
    return wrap;
  }

  function renderCode(code) {
    const pre = document.createElement('pre');
    pre.className = 'code';
    pre.textContent = code;
    return pre;
  }

  function renderKv(items) {
    const dl = document.createElement('dl');
    dl.className = 'kv';
    dl.innerHTML = items
      .map((it) => `<dt>${esc(it.k)}</dt><dd>${esc(it.v)}</dd>`)
      .join('');
    return dl;
  }

  function renderSections(meta) {
    const frag = document.createDocumentFragment();

    const idx = meta.indexes;
    if (idx && idx.rows && idx.rows.length) {
      const sec = document.createElement('div');
      sec.className = 'section';
      const notes = (idx.notes || []).map((n) => `<li>⚠ ${esc(n)}</li>`).join('');
      sec.innerHTML =
        `<h3>${t('table.indexTitle', idx.rows.length)}　${t('table.storage', esc(idx.storage || '-'))}　${idx.kind === 'sql' ? t('table.kindSql') : t('table.kindDefault')}</h3>` +
        `<div class="body"><ul>` +
        idx.rows
          .map((r) => `<li><b>${esc(r.name)}</b>　<span class="muted" style="font-family:monospace">${esc(r.structure)}</span></li>`)
          .join('') +
        notes +
        `</ul></div>`;
      frag.appendChild(sec);
    }

    const fks = meta.foreignKeys || [];
    const rels = meta.relationships || [];
    if (fks.length || rels.length) {
      const sec = document.createElement('div');
      sec.className = 'section';
      const fkList = fks
        .map((f) => `<li><b>${esc(f.name)}</b>　(${esc(f.prop)}) → ${esc(f.ref)}</li>`)
        .join('');
      const relList = rels.length
        ? `<li class="muted">Relationship：${rels.map((r) => `${esc(r.prop)} → ${esc(r.ref)}`).join('；')}</li>`
        : '';
      sec.innerHTML =
        `<h3>${t('table.fkTitle', fks.length, rels.length)}</h3>` +
        `<div class="body"><ul>${fkList || `<li class="muted">${t('table.noFk')}</li>`}${relList}</ul></div>`;
      frag.appendChild(sec);
    }
    return frag;
  }

  function renderMermaid(r) {
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-wrap';
    // 把注释（-- 开头）摘出来单独显示，mermaid 不认 SQL 风格注释
    const lines = (r.mermaid || '').split('\n');
    const diagram = lines.filter((l) => !l.trim().startsWith('--')).join('\n');
    const notes = lines.filter((l) => l.trim().startsWith('--')).map((l) => l.replace(/^\s*--\s?/, ''));

    const holder = document.createElement('div');
    holder.className = 'mermaid';
    holder.textContent = diagram;
    wrap.appendChild(holder);

    if (notes.length) {
      const sec = document.createElement('div');
      sec.className = 'section';
      sec.style.margin = '16px 0 0';
      sec.innerHTML = `<h3>${t('table.globalTitle')}</h3><div class="body"><pre class="code" style="padding:0">${esc(notes.join('\n'))}</pre></div>`;
      wrap.appendChild(sec);
    }

    loadMermaid()
      .then((mermaid) => {
        const dark =
          document.body.classList.contains('vscode-dark') ||
          document.body.classList.contains('vscode-high-contrast');
        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        });
        return mermaid.render('erm' + Date.now(), diagram);
      })
      .then((out) => {
        holder.innerHTML = out.svg;
        applyTypeAliases(holder, (r.meta && r.meta.typeAliases) || {});
      })
      .catch((e) => {
        // 之前这里一律说"可能是离线环境"，但真正失败最常见的原因是 mermaid 语法。
        // 离线只是一种可能，把 err.message 原文露出来才查得动。
        const msg = (e && (e.message || e.str || String(e))) || t('common.unknownError');
        holder.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'err';
        box.textContent = `${t('mermaid.failed', msg)}`;
        holder.appendChild(box);

        // 是解析错误就明说"离线"不是原因，省得往网络方向排查
        const hint = document.createElement('div');
        hint.className = 'muted';
        hint.style.margin = '8px 0';
        hint.textContent = /parse error|expecting|lexical/i.test(msg)
          ? t('mermaid.syntaxHint')
          : t('mermaid.offlineHint');
        holder.appendChild(hint);

        const pre = document.createElement('pre');
        pre.className = 'code';
        pre.textContent = diagram;
        holder.appendChild(pre);
      });

    return wrap;
  }

  /**
   * ER 图里引用类型的点号会被拍平（User.SSUser → User_SSUser，mermaid 词法不认点），
   * 这里把原名挂到属性单元格的 title 上，鼠标停上去能看到原始类型。
   * mermaid 的 ER 属性文字是 <text class="er entityLabel">类型 名字</text>，按首 token 匹配即可。
   */
  function applyTypeAliases(holder, aliases) {
    if (!aliases || !Object.keys(aliases).length) return;
    for (const el of holder.querySelectorAll('text')) {
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      const flat = txt.split(/\s+/)[0];
      if (aliases[flat]) el.setAttribute('title', `${t('table.originalType', aliases[flat])}`);
    }
  }

  let mermaidPromise = null;
  function loadMermaid() {
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = new Promise((resolve, reject) => {
      // 优先用扩展自带的本地 mermaid（page 里已通过 <script src> 加载）
      if (window.mermaid) {
        resolve(window.mermaid);
        return;
      }
      // 兜底：本地文件意外缺失时才走 CDN（内网环境通常会失败）
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
      s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error(t('toast.mermaidNotReady'))));
      s.onerror = () => reject(new Error(t('toast.mermaidLoadFailed')));
      document.head.appendChild(s);
    });
    return mermaidPromise;
  }

  /**
   * 导出 CSV。优先导「当前可见行」——用户刚过滤/排序完就点导出，
   * 期待拿到的是屏幕上这份，而不是被过滤掉的全量。
   */
  function exportCsv(r, wrap) {
    const q = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
    const rows = wrap && wrap.__visibleRows ? wrap.__visibleRows() : r.rows || [];
    const lines = [(r.headers || []).map(q).join(',')].concat(rows.map((row) => row.map(q).join(',')));
    vscode.postMessage({ type: 'copy', text: '\uFEFF' + lines.join('\r\n') });
    toast(rows.length === (r.rows || []).length ? t('toast.csvCopied', rows.length) : t('toast.csvCopiedVisible', rows.length));
  }

  // ------------------------------------------------------------ 错误 / 提示

  function renderError(text, candidates) {
    el.elapsed.textContent = '';
    const box = document.createElement('div');
    box.className = 'err';
    box.textContent = '✕ ' + text;
    if (candidates && candidates.length) {
      const ul = document.createElement('ul');
      ul.className = 'candidates';
      candidates.slice(0, 12).forEach((c) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.textContent = `${c.schema}.${c.table}`;
        b.onclick = () => {
          el.keyword.value = `${c.schema}.${c.table}`;
          run();
        };
        li.appendChild(b);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    el.result.innerHTML = '';
    el.result.appendChild(box);
  }

  let toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2200);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    return esc(s).replace(/'/g, '&#39;');
  }

  // 通知扩展：页面就绪
  vscode.postMessage({ type: 'ready' });
})();
