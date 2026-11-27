/**
 * IRIS Atelier 客户端 —— 从 iris-schema 技能的 atelier.py 移植。
 *
 * 设计要点（与技能保持一致的三个关键决策）：
 * 1. 会话复用：IRIS 的 CSP 会话标识在 Cookie 里。每个请求若不回传 Cookie，Web 网关就会
 *    新建一个会话，会话一直占着一个 license 直到超时回收 —— 连续几十个请求足以吃光
 *    license。因此这里按 (协议,主机,端口,命名空间,账号) 维护 CookieJar，建立会话后
 *    优先只带 Cookie，401 时再回退 Basic。
 * 2. 表结构只依赖类定义（UDL），不查 INFORMATION_SCHEMA —— 无 %Development 权限也能用，
 *    且能给出字段级的 Global 位置表达式。
 * 3. 网关偶发 404/5xx（服务本身正常），对 404 与 5xx 重试，400 等业务错误直接抛。
 *    注意 400 + ERROR #16006 表示"类不存在"，属于业务错误，不能重试。
 * 4. 并发是安全的：同一会话 12 个并发 GET doc 实测连跑 3 轮全成功（171~280ms）。
 *    早前"网关拒绝并发"的结论是误判，真实原因见第 3 条。
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface ConnConfig {
  host: string;
  namespace: string;
  user: string;
  password: string;
  protocol: 'http' | 'https';
  web_port: number | string;
  verify_ssl?: boolean;
  web_path?: string;
  description?: string;
}

export interface SchemaRow {
  col: number;
  name: string;
  type: string;
  length: string | null;
  pk: string;
  desc: string;
  prop: string;
  ptype: string;
  global: string;
}

export interface IndexInfo {
  name: string;
  decl: string;
  structure: string;
}

export interface ForeignKeyInfo {
  name: string;
  prop: string;
  ref: string;
}

export interface TableSchema {
  class: string;
  storage: string | null;
  ref: string | null;
  global: string | null;
  rowidName: string;
  rows: SchemaRow[];
  indexes: { storage: string | null; kind: 'sql' | 'default'; rows: IndexInfo[]; notes: string[] };
  foreignKeys: ForeignKeyInfo[];
  relationships: { prop: string; ref: string }[];
}

export interface QueryResult {
  headers: string[];
  rows: string[][];
}

// ---------------------------------------------------------------- 会话管理

interface SessionState {
  cookies: Map<string, string>;
  authed: boolean;
  cookieOnly: boolean;
  cookieFail: number;
}

const SESSIONS = new Map<string, SessionState>();
const UDL_CACHE = new Map<string, string[]>();
const REF_CACHE = new Map<string, [string, string | null]>();
const DICT_CACHE = new Map<string, { rows: QueryResult | null; error: unknown }>();

function sessionKey(cfg: ConnConfig): string {
  return [cfg.protocol, cfg.host, cfg.web_port, cfg.namespace, cfg.user, !!cfg.verify_ssl].join('|');
}

function getSession(cfg: ConnConfig): SessionState {
  const key = sessionKey(cfg);
  let st = SESSIONS.get(key);
  if (!st) {
    st = { cookies: new Map(), authed: false, cookieOnly: true, cookieFail: 0 };
    SESSIONS.set(key, st);
  }
  return st;
}

export function resetSessions(): void {
  SESSIONS.clear();
  UDL_CACHE.clear();
  REF_CACHE.clear();
  DICT_CACHE.clear();
}

/** 当前会话是否已持有 CSP 会话 Cookie（调试用）。 */
export function hasSession(cfg: ConnConfig): boolean {
  for (const name of getSession(cfg).cookies.keys()) {
    if (name.includes('CSPSESSIONID')) return true;
  }
  return false;
}

/** 当前会话持有的 cookie 名（不返回值，避免泄露）。 */
export function sessionCookieNames(cfg: ConnConfig): string[] {
  return Array.from(getSession(cfg).cookies.keys());
}

function absorbSetCookie(st: SessionState, setCookie: string[] | undefined): void {
  if (!setCookie) return;
  for (const raw of setCookie) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) st.cookies.set(name, value);
  }
}

