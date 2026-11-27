/**
 * 把 iris-schema 技能的各个查询命令，包装成 Webview 可直接调用的操作。
 *
 * 对应关系（技能命令 -> 这里的 op）：
 *   describe   -> 'describe'    表结构（列/类型/长度/PK/说明/Global 位置 + 索引 + 外键）
 *   udl        -> 'udl'         类定义源码
 *   er         -> 'er'          ER 图（Mermaid）+ 关系明细
 *   sample     -> 'sample'      TOP N 数据
 *   tables     -> 'tables'      表清单
 *   find-column-> 'findColumn'  按列名找表
 *   ddl        -> 'ddl'         建表 DDL
 *   sql        -> 'sql'         自由只读 SQL
 *   namespaces -> 'namespaces'  命名空间列表
 */

import {
  ConnConfig,
  namespaces,
  parseClassSchema,
  postQuery,
  resolveClass,
  searchTables,
  fetchClassUdl,
} from './irisClient';

export type OpName =
  | 'describe'
  | 'udl'
  | 'er'
  | 'sample'
  | 'tables'
  | 'findColumn'
  | 'ddl'
  | 'sql'
  | 'namespaces'
  | 'test';

export interface OpRequest {
  op: OpName;
  schema?: string;
  table?: string;
  keyword?: string;
  sql?: string;
  limit?: number;
}

const SYSTEM_SCHEMA_HINTS = ['%', 'INFORMATION_SCHEMA', 'SECURITY', 'DOCDB'];

function isSystemSchema(s: string): boolean {
  const u = (s || '').toUpperCase();
  return SYSTEM_SCHEMA_HINTS.some((h) => u.startsWith(h));
}

/**
 * 定位表：解析 "schema.table" / "table" 写法。
 * 优先按 schema.table，其次在非系统 schema 里找唯一命中。
 */
export async function locate(
  cfg: ConnConfig,
  name: string,
  fallbackSchema?: string
): Promise<{ schema: string; table: string; cls: string | null }> {
  const raw = (name || '').trim().replace(/^"|"$/g, '');
  if (!raw) throw new Error('请填写表机构名（可写 SQLUser.Patient 或 Patient）');

  let schema = '';
  let table = '';
  if (raw.includes('.')) {
    const i = raw.indexOf('.');
    schema = raw.slice(0, i);
    table = raw.slice(i + 1);
  } else {
    table = raw;
    schema = fallbackSchema || 'SQLUser';
  }

  const cls = await resolveClass(cfg, schema, table);
  if (cls) return { schema, table, cls };

  // 精确名没命中：模糊找一遍，命中唯一就自动采用
  const cands = await searchTables(cfg, raw, 20);
  if (cands.length === 1) {
    return { schema: cands[0].schema, table: cands[0].table, cls: cands[0].cls };
  }
  if (cands.length > 1) {
    const exact = cands.filter(
      (c) => c.table.toLowerCase() === table.toLowerCase() && c.schema.toUpperCase() === schema.toUpperCase()
    );
    if (exact.length === 1) return { schema: exact[0].schema, table: exact[0].table, cls: exact[0].cls };
    const err: any = new Error(
      `表名不唯一，找到 ${cands.length} 个候选：` +
        cands
          .slice(0, 8)
          .map((c) => `${c.schema}.${c.table}${c.type ? `(${c.type})` : ''}`)
          .join('、')
    );
    err.candidates = cands;
    throw err;
  }
  throw new Error(`未找到表 ${schema}.${table}（可勾选"模糊搜索"按关键字找）`);
}

function assertReadonly(sql: string): void {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
  if (!/^(select|with)\b/i.test(s)) {
    throw new Error('只允许 SELECT / WITH 查询');
  }
  if (/;\s*\S/.test(s)) {
    throw new Error('只允许单条语句');
  }
  const banned = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|call|do)\b/i;
  if (banned.test(s.replace(/'[^']*'/g, "''"))) {
    throw new Error('只允许只读查询');
  }
}

