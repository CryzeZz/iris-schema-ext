/**
 * 界面文案的中英双语表。
 *
 * 语言跟随 VS Code 界面语言：`vscode.env.language` 以 `zh` 开头时用中文，
 * 其余一律用英文。这样中文用户和英文用户装同一个包就能各自看到母语，
 * 也不需要额外的设置项。
 *
 * 为什么不直接用 VS Code 官方的 nls 机制（package.nls.json + vscode.l10n.t）：
 * - nls 的翻译由 UI 语言驱动，无法在运行时切换，也拿不到「当前语言」给 webview 用；
 * - 本插件的绝大部分界面在 webview（panel.js）里，那一层跑在浏览器上下文，
 *   只能靠扩展侧把语言和词条一起 postMessage 过去；
 * - 一个显式的词条表能让 webview 和扩展侧共用同一份 key，改文案只改一处。
 *
 * 纯开发者注释不在这里，源码里的中文注释保持中文。
 */

export type Lang = 'zh' | 'en';

/** 词条 key。加新文案时在这里补一行，TypeScript 会强制两语言都填齐。 */
export type MsgKey =
  // ---- 通用 ----
  | 'common.rows'
  | 'common.unknownError'
  | 'common.allFiles'
  | 'common.saveClass'
  // ---- 通知 / 命令 ----
  | 'notice.noProfiles'
  | 'notice.profilesLoaded'
  | 'notice.unknownSource'
  | 'notice.copied'
  | 'notice.busy'
  // ---- 侧边栏 ----
  | 'sidebar.desc'
  | 'sidebar.connected'
  | 'sidebar.notConfigured'
  | 'sidebar.addServer'
  | 'sidebar.open'
  | 'sidebar.reload'
  | 'sidebar.hint'
  // ---- 面板：工具栏 ----
  | 'mode.describe'
  | 'mode.udl'
  | 'mode.er'
  | 'mode.sample'
  | 'toolbar.server'
  | 'toolbar.namespace'
  | 'toolbar.keywordPlaceholder'
  | 'toolbar.query'
  | 'toolbar.more'
  | 'menu.tables'
  | 'menu.findColumn'
  | 'menu.ddl'
  | 'menu.sql'
  | 'menu.test'
  // ---- 面板：SQL 栏 / 状态栏 / 占位 ----
  | 'sql.placeholder'
  | 'sql.run'
  | 'sql.close'
  | 'status.placeholder'
  | 'status.elapsed'
  | 'placeholder.title'
  | 'placeholder.sub'
  | 'placeholder.loading'
  // ---- 面板：提示与占位文案 ----
  | 'ph.describe'
  | 'ph.udl'
  | 'ph.er'
  | 'ph.sample'
  | 'ph.tables'
  | 'ph.findColumn'
  | 'ph.ddl'
  | 'ph.sql'
  | 'ph.test'
  | 'toast.noProfiles'
  | 'toast.needTable'
  | 'toast.needSql'
  | 'toast.csvCopied'
  | 'toast.csvCopiedVisible'
  | 'toast.mermaidNotReady'
  | 'toast.mermaidLoadFailed'
  // ---- 面板：无配置引导 ----
  | 'guide.noProfiles'
  | 'guide.noProfilesDetail'
  | 'guide.exampleDesc'
  | 'guide.namespaceTip'
  | 'guide.fileTip'
  | 'guide.noneOption'
  // ---- 面板：目标与操作 ----
  | 'target.fromVscode'
  | 'target.fromFile'
  | 'target.account'
  | 'target.config'
  | 'act.openInEditor'
  | 'act.saveCls'
  | 'act.exportCsv'
  | 'act.copy'
  | 'body.noResult'
  | 'body.noData'
  | 'body.noMatch'
  // ---- 面板：表格 ----
  | 'table.sortTip'
  | 'table.filterPlaceholder'
  | 'table.jumpTip'
  | 'table.indexTitle'
  | 'table.storage'
  | 'table.kindSql'
  | 'table.kindDefault'
  | 'table.fkTitle'
  | 'table.noFk'
  | 'table.globalTitle'
  | 'table.originalType'
  // ---- 面板：mermaid 失败 ----
  | 'mermaid.failed'
  | 'mermaid.syntaxHint'
  | 'mermaid.offlineHint'
  // ---- 结果标题（由扩展侧拼接）----
  | 'res.tablesTitle'
  | 'res.tablesSub'
  | 'res.tablesSubKeyword'
  | 'res.colsTitle'
  | 'res.colsSub'
  | 'res.ddlTitle'
  | 'res.ddlSub'
  | 'res.erTitle'
  | 'res.erEdges'
  | 'res.erNoEdges'
  | 'res.sampleTitle'
  | 'res.nsTitle'
  | 'res.udlTitle'
  | 'res.udlSub'
  | 'res.udlHintClass'
  | 'res.udlHintGlobal'
  | 'res.udlHintRows'
  | 'res.udlSubDetail'
  | 'res.sqlTitle'
  | 'res.testTitle'
  | 'res.testTarget'
  | 'res.testNamespace'
  | 'res.testUser'
  | 'res.testProbe'
  // ---- 列头 ----
  | 'hdr.schema'
  | 'hdr.table'
  | 'hdr.type'
  | 'hdr.column'
  | 'hdr.length'
  | 'hdr.namespace'
  | 'hdr.no'
  | 'hdr.propName'
  | 'hdr.propType'
  | 'hdr.fieldName'
  | 'hdr.pk'
  | 'hdr.note'
  | 'hdr.globalPos'
  // ---- 错误信息（扩展侧抛出给前端展示）----
  | 'err.needClass'
  | 'err.tableAmbiguous'
  | 'err.tableNotFound'
  | 'err.selectOnly'
  | 'err.singleStatement'
  | 'err.readOnly'
  | 'err.needColumnKeyword'
  | 'err.needSql'
  | 'err.unsupportedOp'
  | 'err.noProfile'
  | 'err.noWebPort'
  | 'err.timeout'
  | 'err.emptyContent'
  | 'err.classMissing'
  | 'err.classMissingHint'
  | 'err.sqlFailed'
  | 'err.sqlEmpty'
  | 'err.locateClass'
  | 'err.noClassForTable';