function cookieHeader(st: SessionState): string {
  return Array.from(st.cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function basicAuth(cfg: ConnConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`, 'utf8').toString('base64');
}

function baseUrl(cfg: ConnConfig): string {
  const port = cfg.web_port;
  if (!port) throw new Error('未配置 web_port（IRIS Web 网关端口）');
  const scheme = cfg.protocol || 'http';
  const path = cfg.web_path || '';
  return `${scheme}://${cfg.host}:${port}${path}`;
}

export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
  /** 类不存在（Atelier 用 400 + ERROR #16006 表示，不是网关抖动，不能重试） */
  get isMissingDoc(): boolean {
    return this.status === 400 && /#16006|name is invalid/i.test(this.body);
  }
}

interface RawResponse {
  status: number;
  body: Buffer;
  setCookie?: string[];
}

function rawRequest(
  cfg: ConnConfig,
  urlStr: string,
  method: string,
  headers: Record<string, string>,
  body?: Buffer,
  timeout = 30000
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const opts: https.RequestOptions = {
      method,
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { ...headers },
      timeout,
    };
    if (body) opts.headers = { ...opts.headers, 'Content-Length': String(body.length) };
    if (isHttps && cfg.verify_ssl === false) {
      opts.rejectUnauthorized = false;
    }
    const req = mod.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const resp: RawResponse = {
          status: res.statusCode || 0,
          body: Buffer.concat(chunks),
          setCookie: res.headers['set-cookie'] as unknown as string[] | undefined,
        };
        resolve(resp);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时 (${timeout}ms): ${urlStr}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 统一请求出口 —— 会话复用的核心。
 * 已有会话 cookie 时先只带 cookie；被拒（会话过期）再带 Basic 重新认证。
 */
async function send(
  cfg: ConnConfig,
  url: string,
  method = 'GET',
  body?: Buffer,
  headers: Record<string, string> = {},
  timeout = 30000
): Promise<Buffer> {
  const st = getSession(cfg);
  const modes: boolean[] = [];
  if (st.authed && st.cookieOnly && hasSession(cfg)) modes.push(false);
  modes.push(true);

  let lastErr: unknown = null;
  for (const useBasic of modes) {
    const h: Record<string, string> = { ...headers };
    const ck = cookieHeader(st);
    if (ck) h['Cookie'] = ck;
    if (useBasic) h['Authorization'] = basicAuth(cfg);
    let resp: RawResponse;
    try {
      resp = await rawRequest(cfg, url, method, h, body, timeout);
    } catch (e) {
      lastErr = e;
      continue;
    }
    absorbSetCookie(st, resp.setCookie);
    if (resp.status >= 200 && resp.status < 400) {
      st.authed = true;
      st.cookieFail = 0;
      return resp.body;
    }
    const err = new HttpError(resp.status, resp.body.toString('utf8'));
    lastErr = err;
    if (resp.status !== 401 || useBasic) throw err;
    // cookie 不被接受：清掉旧 cookie，下一轮用 Basic 重建会话
    st.authed = false;
    st.cookieFail += 1;
    if (st.cookieFail >= 2) st.cookieOnly = false;
    st.cookies.clear();
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 主动结束 CSP 会话，立即释放 license（否则要等会话超时才回收）。 */
export async function logout(cfg: ConnConfig): Promise<boolean> {
  if (!hasSession(cfg)) return false;
  const st = getSession(cfg);
  const url = `${baseUrl(cfg)}/api/atelier/?IRISLogout=end`;
  try {
    const h: Record<string, string> = {};
    const ck = cookieHeader(st);
    if (ck) h['Cookie'] = ck;
    const resp = await rawRequest(cfg, url, 'HEAD', h, undefined, 10000);
    // 注销后服务端返回 401 属正常
    st.cookies.clear();
    st.authed = false;
    return resp.status === 401 || (resp.status >= 200 && resp.status < 400);
  } catch {
    st.cookies.clear();
    st.authed = false;
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(e: unknown): boolean {
  if (e instanceof HttpError) return e.status >= 500 || e.status === 404;
  // 连接类错误（ECONNRESET / socket hang up / 超时）也值得重试
  return true;
}

// ---------------------------------------------------------------- Atelier API

/** 命名空间进 URL 前 % 必须编码为 %25（%SYS 写作 %25SYS）。 */
function nsForUrl(ns: string): string {
  return ns.replace(/%/g, '%25');
}

export interface ServerInfo {
  version?: string;
  id?: string;
  api?: number;
  namespaces?: string[];
  [k: string]: unknown;
}

/** Atelier GetServer：拿版本与当前用户可见的命名空间列表。 */
export async function serverInfo(cfg: ConnConfig, timeout = 15000): Promise<ServerInfo> {
  const url = `${baseUrl(cfg)}/api/atelier/`;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const raw = await send(cfg, url, 'GET', undefined, { Accept: 'application/json' }, timeout);
      const data = JSON.parse(raw.toString('utf8'));
      return (data?.result?.content as ServerInfo) || {};
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && isRetryable(e)) {
        await sleep(400);
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function namespaces(cfg: ConnConfig): Promise<string[]> {
  const info = await serverInfo(cfg);
  return Array.isArray(info.namespaces) ? info.namespaces : [];
}

/** 取类 UDL 源码行。同一进程内同一类只取一次（类定义在一轮查询中不会变）。 */
export async function fetchClassUdl(cfg: ConnConfig, className: string, useCache = true): Promise<string[]> {
  const ck = `${cfg.host}|${cfg.namespace}|${className.toLowerCase()}`;
  if (useCache && UDL_CACHE.has(ck)) return [...UDL_CACHE.get(ck)!];
  const url = `${baseUrl(cfg)}/api/atelier/v1/${nsForUrl(cfg.namespace)}/doc/${className}.cls`;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const raw = await send(cfg, url, 'GET', undefined, { Accept: 'application/json' }, 30000);
      const data = JSON.parse(raw.toString('utf8'));
      const content: string[] | undefined = data?.result?.content;
      if (!content || !content.length) {
        throw new Error(
          `Atelier 返回空内容: ${JSON.stringify(data?.status ?? '')}（类名 ${className}，检查命名空间/权限）`
        );
      }
      if (useCache) UDL_CACHE.set(ck, [...content]);
      return content;
    } catch (e) {
      lastErr = e;
      // 类不存在：不重试，直接给出准确原因（Atelier 用 400 + #16006 表达）。
      // 早前把这种情况当成网关抖动重试，导致每个不存在的类白等 3×400ms，
      // 并把 400 误读成"并发被网关拒绝"。
      if (e instanceof HttpError && e.isMissingDoc) {
        throw new Error(`类 ${className} 在命名空间 ${cfg.namespace} 中不存在`);
      }
      if (attempt < 2 && isRetryable(e)) {
        await sleep(400);
        continue;
      }
      if (e instanceof Error) {
        throw new Error(`${e.message} （类名 ${className}，检查 web_port/命名空间/账号权限）`);
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 通过 HTTP 执行 SQL（Atelier action/query）。 */
export async function postQuery(cfg: ConnConfig, query: string, timeout = 60000): Promise<QueryResult> {
  const url = `${baseUrl(cfg)}/api/atelier/v1/${nsForUrl(cfg.namespace)}/action/query`;
  const body = Buffer.from(JSON.stringify({ query }), 'utf8');
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const raw = await send(
        cfg,
        url,
        'POST',
        body,
        { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout
      );
      const data = JSON.parse(raw.toString('utf8'));
      const status = data?.status?.errors;
      if (Array.isArray(status) && status.length) {
        const msg = status
          .map((x: any) => x?.error || x?.code || JSON.stringify(x))
          .filter(Boolean)
          .join('; ');
        throw new Error(`SQL 执行失败: ${msg}`);
      }
      const content = data?.result?.content;
      if (!content) throw new Error('SQL 返回结果为空');
      // Atelier 的 action/query 返回 content 为「按列名做键的对象数组」：
      //   [{ Name: "%ASQ.AST" }, ...]
      // 这里统一转成 headers + rows 二维表。同时兼容个别版本的 {fields, rows} 形态。
      let headers: string[] = [];
      let rows: any[][] = [];
      if (Array.isArray(content)) {
        const keys: string[] = [];
        const seen = new Set<string>();
        for (const item of content) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            for (const k of Object.keys(item)) {
              if (!seen.has(k)) {
                seen.add(k);
                keys.push(k);
              }
            }
          }
        }
        headers = keys;
        rows = (content as any[]).map((item) =>
          Array.isArray(item) ? item : keys.map((k) => (item ? item[k] : ''))
        );
      } else if (typeof content === 'object') {
        headers = content.fields || Object.keys(content);
        rows = content.rows || [];
      }
      return {
        headers,
        rows: rows.map((r) => (r || []).map((v) => (v === null || v === undefined ? '' : String(v)))),
      };
    } catch (e) {
      lastErr = e;
      // SQL 业务错误不重试
      if (e instanceof HttpError && e.status < 500 && e.status !== 404) throw e;
      if (e instanceof Error && e.message.startsWith('SQL 执行失败')) throw e;
      if (attempt < 2 && isRetryable(e)) {
        await sleep(400);
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------- UDL 解析

const PROP_RE = /^\s*Property\s+([%\w]+)\s+As\s+(list\s+Of\s+)?([%\w.]+)\s*(?:\((.*?)\))?\s*(?:\[(.*)\])?\s*;\s*$/;

const PRIM_TYPES: Record<string, [string, string | null]> = {
  '%string': ['varchar', '50'],
  '%library.string': ['varchar', '50'],
  '%date': ['date', null],
  '%library.date': ['date', null],
  '%time': ['time', null],
  '%library.time': ['time', null],
  '%timestamp': ['timestamp', null],
  '%library.timestamp': ['timestamp', null],
  '%integer': ['integer', '10'],
  '%library.integer': ['integer', '10'],
  '%counter': ['integer', '10'],
  '%library.counter': ['integer', '10'],
  '%smallint': ['smallint', null],
  '%library.smallint': ['smallint', null],
  '%bigint': ['bigint', '19'],
  '%biginteger': ['bigint', '19'],
  '%library.bigint': ['bigint', '19'],
  '%float': ['double', '15'],
  '%library.float': ['double', '15'],
  '%double': ['double', '15'],
  '%library.double': ['double', '15'],
  '%numeric': ['numeric', null],
  '%library.numeric': ['numeric', null],
  '%decimal': ['numeric', null],
  '%library.decimal': ['numeric', null],
  '%boolean': ['bit', null],
  '%library.boolean': ['bit', null],
  '%stream.globalcharacter': ['longvarchar', null],
  '%stream.globalbinary': ['longvarbinary', null],
  '%stream.charactertstream': ['longvarchar', null],
};

function parseKeywords(kstr?: string): Record<string, string | true> {
  const d: Record<string, string | true> = {};
  if (!kstr) return d;
  for (const part of kstr.split(/,\s*(?=[A-Za-z])/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^([A-Za-z]+)\s*=\s*([\s\S]*)$/);
    if (m) d[m[1].toUpperCase()] = m[2].trim();
    else d[p.toUpperCase()] = true;
  }
  return d;
}

function parseParams(pstr?: string): Record<string, string> {
  const d: Record<string, string> = {};
  if (!pstr) return d;
  const re = /([A-Za-z]+)\s*=\s*("(?:[^"]*)"|[^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pstr))) {
    d[m[1].toUpperCase()] = m[2].trim().replace(/^"|"$/g, '');
  }
  return d;
}

function storageBlock(lines: string[]): { name: string | null; block: string[] } {
  let start = -1;
  let name: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*Storage\s+(\S+)\s*$/);
    if (m) {
      start = i;
      name = m[1];
      break;
    }
  }
  if (start < 0) return { name: null, block: [] };
  let depth = 0;
  let opened = false;
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    block.push(line);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (line.includes('{')) opened = true;
    if (opened && depth <= 0) break;
  }
  return { name, block };
}

function toField(prop: string, prop2field?: Map<string, string>): string {
  if (!prop2field) return prop;
  return prop2field.get(prop.toUpperCase()) || prop;
}

function unquote(v: string): string {
  const s = (v || '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function delimLiteral(d?: string): string {
  const s = unquote(d || '') || '^';
  const low = s.toLowerCase();
  if (low.startsWith('$c(') || low.startsWith('$char(')) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function subToken(expr: string, rowids: Map<number, string>, prop2field?: Map<string, string>): string {
  const e = (expr || '').trim();
  if (!e) return '';
  let m = e.match(/^\{L(\d+)\}$/);
  if (m) {
    const f = rowids.get(parseInt(m[1], 10));
    return f ? toField(f, prop2field) : e;
  }
  m = e.match(/^\{([A-Za-z_%][\w.%]*)\}$/);
  if (m) return toField(m[1], prop2field);
  return e;
}

function valueOf(tag: string, line: string): string {
  return line.slice(tag.length).split('<')[0].trim();
}

interface Location {
  global: string;
  subs: string[];
  kind: 'piece' | 'plain' | 'list';
  piece?: string;
  delim?: string;
  index?: string;
}

function parseSqlMap(block: string[], prop2field?: Map<string, string>) {
  interface MapDef {
    name: string;
    global: string | null;
    rows: [string, string[], string | null, string | null][];
    type: string | null;
    subs: [number, string][];
    rowids: Map<number, string>;
  }
  const maps: MapDef[] = [];
  let cur: MapDef | null = null;
  let col: string | null = null;
  let nodes: string[] = [];
  let piece: string | null = null;
  let delim: string | null = null;
  let inData = false;
  let subName: number | null = null;
  let subExpr: string | null = null;
  let ridName: number | null = null;
  let ridField: string | null = null;

  for (const raw of block) {
    const s = raw.trim();
    if (s.startsWith('<SQLMap name=')) {
      cur = {
        name: s.split('"')[1],
        global: null,
        rows: [],
        type: null,
        subs: [],
        rowids: new Map(),
      };
      maps.push(cur);
      col = null;
      nodes = [];
      piece = null;
      delim = null;
      inData = false;
      subName = subExpr = ridName = ridField = null;
      continue;
    }
    if (!cur) continue;
    if (s.startsWith('<Global>')) cur.global = valueOf('<Global>', s);
    else if (s.startsWith('<Subscript name=')) {
      subName = parseInt(s.split('"')[1], 10);
      subExpr = null;
    } else if (s.startsWith('</Subscript>')) {
      if (subName !== null) cur.subs.push([subName, subExpr || '']);
      subName = subExpr = null;
    } else if (s.startsWith('<Expression>') && subName !== null) {
      subExpr = valueOf('<Expression>', s);
    } else if (s.startsWith('<RowIdSpec name=')) {
      ridName = parseInt(s.split('"')[1], 10);
      ridField = null;
    } else if (s.startsWith('<Field>') && ridName !== null) {
      ridField = valueOf('<Field>', s);
    } else if (s.startsWith('</RowIdSpec>')) {
      if (ridName !== null && ridField) cur.rowids.set(ridName, ridField);
      ridName = ridField = null;
    } else if (s.startsWith('<Type>') && !inData) {
      cur.type = valueOf('<Type>', s).toLowerCase();
    } else if (s.startsWith('<Data name=')) {
      col = s.split('"')[1];
      nodes = [];
      piece = null;
      delim = null;
      inData = true;
    } else if (s.startsWith('<Delimiter>')) {
      delim = valueOf('<Delimiter>', s);
    } else if (s.startsWith('<Node>')) {
      const v = valueOf('<Node>', s);
      nodes.push(...v.split(',').map((x) => x.trim()).filter(Boolean));
    } else if (s.startsWith('<Piece>')) {
      piece = valueOf('<Piece>', s);
    } else if (s.startsWith('</Data>')) {
      if (col) cur.rows.push([col, [...nodes], piece, delim]);
      col = null;
      nodes = [];
      piece = null;
      delim = null;
      inData = false;
    }
  }

  let dataMaps = maps.filter((m) => (m.type || '') === 'data');
  if (!dataMaps.length) {
    dataMaps = maps.filter(
      (m) => !m.name.toLowerCase().startsWith('index') && !['index', 'bitmap', 'bitslice'].includes(m.type || '')
    );
  }
  if (!dataMaps.length) {
    dataMaps = maps.filter((m) => !m.name.toLowerCase().startsWith('index')).slice(0, 1);
  }

  const locations = new Map<string, Location>();
  let mainGlobal: string | null = null;
  let mainRef: string | null = null;
  for (const m of dataMaps) {
    if (!m.global) continue;
    if (!mainGlobal) mainGlobal = m.global;
    let prefix = m.subs
      .slice()
      .sort((a, b) => a[0] - b[0])
      .map(([, e]) => subToken(e, m.rowids, prop2field))
      .filter(Boolean);
    if (!mainRef) mainRef = prefix.length ? `${m.global}(${prefix.join(',')})` : m.global;
    for (const [colName, nds, pc, dl] of m.rows) {
      const field = toField(colName, prop2field).toUpperCase();
      const subs = [...prefix, ...nds];
      if (pc) {
        locations.set(field, { global: m.global, subs, kind: 'piece', piece: pc, delim: dl || undefined });
      } else if (subs.length) {
        locations.set(field, { global: m.global, subs, kind: 'plain' });
      }
    }
  }
  return { locations, mainGlobal, mainRef };
}

function parseDefaultStorage(block: string[], prop2field?: Map<string, string>) {
  const locations = new Map<string, Location>();
  let dataLoc: string | null = null;
  let idLoc: string | null = null;
  const pending: [string, string][] = [];
  let curN: string | null = null;
  for (const raw of block) {
    const s = raw.trim();
    if (s.startsWith('<DataLocation>')) dataLoc = valueOf('<DataLocation>', s);
    else if (s.startsWith('<IdLocation>')) idLoc = valueOf('<IdLocation>', s);
    else if (s.startsWith('<Value name=')) curN = s.split('"')[1];
    else if (s.startsWith('<Value>') && curN !== null) {
      pending.push([valueOf('<Value>', s), curN]);
      curN = null;
    }
  }
  const g = dataLoc || idLoc;
  if (!g) return { locations, mainGlobal: null, mainRef: null };
  for (const [prop, n] of pending) {
    locations.set(toField(prop, prop2field).toUpperCase(), {
      global: g,
      subs: [],
      kind: 'list',
      index: n,
    });
  }
  return { locations, mainGlobal: g, mainRef: g };
}

export function parseStorage(lines: string[], prop2field?: Map<string, string>) {
  const { name, block } = storageBlock(lines);
  if (!block.length) return null;
  const hasGlobal = block.some((l) => l.includes('<Global>'));
  const hasSqlMap = block.some((l) => l.includes('<SQLMap'));
  const parsed = hasSqlMap && hasGlobal ? parseSqlMap(block, prop2field) : parseDefaultStorage(block, prop2field);
  return { storage: name, global: parsed.mainGlobal, ref: parsed.mainRef, locations: parsed.locations };
}

/** 位置字典 -> IRIS 取值表达式。 */
export function formatLocation(loc: Location | undefined, rowidLabel = 'ID'): string {
  if (!loc) return '';
  let subs = [...loc.subs];
  if (!subs.length || loc.kind === 'list') subs = [rowidLabel, ...subs];
  const ref = `${loc.global}(${subs.join(',')})`;
  if (loc.kind === 'piece') return `$P(${ref},${delimLiteral(loc.delim)},${loc.piece})`;
  if (loc.kind === 'list') return `$lg(${ref},${loc.index})`;
  return ref;
}

function indexSubToken(expr: string, rowids: Map<number, string>): string {
  const e = (expr || '').trim();
  if (!e) return '';
  const m = e.match(/^\{L(\d+)\}$/);
  if (m) {
    const f = rowids.get(parseInt(m[1], 10));
    return f ? `{${f}}` : e;
  }
  return e;
}

function splitIndexDecls(lines: string[]): string[] {
  const out: string[] = [];
  let buf: string | null = null;
  for (const raw of lines) {
    const s = raw.trim();
    if (buf === null) {
      if (s.startsWith('///') || !s) continue;
      if (/^Index\s/.test(s)) buf = s;
      else continue;
    } else {
      buf += ' ' + s;
    }
    if (buf.endsWith(';')) {
      out.push(buf);
      buf = null;
    }
  }
  return out;
}

function idkeyProps(lines: string[]): string[] {
  for (const l of lines) {
    if (/^\s*Index\s/.test(l) && /\bIdKey\b/.test(l)) {
      const m = l.match(/^\s*Index\s+\S+\s+On\s+(?:\(([^)]*)\)|([A-Za-z%][\w.%]*))/);
      if (m) {
        const raw = m[1] || m[2] || '';
        return raw.split(',').map((x) => x.trim()).filter(Boolean);
      }
    }
  }
  return [];
}

function idkeyHasPk(lines: string[]): boolean {
  for (const l of lines) {
    if (/^\s*Index\s/.test(l) && /\bIdKey\b/.test(l) && /\bPrimaryKey\b/.test(l)) return true;
  }
  return false;
}

function storageRowid(lines: string[]): string | null {
  const m = lines.join('\n').match(/<SqlRowIdName>\s*([^<]+?)\s*<\/SqlRowIdName>/);
  return m ? m[1] : null;
}

export function parseIndexes(lines: string[]): {
  storage: string | null;
  kind: 'sql' | 'default';
  rows: IndexInfo[];
  notes: string[];
} {
  const { name, block } = storageBlock(lines);
  const rows: IndexInfo[] = [];
  const notes: string[] = [];
  const hasSqlMap = block.length && block.some((l) => l.includes('<SQLMap')) && block.some((l) => l.includes('<Global>'));

  if (hasSqlMap) {
    const txt = block.join('\n');
    const re = /<SQLMap name="([^"]+)">([\s\S]*?)<\/SQLMap>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) {
      const nm = m[1];
      const body = m[2];
      const tm = body.match(/<Type>([^<]*)<\/Type>/);
      if (!tm || !['index', 'bitmap', 'bitslice'].includes(tm[1].trim().toLowerCase())) continue;
      const gm = body.match(/<Global>([^<]*)<\/Global>/);
      if (!gm) continue;
      const rowids = new Map<number, string>();
      const rre = /<RowIdSpec name="(\d+)">\s*<Expression>[^<]*<\/Expression>\s*<Field>([^<]*)<\/Field>/g;
      let rm: RegExpExecArray | null;
      while ((rm = rre.exec(body))) rowids.set(parseInt(rm[1], 10), rm[2].trim());
      const subsArr: [number, string][] = [];
      const sre = /<Subscript name="(\d+)">([\s\S]*?)<\/Subscript>/g;
      let sm2: RegExpExecArray | null;
      while ((sm2 = sre.exec(body))) {
        const em = sm2[2].match(/<Expression>([\s\S]*?)<\/Expression>/);
        if (em) subsArr.push([parseInt(sm2[1], 10), em[1].trim()]);
      }
      let subs = subsArr
        .sort((a, b) => a[0] - b[0])
        .map(([, e]) => indexSubToken(e, rowids))
        .filter(Boolean);
      const nodeRe = /<Node>([^<]*)<\/Node>/g;
      let nm2: RegExpExecArray | null;
      while ((nm2 = nodeRe.exec(body))) {
        subs.push(...nm2[1].split(',').map((x) => x.trim()).filter(Boolean));
      }
      const g = gm[1].trim();
      rows.push({ name: nm, decl: '', structure: subs.length ? `${g}(${subs.join(',')})` : g });
    }
    const mapped = new Set(rows.map((r) => r.name.toUpperCase()));
    for (const stmt of splitIndexDecls(lines)) {
      const dm = stmt.match(/Index\s+([%\w]+)/);
      if (dm && !mapped.has(dm[1].toUpperCase())) {
        notes.push(`声明了索引 ${dm[1]}，但存储定义里没有对应的索引 SQLMap`);
      }
    }
    return { storage: name, kind: 'sql', rows, notes };
  }

  let idxLoc: string | null = null;
  if (block.length) {
    const lm = block.join('\n').match(/<IndexLocation>([^<]*)<\/IndexLocation>/);
    idxLoc = lm ? lm[1].trim() : null;
  }
  const ids = idkeyProps(lines);
  const rowidProp = ids.length === 1 ? ids[0] : storageRowid(lines) || 'RowID';
  for (const stmt of splitIndexDecls(lines)) {
    const dm = stmt.match(/Index\s+([%\w]+)\s+On\s+(.+?)\s*(?:\[(.*)\])?\s*;\s*$/);
    if (!dm) continue;
    const iname = dm[1];
    const props = dm[2];
    const pm = props.trim().match(/^\((.*)\)$/);
    const plist = (pm ? pm[1] : props).split(',').map((x) => x.trim()).filter(Boolean);
    const subs = [`"${iname}"`, ...plist.map((p) => `{${p}}`)];
    const isRowidIndex =
      plist.length === 1 && ['rowid', '%id', rowidProp.toLowerCase()].includes(plist[0].toLowerCase());
    if (!isRowidIndex) subs.push(`{${rowidProp}}`);
    const g = idxLoc || '(存储定义中未找到 IndexLocation)';
    rows.push({ name: iname, decl: stmt, structure: `${g}(${subs.join(',')})` });
  }
  return { storage: name, kind: 'default', rows, notes };
}

function splitRelations(lines: string[]) {
  const out: { prop: string; type: string; params: string; kw: string }[] = [];
  for (const l of lines) {
    const m = l
      .trim()
      .match(/^Relationship\s+([%\w]+)\s+As\s+([%\w.]+)\s*(?:\((.*?)\))?\s*(?:\[(.*)\])?\s*;\s*$/);
    if (m) out.push({ prop: m[1], type: m[2], params: m[3] || '', kw: m[4] || '' });
  }
  return out;
}

function splitProps(lines: string[]): [string, string][] {
  const out: [string, string][] = [];
  let buf: string | null = null;
  let desc: string | null = null;
  let pending: string[] = [];
  const flushCheck = () => {
    if (
      buf !== null &&
      buf.endsWith(';') &&
      (buf.match(/\{/g) || []).length <= (buf.match(/\}/g) || []).length
    ) {
      out.push([buf, desc || '']);
      buf = null;
      desc = null;
    }
  };
  for (const raw of lines) {
    const s = raw.trim();
    if (buf === null) {
      if (s.startsWith('///')) {
        pending.push(s.slice(3).trim());
        continue;
      }
      if (/^Property\s/.test(s)) {
        buf = s;
        desc = pending.join(' ');
        pending = [];
        flushCheck();
        continue;
      }
      if (s && !s.startsWith('//')) pending = [];
    } else {
      buf += ' ' + s;
      flushCheck();
    }
  }
  return out;
}

function classHead(lines: string[]): { name: string | null; rest: string } {
  for (const l of lines) {
    const m = l.match(/\s*Class\s+([\w.%]+)\b(.*)$/);
    if (m) return { name: m[1], rest: m[2] };
  }
  return { name: null, rest: '' };
}

function headKw(rest: string, name: string): string | null {
  const m = rest.match(new RegExp('\\b' + name + '\\s*=\\s*([\\w.%]+)'));
  return m ? m[1] : null;
}

/**
 * 引用类 -> SQL 列类型（跟随目标类的单一 IdKey 属性）。
 *
 * @param ownPkg 引用方所在的包。同包引用时 IRIS 省略包名（写 ARCItmMast 而不是
 *               User.ARCItmMast），这里先用裸类名取，失败再补包名，避免整条引用链
 *               各取两次。不传则只按原样取。
 */
async function refSqlType(
  cfg: ConnConfig,
  className: string,
  ownPkg?: string,
  depth = 0
): Promise<[string, string | null]> {
  const needsPkg = !!ownPkg && !className.includes('.');
  const fullName = needsPkg ? `${ownPkg}.${className}` : className;
  // 缓存键统一用全名，裸名与全名不会各取一遍
  const key = `${cfg.host}|${cfg.namespace}|${fullName.toUpperCase()}`;
  const cached = REF_CACHE.get(key);
  if (cached) return cached;
  if (depth > 4) return ['bigint', '19'];
  let lines: string[];
  try {
    lines = await fetchClassUdl(cfg, fullName);
  } catch {
    return ['bigint', '19'];
  }
  const ids = idkeyProps(lines);
  const selfPkg = fullName.includes('.') ? fullName.slice(0, fullName.lastIndexOf('.')) : ownPkg;
  let res: [string, string | null];
  if (!ids.length) res = ['bigint', '19'];
  else if (ids.length > 1) res = ['varchar', null];
  else {
    let found: [string, string | null] | null = null;
    const want = ids[0].toLowerCase();
    for (const [stmt] of splitProps(lines)) {
      const m = stmt.match(PROP_RE);
      if (m && m[1].toLowerCase() === want) {
        found = await propSqlType(cfg, m[2], m[3], parseParams(m[4]), selfPkg, depth + 1);
        break;
      }
    }
    if (found && (found[0] === 'double' || found[0] === 'numeric')) found = ['varchar', null];
    res = found || ['bigint', '19'];
  }
  REF_CACHE.set(key, res);
  return res;
}

async function propSqlType(
  cfg: ConnConfig,
  isList: string | undefined,
  ptype: string,
  params: Record<string, string>,
  ownPkg?: string,
  depth = 0
): Promise<[string, string | null]> {
  // 内置类型 / 列表类型不必联网，直接算；只有引用类型才需要递归取目标类 IdKey
  const prim = primitiveSqlType(isList, ptype, params);
  if (prim) return prim;
  return refSqlType(cfg, ptype, ownPkg, depth);
}

/**
 * 纯计算版：内置类型与列表类型返回 [SQL类型, 长度]，引用类型返回 null（表示需要联网解析）。
 */
function primitiveSqlType(
  isList: string | undefined,
  ptype: string,
  params: Record<string, string>
): [string, string | null] | null {
  const t = ptype.toLowerCase();
  if (isList) {
    return ['varchar', '4096'];
  }
  if (!(t in PRIM_TYPES)) return null;
  let [base, ln] = PRIM_TYPES[t];
  if (t === '%string' || t === '%library.string') {
    const ml = params['MAXLEN'];
    // %String 未写 MAXLEN 时 IRIS 缺省按 50 建列（实测与 INFORMATION_SCHEMA 一致）
    ln = ml !== undefined && ml !== '' ? ml : ln || '50';
  } else if (
    ['%float', '%library.float', '%double', '%library.double', '%numeric', '%library.numeric', '%decimal', '%library.decimal'].includes(t)
  ) {
    const mx = params['MAXVAL'];
    const sc = params['SCALE'];
    if (mx !== undefined && mx !== '') {
      ln = String(String(mx).replace(/^-/, '').split('.')[0].length);
    }
    if (['%numeric', '%library.numeric', '%decimal', '%library.decimal'].includes(t) && mx && sc) {
      ln = `${mx},${sc}`;
    }
  }
  return [base, ln];
}

// ---------------------------------------------------------------- 表名 -> 类名

function classCandidates(schema: string, table: string): string[] {
  const pkgs = [schema.replace(/_/g, '.')];
  if (schema.toUpperCase() === 'SQLUSER') pkgs.unshift('User');
  pkgs.push(schema);
  const out: string[] = [];
  for (const pkg of pkgs) {
    for (const tbl of [table, table.replace(/_/g, '')]) {
      const cls = `${pkg}.${tbl}`;
      if (!out.includes(cls)) out.push(cls);
    }
  }
  return out;
}

async function dictQuery(cfg: ConnConfig, sql: string): Promise<{ rows: QueryResult | null; error: unknown }> {
  // 同一条 %Dictionary 查询在一轮操作里会被反复触发（解析引用类的 RowID 类型时），
  // 缓存结果可显著缩短 ER 图这类多表场景的耗时。
  const ck = `${cfg.host}|${cfg.namespace}|${sql}`;
  const hit = DICT_CACHE.get(ck);
  if (hit) return hit;
  let err: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = { rows: await postQuery(cfg, sql), error: null };
      DICT_CACHE.set(ck, res);
      return res;
    } catch (e) {
      err = e;
      await sleep(400 * (i + 1));
    }
  }
  return { rows: null, error: err };
}

/** 表名 -> 类全名。先按 schema→包名映射精确查，再按 SqlTableName 反查。 */
export async function resolveClass(cfg: ConnConfig, schema: string, table: string): Promise<string | null> {
  const cands = classCandidates(schema, table);
  const inList = cands.map((c) => `'${c}'`).join(', ');
  const q1 = await dictQuery(
    cfg,
    `SELECT Name, SqlTableName FROM %Dictionary.ClassDefinition WHERE Name IN (${inList})`
  );
  const idxName = q1.rows ? q1.rows.headers.findIndex((h) => h.toUpperCase() === 'NAME') : -1;
  const idxTbl = q1.rows ? q1.rows.headers.findIndex((h) => h.toUpperCase() === 'SQLTABLENAME') : -1;
  for (const r of q1.rows?.rows || []) {
    const name = r[idxName >= 0 ? idxName : 0];
    const sqltbl = (r[idxTbl >= 0 ? idxTbl : 1] || '').trim();
    // SqlTableName 为空 = 缺省映射，表名就是类名最后一段
    if (!sqltbl || sqltbl.toLowerCase() === table.toLowerCase()) return name;
  }

  const q2 = await dictQuery(
    cfg,
    `SELECT Name FROM %Dictionary.ClassDefinition WHERE SqlTableName = '${table.replace(/'/g, "''")}'`
  );
  if (q2.rows && q2.rows.rows.length) {
    for (const r of q2.rows.rows) {
      const pkg = (r[0] || '').split('.').slice(0, -1).join('.');
      if (pkg.replace(/\./g, '_').toUpperCase() === schema.toUpperCase()) return r[0];
    }
    // 命中的类都不属该 schema（同名表在多个包里）：不擅自挑一个
    return null;
  }

  // %Dictionary 查不到：直接探测类定义文件（兼容无 %Development 权限的账号）
  for (const cls of cands) {
    try {
      await fetchClassUdl(cfg, cls);
      return cls;
    } catch {
      /* 继续试下一个 */
    }
  }
  if (q1.error) throw new Error(`定位类定义失败（${schema}.${table}）：${(q1.error as Error).message}`);
  if (q2.error) throw new Error(`定位类定义失败（${schema}.${table}）：${(q2.error as Error).message}`);
  return null;
}

export interface TableCandidate {
  cls: string;
  schema: string;
  table: string;
  type: string;
}

/** 关键字模糊找表/类。 */
export async function searchTables(cfg: ConnConfig, keyword: string, limit = 50): Promise<TableCandidate[]> {
  const kw = (keyword || '').trim().replace(/'/g, "''");
  if (!kw) return [];
  const short = kw.split('.').pop() || kw;
  const pats: string[] = [];
  for (const p of [kw, short]) {
    const lp = `%${p.toLowerCase()}%`;
    if (!pats.includes(lp)) pats.push(lp);
  }
  const cond = pats.map((p) => `LOWER(Name) LIKE '${p}' OR LOWER(SqlTableName) LIKE '${p}'`).join(' OR ');
  const q1 = await dictQuery(
    cfg,
    `SELECT TOP ${limit} Name, SqlTableName FROM %Dictionary.ClassDefinition WHERE ${cond} ORDER BY Name`
  );
  const cond2 = pats.map((p) => `LOWER(TABLE_NAME) LIKE '${p}'`).join(' OR ');
  const q2 = await dictQuery(
    cfg,
    `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE ${cond2}`
  );

  const tmap = new Map<string, string>();
  for (const r of q2.rows?.rows || []) {
    tmap.set(`${(r[0] || '').toUpperCase()}|${(r[1] || '').toLowerCase()}`, r[2] || '');
  }
  const out: TableCandidate[] = [];
  const seen = new Set<string>();
  for (const r of q1.rows?.rows || []) {
    const cls = r[0];
    if (!cls || seen.has(cls)) continue;
    seen.add(cls);
    const pkg = cls.split('.').slice(0, -1).join('.');
    const schema = pkg === 'User' ? 'SQLUser' : pkg.replace(/\./g, '_');
    const table = (r[1] || '').trim() || cls.split('.').pop() || cls;
    out.push({ cls, schema, table, type: tmap.get(`${schema.toUpperCase()}|${table.toLowerCase()}`) || '' });
  }
  const kwl = kw.toLowerCase();
  const shortl = short.toLowerCase();
  out.sort((a, b) => {
    const sa = a.cls.toLowerCase() === kwl || [kwl, shortl].includes(a.table.toLowerCase()) ? 0 : 1;
    const sb = b.cls.toLowerCase() === kwl || [kwl, shortl].includes(b.table.toLowerCase()) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    if (!!a.type !== !!b.type) return a.type ? -1 : 1;
    return a.cls.toLowerCase().localeCompare(b.cls.toLowerCase());
  });
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- 表结构推导

/**
 * 仅凭类定义推导表结构（不依赖 INFORMATION_SCHEMA）。
 *
 * `light=true` 时跳过"引用类型 -> 目标类 IdKey 类型"的递归解析（refSqlType），
 * 直接把类名当作列类型。ER 图只需图结构与主键，用不到精确类型；
 * 而递归解析会沿着引用链一路取几十个类的 UDL（实测 ARC_Alias 一张表就要 97 次），
 * 是 ER 图耗时的主要来源。
 */
export async function parseClassSchema(
  cfg: ConnConfig,
  schema: string,
  table: string,
  cls?: string | null,
  light = false
): Promise<TableSchema> {
  const className = cls || (await resolveClass(cfg, schema, table));
  if (!className) {
    throw new Error(`未找到表 ${schema}.${table} 对应的类定义（确认表名或 schema 是否正确）`);
  }
  const lines = await fetchClassUdl(cfg, className);
  const ownPkg = className.includes('.') ? className.slice(0, className.lastIndexOf('.')) : undefined;
  const { rest } = classHead(lines);
  let rowidName = headKw(rest, 'SqlRowIdName') || storageRowid(lines);
  const pkProps = idkeyProps(lines);
  const props = splitProps(lines);

  const rels: { prop: string; type: string; ptype: string; field: string; parent: boolean }[] = [];
  for (const r of splitRelations(lines)) {
    const rkw = parseKeywords(r.kw);
    if (rkw['PRIVATE']) continue;
    const [rt] = light ? ([r.type, null] as [string, string | null]) : await refSqlType(cfg, r.type, ownPkg);
    const field = typeof rkw['SQLFIELDNAME'] === 'string' ? (rkw['SQLFIELDNAME'] as string) : r.prop;
    const card = String(rkw['CARDINALITY'] || '').toLowerCase();
    rels.push({ prop: r.prop, type: rt, ptype: r.type, field, parent: card.includes('parent') });
  }
  // 只有 Cardinality=parent 的关系才是 ParRef 列
  const parentRels = rels.filter((r) => r.parent);
  const hasParent = parentRels.length > 0;
  const hasColnum = props.some(([s]) => s.includes('SqlColumnNumber'));

  const rows: SchemaRow[] = [];
  const prop2field = new Map<string, string>();
  let seq = 0;
  let identityField: string | null = null;
  // 无 SqlColumnNumber 时 IRIS 按属性名 ASCII 序分配列号
  const ordered = hasColnum ? props : [...props].sort((a, b) => a[0].split(' ')[1].localeCompare(b[0].split(' ')[1]));

  let nextCol = 0;
  if (hasColnum) {
    for (const [stmt] of props) {
      const m = stmt.match(PROP_RE);
      if (!m) continue;
      const cn = parseKeywords(m[5])['SQLCOLUMNNUMBER'];
      if (cn && typeof cn === 'string' && parseInt(cn, 10) > nextCol) nextCol = parseInt(cn, 10);
    }
  }

  for (const [stmt, desc] of ordered) {
    const m = stmt.match(PROP_RE);
    if (!m) continue;
    const [, pname, isList, ptype, pstr, kstr] = m;
    const kw = parseKeywords(kstr);
    if (kw['PRIVATE']) continue;
    if (kw['TRANSIENT'] && !kw['SQLCOMPUTED']) continue;
    let colnum: number;
    const cn = kw['SQLCOLUMNNUMBER'];
    if (hasColnum) {
      if (cn === undefined) {
        nextCol += 1;
        colnum = nextCol;
      } else {
        colnum = parseInt(String(cn), 10);
      }
    } else {
      seq += 1;
      colnum = seq + 1; // 缺省存储：RowID 占 1，其余按属性名字母序
    }
    const field = typeof kw['SQLFIELDNAME'] === 'string' ? (kw['SQLFIELDNAME'] as string) : pname;
    if (kw['IDENTITY']) identityField = field;
    prop2field.set(pname.toUpperCase(), field);
    // light 模式：内置类型照常算，引用类型直接用类名当列类型（不联网）
    const [base, ln] =
      (light
        ? primitiveSqlType(isList, ptype, parseParams(pstr)) || ([isList ? 'list Of ' + ptype : ptype, null] as [string, string | null])
        : await propSqlType(cfg, isList, ptype, parseParams(pstr), ownPkg));
    rows.push({
      col: colnum,
      name: field,
      type: base,
      length: ln,
      pk: '',
      desc: desc || '',
      prop: pname,
      ptype: isList ? 'list Of ' + ptype : ptype,
      global: '',
    });
  }

  const pkFields = new Set(pkProps.map((p) => (prop2field.get(p.toUpperCase()) || p).toUpperCase()));
  const pkOnFields = pkFields.size > 0 && idkeyHasPk(lines);
  if (pkOnFields) {
    for (const r of rows) if (pkFields.has(r.name.toUpperCase())) r.pk = 'PK';
  }

  if (identityField) rowidName = identityField;
  if (!rowidName) {
    // 未显式指定 SqlRowIdName：若第 1 列形如 *RowID 那就是 RowID 列，否则缺省叫 ID
    const cand = rows.find((r) => r.col === 1 && /(rowid|row_id)$/i.test(r.name));
    rowidName = cand ? cand.name : 'ID';
  }
  const rowidCol = rows.find((r) => r.name.toUpperCase() === rowidName!.toUpperCase());
  if (!rowidCol) {
    let rtype: [string, string | null];
    if (hasParent || pkProps.length > 1) {
      rtype = ['varchar', null]; // 父子表/复合 IdKey -> 字符串 RowID
    } else if (pkProps.length === 1) {
      // 单一 IdKey 属性：RowID 列类型/长度跟它一致
      const hit = rows.find((r) => r.prop.toLowerCase() === pkProps[0].toLowerCase());
      const ptype = hit ? hit.type : 'bigint';
      const plen = hit ? hit.length : null;
      rtype = ['varchar', 'double', 'numeric'].includes(ptype) ? ['varchar', plen] : ['bigint', '19'];
    } else {
      rtype = ['bigint', '19']; // 无 IdKey -> 整数自增 RowID
    }
    rows.push({
      col: hasParent ? 1.5 : 0,
      name: rowidName,
      type: rtype[0],
      length: rtype[1],
      pk: pkOnFields ? '' : 'PK',
      desc: '',
      prop: '',
      ptype: '',
      global: '',
    });
  } else if (!pkOnFields) {
    rowidCol.pk = 'PK'; // 主键落在 RowID 列上
  }

  // 子表的 ParRef 由 Relationship 派生，是第 1 列且属于主键
  for (const r of parentRels) {
    rows.push({
      col: 1,
      name: r.field,
      type: r.type,
      length: null,
      pk: pkOnFields ? 'PK' : '',
      desc: '',
      prop: r.prop,
      ptype: r.ptype,
      global: '',
    });
  }
  rows.sort((a, b) => a.col - b.col);

  const storage = parseStorage(lines, prop2field);
  const locs = storage?.locations || new Map<string, Location>();
  for (const r of rows) {
    r.global = formatLocation(locs.get(r.name.toUpperCase()), rowidName || 'ID');
  }

  const idx = parseIndexes(lines);
  const fks: ForeignKeyInfo[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*ForeignKey\s+([%\w]+)\s*\(\s*([^)]*)\)\s*References\s+([%\w.]+)/);
    if (m) fks.push({ name: m[1], prop: m[2].trim(), ref: m[3] });
  }

  return {
    class: className,
    storage: storage?.storage ?? null,
    ref: storage?.ref ?? null,
    global: storage?.global ?? null,
    rowidName: rowidName || 'ID',
    rows,
    indexes: idx,
    foreignKeys: fks,
    relationships: rels.map((r) => ({ prop: r.prop, ref: r.ptype })),
  };
}