/** erDiagram 实体名不能带点与下划线语义，这里拍平成安全标识。 */
function erEntity(schema: string, table: string): string {
  return `${schema}_${table}`.replace(/[^\w]/g, '_');
}

export interface OpResult {
  /** 结果区主渲染类型 */
  kind: 'table' | 'code' | 'mermaid' | 'text' | 'kv';
  title: string;
  subtitle?: string;
  /** table */
  headers?: string[];
  rows?: (string | number)[][];
  /** code */
  code?: string;
  language?: string;
  /** mermaid */
  mermaid?: string;
  /** text */
  text?: string;
  /** kv */
  items?: { k: string; v: string }[];
  meta?: Record<string, unknown>;
}

async function runTables(cfg: ConnConfig, keyword: string | undefined, limit: number, includeSystem: boolean): Promise<OpResult> {
  const like = (keyword || '').trim();
  // 系统 schema 过滤放在应用层做：SQL 里写 `NOT LIKE '%'` 在 IRIS 中对所有非空值都为假，
  // 会把结果全过滤掉（% 是通配符而非字面量）。
  const conds: string[] = [];
  if (like) {
    const esc = like.replace(/'/g, "''").toLowerCase();
    conds.push(`LOWER(TABLE_NAME) LIKE '%${esc}%'`);
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  // 多取一些，过滤掉系统 schema 后再截断到 limit
  const fetchLimit = like ? Math.max(limit * 3, 200) : Math.max(limit * 2, 500);
  const sql =
    `SELECT TOP ${fetchLimit} TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES` +
    `${where} ORDER BY TABLE_SCHEMA, TABLE_NAME`;
  const res = await postQuery(cfg, sql);
  const out: (string | number)[][] = res.rows
    .filter((r) => includeSystem || !isSystemSchema(r[0]))
    .slice(0, limit);
  return {
    kind: 'table',
    title: `表清单（${out.length}${out.length >= limit ? '+' : ''}）`,
    subtitle: like ? `关键字：${like}　·　点击任意行可直接查看表结构` : '点击任意行可直接查看表结构',
    headers: ['Schema', '表名', '类型'],
    rows: out,
  };
}

async function runFindColumn(cfg: ConnConfig, keyword: string, limit: number): Promise<OpResult> {
  const kw = (keyword || '').trim();
  if (!kw) throw new Error('请填写列名关键字');
  const esc = kw.replace(/'/g, "''").toLowerCase();
  const scan = Math.max(2001, limit);
  const sql =
    `SELECT TOP ${scan} TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH ` +
    `FROM INFORMATION_SCHEMA.COLUMNS WHERE LOWER(COLUMN_NAME) LIKE '%${esc}%' ` +
    `ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
  const res = await postQuery(cfg, sql);
  const out = res.rows.filter((r) => !isSystemSchema(r[0])).slice(0, limit);
  return {
    kind: 'table',
    title: `包含「${kw}」的列（${out.length}）`,
    subtitle: '点击任意行可跳到对应表结构',
    headers: ['Schema', '表名', '列名', '类型', '长度'],
    rows: out,
  };
}

async function runDdl(cfg: ConnConfig, schema: string, table: string): Promise<OpResult> {
  const cls = await resolveClass(cfg, schema, table);
  if (!cls) throw new Error(`未找到表 ${schema}.${table}`);
  const lines = await fetchClassUdl(cfg, cls);
  const name = `${cls.split('.').pop()}`;
  const q = await postQuery(
    cfg,
    `SELECT TOP 1 SqlTableName FROM %Dictionary.ClassDefinition WHERE Name = '${cls.replace(/'/g, "''")}'`
  );
  const sqlTable = q.rows.length && q.rows[0][0] ? q.rows[0][0] : name;
  const ddl = await buildDdl(cfg, schema, table, cls, sqlTable);
  return {
    kind: 'code',
    title: `建表 DDL — ${schema}.${sqlTable}`,
    subtitle: `类定义 ${cls}（${lines.length} 行）`,
    code: ddl,
    language: 'sql',
  };
}