/** 词条表。两个语言必须同时覆盖全部 key（由 Record<MsgKey, string> 保证）。 */
const ZH: Record<MsgKey, string> = {
  'common.rows': '行',
  'common.unknownError': '未知错误',
  'common.allFiles': '所有文件',
  'common.saveClass': '保存类定义',

  'notice.noProfiles': '未找到连接配置：在 VS Code 设置里添加 intersystems.servers，或创建 ~/.iris-schema.json',
  'notice.profilesLoaded': '已加载 {0} 个连接（{1}）',
  'notice.unknownSource': '未知来源',
  'notice.copied': '已复制到剪贴板',
  'notice.busy': '上一次查询还在进行中…',

  'sidebar.desc': '浏览表结构、类定义、ER 图，并采样表数据。',
  'sidebar.connected': '已读取 {0} 个连接',
  'sidebar.notConfigured': '未找到连接配置',
  'sidebar.addServer': '在 settings.json 里添加 <code>intersystems.servers</code>',
  'sidebar.open': '打开查询面板',
  'sidebar.reload': '重新加载连接配置',
  'sidebar.hint': '也可以在任意 <code>.cls</code> 文件里点编辑器标题栏的图标。',

  'mode.describe': '表结构',
  'mode.udl': '类定义',
  'mode.er': 'ER 图',
  'mode.sample': '数据',
  'toolbar.server': '服务器',
  'toolbar.namespace': '命名空间',
  'toolbar.keywordPlaceholder': '表名 / 类名，如 SQLUser.Patient',
  'toolbar.query': '查询',
  'toolbar.more': '更多查询',
  'menu.tables': '列出全部表',
  'menu.findColumn': '按列名找表',
  'menu.ddl': '生成建表 DDL',
  'menu.sql': '自由 SQL',
  'menu.test': '测试连接',

  'sql.placeholder': '-- 仅支持 SELECT / WITH 只读查询\nSELECT TOP 50 * FROM SQLUser.Patient',
  'sql.run': '执行',
  'sql.close': '收起',
  'status.placeholder': '—',
  'status.elapsed': '{0} ms',
  'placeholder.title': '结果',
  'placeholder.sub': '选择服务器与命名空间，填入表名后点击「查询」',
  'placeholder.loading': '查询中…',

  'ph.describe': '表名 / 类名，如 SQLUser.Patient',
  'ph.udl': '类名，如 HS.BL.Patient',
  'ph.er': '表名，如 SQLUser.Patient',
  'ph.sample': '表名，取前 N 行',
  'ph.tables': '可为空，或输入表名关键字',
  'ph.findColumn': '列名关键字，如 UpdateDate',
  'ph.ddl': '表名，生成 CREATE TABLE',
  'ph.sql': '在下方输入 SQL',
  'ph.test': '可为空，直接测试连接',
  'toast.noProfiles': '没有可用的连接配置',
  'toast.needTable': '请填写表名 / 类名',
  'toast.needSql': '请输入 SQL',
  'toast.csvCopied': 'CSV 已复制（{0} 行）',
  'toast.csvCopiedVisible': 'CSV 已复制（当前可见 {0} 行）',
  'toast.mermaidNotReady': 'mermaid 未就绪',
  'toast.mermaidLoadFailed': '加载 mermaid 失败',

  'guide.noProfiles': '未找到连接配置。',
  'guide.noProfilesDetail': '这是个 VS Code 扩展，优先读 VS Code 设置里的 <b>intersystems.servers</b>（装了 InterSystems 插件后由 Server Manager 维护）。在 <b>settings.json</b> 里加一段即可：',
  'guide.exampleDesc': '开发库',
  'guide.namespaceTip': '命名空间可在条目里加 <b>"namespace": "APP"</b>，不写则默认 <b>%SYS</b>（下次会记住你选过的库）。',
  'guide.fileTip': '也支持 <b>~/.iris-schema.json</b>（与 iris-schema 技能共用），两边同名时以 VS Code 设置为准。',
  'guide.noneOption': '无连接配置',

  'target.fromVscode': '来自 VS Code 设置 intersystems.servers',
  'target.fromFile': '来自配置文件',
  'target.account': '账号',
  'target.config': '配置',
  'act.openInEditor': '在编辑器中打开',
  'act.saveCls': '保存为 .cls',
  'act.exportCsv': '导出 CSV',
  'act.copy': '复制',
  'body.noResult': '无结果',
  'body.noData': '没有数据',
  'body.noMatch': '没有匹配的行',

  'table.sortTip': '点击排序：升序 / 降序 / 取消',
  'table.filterPlaceholder': '过滤',
  'table.jumpTip': '点击查看表结构',
  'table.indexTitle': '索引（{0}）',
  'table.storage': '存储 {0}',
  'table.kindSql': '自定义 SQL 存储',
  'table.kindDefault': '默认存储',
  'table.fkTitle': '外键 / 关系（{0} 个外键，{1} 个关系）',
  'table.noFk': '无显式 ForeignKey',
  'table.globalTitle': 'Global 位置',
  'table.originalType': '原类型：{0}',

  'mermaid.failed': 'Mermaid 渲染失败：{0}',
  'mermaid.syntaxHint': '这是图定义语法错误，与网络无关。',
  'mermaid.offlineHint': '图和脚本都是本地打包的，离线不影响渲染；若这里报加载失败，说明扩展文件缺失。',

  'res.tablesTitle': '表清单（{0}{1}）',
  'res.tablesSub': '点击任意行可直接查看表结构',
  'res.tablesSubKeyword': '关键字：{0}　·　点击任意行可直接查看表结构',
  'res.colsTitle': '包含「{0}」的列（{1}）',
  'res.colsSub': '点击任意行可跳到对应表结构',
  'res.ddlTitle': '建表 DDL — {0}.{1}',
  'res.ddlSub': '类定义 {0}（{1} 行）',
  'res.erTitle': 'ER 图 — {0}.{1}',
  'res.erEdges': '{0} 条引用关系',
  'res.erNoEdges': '该类没有外键、父子关系或跨类引用',
  'res.sampleTitle': '{0}.{1} 前 {2} 行',
  'res.nsTitle': '命名空间（{0}）',
  'res.udlTitle': '类定义 — {0}',
  'res.udlSub': '{0}.{1}　·　{2} 行',
  'res.udlHintClass': '-- 类定义：{0}',
  'res.udlHintGlobal': '-- 数据 Global：{0}',
  'res.udlHintRows': '-- 字段 Global 位置（{0} 列）',
  'res.udlSubDetail': '类定义 {0}　·　存储 {1}　·　数据 Global {2}',
  'res.sqlTitle': '查询结果（{0} 行）',
  'res.testTitle': '连接正常',
  'res.testTarget': '目标',
  'res.testNamespace': '命名空间',
  'res.testUser': '账号',
  'res.testProbe': '探测结果',

  'hdr.schema': 'Schema',
  'hdr.table': '表名',
  'hdr.type': '类型',
  'hdr.column': '列名',
  'hdr.length': '长度',
  'hdr.namespace': '命名空间',
  'hdr.no': '#',
  'hdr.propName': '属性名',
  'hdr.propType': '属性类型',
  'hdr.fieldName': '字段名',
  'hdr.pk': 'PK',
  'hdr.note': '说明',
  'hdr.globalPos': 'Global位置',

  'err.needClass': '请填写表结构名（可写 SQLUser.Patient 或 Patient）',
  'err.tableAmbiguous': '表名不唯一，找到 {0} 个候选：',
  'err.tableNotFound': '未找到表 {0}.{1}（可勾选"模糊搜索"按关键字找）',
  'err.selectOnly': '只允许 SELECT / WITH 查询',
  'err.singleStatement': '只允许单条语句',
  'err.readOnly': '只允许只读查询',
  'err.needColumnKeyword': '请填写列名关键字',
  'err.needSql': '请输入 SQL',
  'err.unsupportedOp': '不支持的操作：{0}',
  'err.noProfile': '未找到连接配置。请在 VS Code 设置里添加 intersystems.servers（Server Manager），或在用户目录创建 ~/.iris-schema.json。',
  'err.noWebPort': '未配置 web_port（IRIS Web 网关端口）',
  'err.timeout': '请求超时 ({0}ms): {1}',
  'err.emptyContent': 'Atelier 返回空内容: {0}（类名 {1}，检查命名空间/权限）',
  'err.classMissing': '类 {0} 在命名空间 {1} 中不存在',
  'err.classMissingHint': '{0} （类名 {1}，检查 web_port/命名空间/账号权限）',
  'err.sqlFailed': 'SQL 执行失败: {0}',
  'err.sqlEmpty': 'SQL 返回结果为空',
  'err.locateClass': '定位类定义失败（{0}.{1}）：{2}',
  'err.noClassForTable': '未找到表 {0}.{1} 对应的类定义（确认表名或 schema 是否正确）',
};