/** IRIS 类型 + 长度 -> 合法 DDL 类型写法。 */
function ddlType(type: string, length: string | null | undefined): string {
  const t = (type || '').toLowerCase();
  const ln = (length || '').trim();
  // 带精度/标度的数值类型：numeric(MAXVAL, SCALE) 里存的是 "MAXVAL,SCALE"
  if (ln.includes(',')) return `${t}(${ln})`;
  switch (t) {
    case 'integer':
      return 'integer';
    case 'smallint':
      return 'smallint';
    case 'bigint':
      // IRIS 的 BIGINT 不接受长度参数
      return 'bigint';
    case 'double':
      return 'double';
    case 'date':
    case 'time':
    case 'timestamp':
    case 'bit':
      return t;
    case 'varchar':
      // varchar 必须有长度，缺省按 IRIS 的 50
      return `varchar(${ln || 50})`;
    case 'numeric':
      return ln ? `numeric(${ln})` : 'numeric';
    case 'longvarchar':
      return 'longvarchar';
    case 'longvarbinary':
      return 'longvarbinary';
    default:
      return ln ? `${t}(${ln})` : t;
  }
}

async function buildDdl(
  cfg: ConnConfig,
  schema: string,
  table: string,
  cls: string,
  sqlTable: string
): Promise<string> {
  const parsed = await parseClassSchema(cfg, schema, table, cls);
  const cols = parsed.rows.map((r) => {
    const ty = ddlType(r.type, r.length);
    return `  ${r.name.padEnd(28)} ${ty}`;
  });
  // 主键
  const pks = parsed.rows
    .filter((r) => (r.pk || '').toUpperCase().includes('PK'))
    .map((r) => r.name);
  const pkCols = pks.length ? pks : [parsed.rowidName || 'ID'];
  const pkSql = `  CONSTRAINT ${sqlTable}_PK PRIMARY KEY (${pkCols.join(', ')})`;
  const fks = parsed.foreignKeys.map((fk) => {
    // 目标类 -> schema.表
    const pkg = fk.ref.split('.').slice(0, -1).join('.');
    const refSchema = pkg === 'User' ? 'SQLUser' : pkg.replace(/\./g, '_');
    const refTable = fk.ref.split('.').pop();
    const props = fk.prop.split(',').map((x) => x.trim()).join(', ');
    return `  CONSTRAINT ${fk.name} FOREIGN KEY (${props}) REFERENCES ${refSchema}.${refTable} (RowID)`;
  });
  const body = [...cols, pkSql, ...fks].join(',\n');
  return `CREATE TABLE ${schema}.${sqlTable} (\n${body}\n)`;
}

async function runEr(cfg: ConnConfig, name: string, fallbackSchema?: string): Promise<OpResult> {
  const { schema, table, cls } = await locate(cfg, name, fallbackSchema);
  // light=true：ER 只关心图结构与主键，跳过"引用类型 -> 目标类 IdKey"的递归解析。
  // 不这么做的话，一张 ARC_Alias 就要拉 97 个类的 UDL（递归沿引用链扩散）。
  const parsed = await parseClassSchema(cfg, schema, table, cls, true);

  // Mermaid 实体里的类型/字段必须是单 token，否则整张图解析失败。
  // 实测 mermaid 10.9.8 的词法里 ATTRIBUTE_WORD 不认 `.`：
  //   `User.SSUser DPRP_UserDR` → Parse error: Expecting 'ATTRIBUTE_WORD', got '.'
  // 所以引用类型（ARCItmMast、User.SSUser）和 "list Of %String" 一律拍平成下划线。
  // 原类型名另外记在 typedName 里，渲染端 hover 能看回原名。
  const flatten = (s: string): string => s.replace(/[^\w-]/g, '_').replace(/^_+|_+$/g, '');
  // 拍平会丢包名（`User.SSUser` → `User_SSUser`），把对照关系攒起来交给渲染端做 hover 提示，
  // 免得图上看不出原类型。mermaid 自己的属性注解语法（`string x { "..." }`）在 10.9.8 的
  // erDiagram 里不认，试过会报 Expecting 'BLOCK_STOP'... got '{'，所以只能走渲染端。
  const typeAliases = new Map<string, string>();
  const noteAlias = (orig: string, flat: string) => {
    const o = (orig || '').trim();
    if (o && o !== flat && !typeAliases.has(flat)) typeAliases.set(flat, o);
  };
  const erType = (t: string): string => {
    const s = (t || '').trim();
    if (!s) return 'unknown';
    let flat: string;
    if (/^list\s+of\s+/i.test(s)) {
      flat = `list_${flatten(s.replace(/^list\s+of\s+/i, '')) || 'unknown'}`;
    } else {
      flat = flatten(s) || 'unknown';
    }
    noteAlias(s, flat);
    return flat;
  };
  // 列名同理：点号一样会炸（Expecting 'BLOCK_STOP', 'ATTRIBUTE_WORD', ..., got '.'）
  const erCol = (n: string): string => flatten((n || '').trim()) || 'col';

  const entityLine = (schemaName: string, tbl: string, cols: { name: string; type: string; pk: string }[]) => {
    const body = cols
      .slice(0, 14)
      .map((c) => `    ${erType(c.type)} ${erCol(c.name)}${c.pk ? ' PK' : ''}`)
      .join('\n');
    return `  ${erEntity(schemaName, tbl)} {\n${body}\n  }`;
  };

  const classToSchemaTable = (className: string): { schema: string; table: string } | null => {
    const parts = (className || '').split('.');
    if (parts.length < 2) return null;
    const pkg = parts.slice(0, -1).join('.');
    const tbl = parts[parts.length - 1];
    const sch = pkg === 'User' ? 'SQLUser' : pkg.replace(/\./g, '_');
    return { schema: sch, table: tbl };
  };

  const lines: string[] = ['erDiagram'];
  lines.push(entityLine(schema, table, parsed.rows));

  // 关系来源 1：显式 ForeignKey
  const edges: string[] = [];
  const seenEdge = new Set<string>();
  // 实体名 -> {schema, table}。Mermaid 实体名是拍平后的标识，无法反解出原始 schema/表名
  // （schema 自身可能带下划线，如 BILL_COM_PO），所以画边时顺手记下映射。
  const entityOf = new Map<string, { schema: string; table: string; cls: string }>();
  // 同包引用时 IRIS 省略包名（ARCItmMast 而非 User.ARCItmMast），补全成类全名，
  // 这样后续直接按类名取 UDL，省掉"表名 -> 类名"的 %Dictionary 查询（单条要 300~880ms）。
  const ownPkg = (cls || '').includes('.') ? cls!.slice(0, cls!.lastIndexOf('.')) : 'User';
  const normalizeClass = (c: string) => (c.includes('.') ? c : `${ownPkg}.${c}`);
  const pushEdge = (refClass: string, label: string, card: string) => {
    const t = classToSchemaTable(refClass);
    if (!t) return;
    const key = `${t.schema}.${t.table}|${label}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    const refEnt = erEntity(t.schema, t.table);
    entityOf.set(refEnt, { ...t, cls: normalizeClass(refClass) });
    edges.push(`  ${refEnt} ${card} ${erEntity(schema, table)} : "${label}"`);
  };

  for (const fk of parsed.foreignKeys) pushEdge(fk.ref, fk.name, '||--o{');

  // 关系来源 2：Cardinality=parent 的关系（子表 ParRef）
  for (const r of parsed.relationships) {
    if (!parsed.rows.some((x) => x.prop === r.prop)) continue;
    pushEdge(r.ref, 'ParRef', '||--o{');
  }

  // 关系来源 3：属性类型本身就是另一个持久类（HIS 里常见的 *DR 引用列）。
  // 注意：同包引用时 IRIS 会省略包名（写成 ARCItmMast 而不是 User.ARCItmMast），
  // 这类必须按同包处理，否则恰好把最常见的引用全漏掉。
  for (const row of parsed.rows) {
    if (!row.ptype || row.ptype.startsWith('list Of')) continue;
    if (row.ptype.startsWith('%')) continue;
    // 系统类 / 非类类型直接跳过
    if (/^(varchar|bigint|integer|smallint|date|time|timestamp|bit|double|numeric)$/i.test(row.ptype)) continue;
    const refClass = normalizeClass(row.ptype);
    const t = classToSchemaTable(refClass);
    if (!t) continue;
    // 自引用不画，避免图里出现指向自己的环
    if (t.schema === schema && t.table.toLowerCase() === table.toLowerCase()) continue;
    pushEdge(refClass, row.name, '||--o{');
  }

  lines.push(...edges);

  // 被引用的表：带出主键与名称字段，让图有实际信息量。
  // 并发取是安全的（实测同会话 12 个并发连跑 3 轮全成功，耗时 171~280ms）；
  // 之前担心的"网关拒并发"是误判——真正原因是类名推导错误导致的 400，被当成抖动反复重试了。
  const selfEnt = erEntity(schema, table);
  const entityMap = new Map([...entityOf].filter(([ent]) => ent !== selfEnt));
  const targets = Array.from(entityMap.keys()).slice(0, 8);
  const relEntities = await Promise.all(
    targets.map(async (ent) => {
      const target = entityMap.get(ent)!;
      const sch = target.schema;
      const tbl = target.table;
      try {
        // 传 cls 直连类定义：跳过 resolveClass 的 %Dictionary 查询（单条 300~880ms，是 ER 的主要成本）
        const p = await parseClassSchema(cfg, sch, tbl, target.cls, true);
        // 主键必进，再补 1~2 个能看懂这张表的列
        const pkCols = p.rows.filter((r) => r.pk);
        const labelCols = p.rows.filter((r) => !r.pk && /desc|text|name/i.test(r.name)).slice(0, 4 - pkCols.length);
        const keep = [...pkCols, ...labelCols].slice(0, 4);
        const used = keep.length ? keep : p.rows.slice(0, 2);
        return { ent, text: entityLine(sch, tbl, used) };
      } catch {
        /* 目标表解析不到就不画字段，Mermaid 会自动建空实体 */
        return { ent, text: '' };
      }
    })
  );
  lines.push(...relEntities.filter((r) => r.text).map((r) => r.text).sort());

  // 注释块（Global 位置明细）放在最后，前面必须留一个空行：
  // 渲染端会把 `--` 开头的行整行摘掉，如果紧跟在上一个实体的 `}` 后面而没有
  // 换行分隔，摘完就变成 `}-- 类定义：...` 粘在一行，mermaid 报
  // "Expecting 'EOF', 'SPACE', 'NEWLINE' ..."。空行保证摘干净后仍各行独立。
  const detail = [
    '',
    `-- 类定义：${parsed.class}`,
    `-- 数据 Global：${parsed.ref || parsed.global || '(未解析)'}`,
    `-- 字段 Global 位置（${parsed.rows.length} 列）`,
    ...parsed.rows.filter((r) => r.global).map((r) => `--   ${r.name.padEnd(24)} ${r.global}`),
  ].join('\n');

  const relNote = edges.length
    ? `${edges.length} 条引用关系`
    : '该类没有外键、父子关系或跨类引用';

  return {
    kind: 'mermaid',
    title: `ER 图 — ${schema}.${table}`,
    subtitle: relNote,
    mermaid: lines.join('\n') + '\n' + detail,
    meta: {
      schema,
      table,
      cls: parsed.class,
      ref: parsed.ref,
      global: parsed.global,
      edgeCount: edges.length,
      /** 拍平后的类型名 → 原始类型（含包名），渲染端用于 hover 提示 */
      typeAliases: Object.fromEntries(typeAliases),
    },
  };
}

async function runSample(cfg: ConnConfig, schema: string, table: string, limit: number): Promise<OpResult> {
  const sql = `SELECT TOP ${limit} * FROM ${schema}.${table}`;
  const res = await postQuery(cfg, sql, 120000);
  return {
    kind: 'table',
    title: `${schema}.${table} 前 ${res.rows.length} 行`,
    subtitle: sql,
    headers: res.headers,
    rows: res.rows,
    meta: { schema, table },
  };
}

export async function execute(cfg: ConnConfig, req: OpRequest): Promise<OpResult> {
  const limit = Math.min(Math.max(req.limit || 100, 1), 5000);
  switch (req.op) {
    case 'namespaces': {
      const list = await namespaces(cfg);
      return { kind: 'table', title: `命名空间（${list.length}）`, headers: ['命名空间'], rows: list.map((n) => [n]) };
    }
    case 'describe': {
      const { schema, table, cls } = await locate(cfg, req.table || '', req.schema);
      const parsed = await parseClassSchema(cfg, schema, table, cls);
      // 列顺序与 iris-schema 技能的 describe 输出保持一致
      const headers = ['#', '属性名', '属性类型', '字段名', '类型', '长度', 'PK', '说明', 'Global位置'];
      const rows = parsed.rows.map((r, i) => [
        // 与技能一致：行号用连续序号（RowID 的 col 为 0，ParRef 为 1.5，直接显示会很怪）
        String(i + 1),
        r.prop || (r.name === parsed.rowidName ? '(RowID)' : '(ParRef)'),
        r.ptype || '',
        r.name,
        r.type,
        r.length || '',
        r.pk,
        r.desc,
        r.global,
      ]);
      return {
        kind: 'table',
        title: `${schema}.${table}`,
        subtitle: `类定义 ${parsed.class}　·　存储 ${parsed.storage || '-'}　·　数据 Global ${parsed.ref || parsed.global || '-'}`,
        headers,
        rows,
        meta: {
          schema,
          table,
          cls: parsed.class,
          storage: parsed.storage,
          ref: parsed.ref,
          global: parsed.global,
          rowid: parsed.rowidName,
          indexes: parsed.indexes,
          foreignKeys: parsed.foreignKeys,
          relationships: parsed.relationships,
        },
      };
    }
    case 'udl': {
      const { schema, table, cls } = await locate(cfg, req.table || '', req.schema);
      const lines = await fetchClassUdl(cfg, cls!);
      return {
        kind: 'code',
        title: `类定义 — ${cls}`,
        subtitle: `${schema}.${table}　·　${lines.length} 行`,
        code: lines.join('\n'),
        language: 'objectscript',
      };
    }
    case 'ddl': {
      const { schema, table } = await locate(cfg, req.table || '', req.schema);
      return runDdl(cfg, schema, table);
    }
    case 'er':
      return runEr(cfg, req.table || '', req.schema);
    case 'sample': {
      const { schema, table } = await locate(cfg, req.table || '', req.schema);
      return runSample(cfg, schema, table, limit);
    }
    case 'tables':
      return runTables(cfg, req.keyword, limit, false);
    case 'findColumn':
      return runFindColumn(cfg, req.keyword || req.table || '', limit);
    case 'sql': {
      const sql = (req.sql || '').trim().replace(/;\s*$/, '');
      if (!sql) throw new Error('请输入 SQL');
      assertReadonly(sql);
      const res = await postQuery(cfg, sql, 180000);
      return {
        kind: 'table',
        title: `查询结果（${res.rows.length} 行）`,
        subtitle: sql.length > 160 ? sql.slice(0, 160) + '…' : sql,
        headers: res.headers,
        rows: res.rows,
      };
    }
    case 'test': {
      const res = await postQuery(cfg, 'SELECT 1 AS OK');
      return {
        kind: 'kv',
        title: '连接正常',
        items: [
          { k: '目标', v: `${cfg.protocol}://${cfg.host}:${cfg.web_port}` },
          { k: '命名空间', v: cfg.namespace },
          { k: '账号', v: cfg.user },
          { k: '探测结果', v: res.rows[0]?.[0] ?? 'OK' },
        ],
      };
    }
    default:
      throw new Error(`不支持的操作：${req.op}`);
  }
}