const EN: Record<MsgKey, string> = {
  'common.rows': 'rows',
  'common.unknownError': 'Unknown error',
  'common.allFiles': 'All files',
  'common.saveClass': 'Save class definition',

  'notice.noProfiles': 'No connection found: add intersystems.servers in VS Code settings, or create ~/.iris-schema.json',
  'notice.profilesLoaded': 'Loaded {0} connection(s) from {1}',
  'notice.unknownSource': 'unknown source',
  'notice.copied': 'Copied to clipboard',
  'notice.busy': 'A previous query is still running…',

  'sidebar.desc': 'Browse table structures, class definitions and ER diagrams, and sample table data.',
  'sidebar.connected': '{0} connection(s) loaded',
  'sidebar.notConfigured': 'No connection configured',
  'sidebar.addServer': 'Add <code>intersystems.servers</code> in settings.json',
  'sidebar.open': 'Open query panel',
  'sidebar.reload': 'Reload connections',
  'sidebar.hint': 'You can also click the icon in the editor title bar of any <code>.cls</code> file.',

  'mode.describe': 'Columns',
  'mode.udl': 'Class',
  'mode.er': 'ER diagram',
  'mode.sample': 'Data',
  'toolbar.server': 'Server',
  'toolbar.namespace': 'Namespace',
  'toolbar.keywordPlaceholder': 'Table / class name, e.g. SQLUser.Patient',
  'toolbar.query': 'Query',
  'toolbar.more': 'More queries',
  'menu.tables': 'List all tables',
  'menu.findColumn': 'Find tables by column',
  'menu.ddl': 'Generate CREATE TABLE DDL',
  'menu.sql': 'Free-form SQL',
  'menu.test': 'Test connection',

  'sql.placeholder': '-- Read-only: SELECT / WITH only\nSELECT TOP 50 * FROM SQLUser.Patient',
  'sql.run': 'Run',
  'sql.close': 'Hide',
  'status.placeholder': '—',
  'status.elapsed': '{0} ms',
  'placeholder.title': 'Results',
  'placeholder.sub': 'Pick a server and namespace, enter a table name, then click Query',
  'placeholder.loading': 'Querying…',

  'ph.describe': 'Table / class name, e.g. SQLUser.Patient',
  'ph.udl': 'Class name, e.g. HS.BL.Patient',
  'ph.er': 'Table name, e.g. SQLUser.Patient',
  'ph.sample': 'Table name, returns the first N rows',
  'ph.tables': 'Optional, or a table name keyword',
  'ph.findColumn': 'Column keyword, e.g. UpdateDate',
  'ph.ddl': 'Table name, generates CREATE TABLE',
  'ph.sql': 'Enter SQL below',
  'ph.test': 'Optional, tests the connection directly',
  'toast.noProfiles': 'No connection available',
  'toast.needTable': 'Enter a table / class name',
  'toast.needSql': 'Enter SQL',
  'toast.csvCopied': 'CSV copied ({0} rows)',
  'toast.csvCopiedVisible': 'CSV copied ({0} visible rows)',
  'toast.mermaidNotReady': 'mermaid is not ready',
  'toast.mermaidLoadFailed': 'Failed to load mermaid',

  'guide.noProfiles': 'No connection configured.',
  'guide.noProfilesDetail': 'This is a VS Code extension, so it reads <b>intersystems.servers</b> from your VS Code settings first (maintained by Server Manager once the InterSystems extension is installed). Add an entry in <b>settings.json</b>:',
  'guide.exampleDesc': 'Development',
  'guide.namespaceTip': 'Add <b>"namespace": "APP"</b> to the entry to pin a namespace; defaults to <b>%SYS</b> (your last choice is remembered).',
  'guide.fileTip': '<b>~/.iris-schema.json</b> is also supported (shared with the iris-schema skill); on conflicts VS Code settings win.',
  'guide.noneOption': 'No connections',

  'target.fromVscode': 'from VS Code settings intersystems.servers',
  'target.fromFile': 'from config file',
  'target.account': 'user',
  'target.config': 'config',
  'act.openInEditor': 'Open in editor',
  'act.saveCls': 'Save as .cls',
  'act.exportCsv': 'Export CSV',
  'act.copy': 'Copy',
  'body.noResult': 'No result',
  'body.noData': 'No data',
  'body.noMatch': 'No matching rows',

  'table.sortTip': 'Click to sort: ascending / descending / off',
  'table.filterPlaceholder': 'Filter',
  'table.jumpTip': 'Click to view table structure',
  'table.indexTitle': 'Indexes ({0})',
  'table.storage': 'storage {0}',
  'table.kindSql': 'custom SQL storage',
  'table.kindDefault': 'default storage',
  'table.fkTitle': 'Foreign keys / relations ({0} FKs, {1} relations)',
  'table.noFk': 'No explicit ForeignKey',
  'table.globalTitle': 'Global locations',
  'table.originalType': 'Original type: {0}',

  'mermaid.failed': 'Mermaid render failed: {0}',
  'mermaid.syntaxHint': 'This is a syntax error in the diagram definition, unrelated to the network.',
  'mermaid.offlineHint': 'Both the diagram and the script are bundled locally, so being offline does not matter. A load failure here means extension files are missing.',

  'res.tablesTitle': 'Tables ({0}{1})',
  'res.tablesSub': 'Click any row to view its table structure',
  'res.tablesSubKeyword': 'Keyword: {0}　·　Click any row to view its table structure',
  'res.colsTitle': 'Columns matching "{0}" ({1})',
  'res.colsSub': 'Click any row to jump to its table structure',
  'res.ddlTitle': 'CREATE TABLE DDL — {0}.{1}',
  'res.ddlSub': 'class {0} ({1} lines)',
  'res.erTitle': 'ER diagram — {0}.{1}',
  'res.erEdges': '{0} reference relation(s)',
  'res.erNoEdges': 'This class has no foreign keys, parent/child relations or cross-class references',
  'res.sampleTitle': 'First {2} rows of {0}.{1}',
  'res.nsTitle': 'Namespaces ({0})',
  'res.udlTitle': 'Class definition — {0}',
  'res.udlSub': '{0}.{1}　·　{2} lines',
  'res.udlHintClass': '-- Class definition: {0}',
  'res.udlHintGlobal': '-- Data global: {0}',
  'res.udlHintRows': '-- Field global locations ({0} columns)',
  'res.udlSubDetail': 'class {0}　·　storage {1}　·　data global {2}',
  'res.sqlTitle': 'Query result ({0} rows)',
  'res.testTitle': 'Connection OK',
  'res.testTarget': 'Target',
  'res.testNamespace': 'Namespace',
  'res.testUser': 'User',
  'res.testProbe': 'Probe',

  'hdr.schema': 'Schema',
  'hdr.table': 'Table',
  'hdr.type': 'Type',
  'hdr.column': 'Column',
  'hdr.length': 'Length',
  'hdr.namespace': 'Namespace',
  'hdr.no': '#',
  'hdr.propName': 'Property',
  'hdr.propType': 'Prop type',
  'hdr.fieldName': 'Field',
  'hdr.pk': 'PK',
  'hdr.note': 'Note',
  'hdr.globalPos': 'Global location',

  'err.needClass': 'Enter a table name (SQLUser.Patient or just Patient)',
  'err.tableAmbiguous': 'Table name is ambiguous, {0} candidates found: ',
  'err.tableNotFound': 'Table {0}.{1} not found (enable fuzzy search to look up by keyword)',
  'err.selectOnly': 'Only SELECT / WITH queries are allowed',
  'err.singleStatement': 'Only a single statement is allowed',
  'err.readOnly': 'Only read-only queries are allowed',
  'err.needColumnKeyword': 'Enter a column keyword',
  'err.needSql': 'Enter SQL',
  'err.unsupportedOp': 'Unsupported operation: {0}',
  'err.noProfile': 'No connection configured. Add intersystems.servers (Server Manager) in VS Code settings, or create ~/.iris-schema.json in your home directory.',
  'err.noWebPort': 'web_port is not configured (IRIS web gateway port)',
  'err.timeout': 'Request timed out ({0}ms): {1}',
  'err.emptyContent': 'Atelier returned empty content: {0} (class {1}, check namespace/permissions)',
  'err.classMissing': 'Class {0} does not exist in namespace {1}',
  'err.classMissingHint': '{0} (class {1}, check web_port/namespace/account permissions)',
  'err.sqlFailed': 'SQL execution failed: {0}',
  'err.sqlEmpty': 'SQL returned an empty result',
  'err.locateClass': 'Failed to locate class definition ({0}.{1}): {2}',
  'err.noClassForTable': 'No class definition found for table {0}.{1} (check the table name or schema)',
};

const TABLES: Record<Lang, Record<MsgKey, string>> = { zh: ZH, en: EN };

let current: Lang = 'en';

/** 由 extension.ts 在 activate 时调用一次。 */
export function setLanguage(lang: Lang): void {
  current = lang;
}

export function getLanguage(): Lang {
  return current;
}

/** 从 VS Code 的语言标识推断：`zh-cn` / `zh-tw` 都用中文，其余用英文。 */
export function detectLanguage(vscodeLanguage: string | undefined): Lang {
  return String(vscodeLanguage || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * 取词条。占位符写 `{0}` `{1}`，按位置替换。
 * 缺失的 key 会直接返回 key 本身，方便一眼看出漏翻。
 */
export function t(key: MsgKey, ...args: (string | number)[]): string {
  const table = TABLES[current] || EN;
  let s: string = table[key] ?? ZH[key] ?? key;
  args.forEach((a, i) => {
    s = s.split(`{${i}}`).join(String(a));
  });
  return s;
}

/** 把整张表按当前语言导出，供 webview 使用。 */
export function allMessages(): Record<string, string> {
  return TABLES[current] || EN;
}
