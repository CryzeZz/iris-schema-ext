/**
 * 连接配置加载。
 *
 * 这是个 VS Code 插件，因此**优先使用 VS Code 自己的 Server Manager 配置**
 * （settings.json 里的 `intersystems.servers`），用户装完插件就能直接开查，
 * 不用再维护第二份连接清单。
 *
 * 来源优先级：
 *   1. `intersystems.servers`（VS Code 设置，含用户级与工作区级，由 VS Code 负责合并）
 *   2. `irisSchema.configPath` 指定的文件
 *   3. `~/.iris-schema.json`（与 iris-schema 技能共用）
 *
 * 两个来源**按服务器名合并**，不是二选一：同名条目以 VS Code 为准，
 * 但缺失的字段（典型是 namespace —— Server Manager 的条目里通常没有）
 * 用另一来源补齐，这样既尊重 VS Code 配置，又不会丢掉技能里已经录好的命名空间。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnConfig } from './irisClient';

export interface ProfileEntry extends ConnConfig {
  profile: string;
  /** 该条目的 namespace 是显式配的，还是回退默认值 */
  namespaceExplicit?: boolean;
  /** 来源，用于界面上区分「来自 VS Code」和「来自技能配置」 */
  origin?: 'vscode' | 'file';
}

export interface ProfileSource {
  profiles: ProfileEntry[];
  defaultProfile: string | null;
  /** 实际读取到的文件路径，用于在界面上提示 */
  path: string | null;
  /** 若来自 VS Code Server Manager，这里是来源说明 */
  vscodePath?: string;
}

/** 没有显式配 namespace 时的兜底（与 VS Code Server Manager 的惯例一致） */
export const FALLBACK_NAMESPACE = '%SYS';

// ---------------------------------------------------------------- 解析工具

function stripJsonc(text: string): string {
  // 去注释（保留字符串内的 //），再去尾逗号
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function normalizeProfile(name: string, raw: any): ProfileEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const host = raw.host;
  if (!host) return null;
  const port = raw.web_port ?? raw.port;
  // namespace 显式配置才算数；空字符串 / 纯空白视为没配
  const nsRaw = raw.namespace ?? raw.ns;
  const nsExplicit = typeof nsRaw === 'string' && nsRaw.trim() !== '';
  return {
    profile: name,
    host: String(host),
    namespace: nsExplicit ? String(nsRaw).trim() : FALLBACK_NAMESPACE,
    namespaceExplicit: nsExplicit,
    user: String(raw.user || raw.username || ''),
    password: String(raw.password || ''),
    protocol: (raw.protocol === 'https' ? 'https' : raw.protocol === 'http' ? 'http' : 'https') as 'http' | 'https',
    web_port: port ?? 52773,
    verify_ssl: raw.verify_ssl !== false,
    web_path: raw.web_path || '',
    description: raw.description || '',
    origin: raw.origin,
  };
}

function readJsoncFile(p: string): any | null {
  try {
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 来源 1：VS Code 设置

/**
 * `intersystems.servers` 的条目长这样：
 *   "138": {
 *     "webServer": { "scheme": "https", "host": "10.0.0.138", "port": 52773 },
 *     "description": "测试库",
 *     "username": "_SYSTEM",
 *     "password": "******"
 *   }
 * 注意：Server Manager 的条目**通常不带 namespace**。
 */
export interface VscodeServerEntry {
  webServer?: { scheme?: string; host?: string; port?: number | string; path?: string };
  superServer?: { host?: string; port?: number | string };
  namespace?: string;
  ns?: string;
  username?: string;
  user?: string;
  password?: string;
  description?: string;
}

/** 把一条 Server Manager 条目翻译成 ConnConfig 形状。 */
function fromVscodeEntry(name: string, entry: any): ProfileEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const web = entry.webServer || {};
  // 只配了 superServer（1972 端口）的条目连不上 Atelier：Atelier 走 Web 网关。
  // 这种条目留个空 web_port 会让用户看到一条永远连不上的服务器，不如直接跳过。
  if (!web.host) return null;
  return normalizeProfile(name, {
    host: web.host,
    web_port: web.port,
    protocol: web.scheme || web.protocol,
    web_path: web.path || '',
    namespace: entry.namespace ?? entry.ns,
    user: entry.username ?? entry.user,
    password: entry.password,
    description: entry.description,
    origin: 'vscode',
  });
}

/** 从 VS Code 设置里读 `intersystems.servers`（已由 VS Code 合并用户级与工作区级）。 */
function vscodeServersFromSettings(): Record<string, any> | null {
  const got = vscode.workspace.getConfiguration().inspect<Record<string, any>>('intersystems.servers');
  if (got) {
    // 工作区级覆盖用户级，与 VS Code 的常规行为一致
    const merged: Record<string, any> = {};
    for (const layer of [got.defaultValue, got.globalValue, got.workspaceValue, got.workspaceFolderValue]) {
      if (layer && typeof layer === 'object') Object.assign(merged, layer);
    }
    if (Object.keys(merged).length) return merged;
  }
  // 兜底：有些环境（例如扩展宿主刚启动、设置尚未落地）读不到，
  // 直接读 settings.json 文件。这样在无 UI 的脚本里也能工作。
  for (const p of vscodeSettingsPaths()) {
    const data = readJsoncFile(p);
    const servers = data?.['intersystems.servers'];
    if (servers && typeof servers === 'object') return servers;
  }
  return null;
}

function vscodeSettingsPaths(): string[] {
  const out: string[] = [];
  const appData = process.env.APPDATA;
  if (appData) {
    out.push(path.join(appData, 'Code', 'User', 'settings.json'));
    out.push(path.join(appData, 'Code - Insiders', 'User', 'settings.json'));
  }
  out.push(path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json'));
  if (process.platform === 'darwin') {
    out.push(path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'));
  }
  return out;
}

function loadVscodeProfiles(): ProfileEntry[] {
  const servers = vscodeServersFromSettings();
  if (!servers) return [];
  const out: ProfileEntry[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const prof = fromVscodeEntry(name, entry);
    if (prof) out.push(prof);
  }
  return out;
}

// ---------------------------------------------------------------- 来源 2/3：配置文件

function fromIrisSchemaFile(p: string): { connections: Record<string, any>; def: string | null } | null {
  const data = readJsoncFile(p);
  if (!data || typeof data !== 'object') return null;
  if (data.connections && typeof data.connections === 'object') {
    return { connections: data.connections, def: data.default ?? null };
  }
  return { connections: data as Record<string, any>, def: null };
}

interface FileLoadResult {
  profiles: ProfileEntry[];
  defaultProfile: string | null;
  path: string;
}

function loadFileProfiles(customPath: string): FileLoadResult | null {
  const candidates: string[] = [];
  if (customPath) candidates.push(customPath);
  candidates.push(path.join(os.homedir(), '.iris-schema.json'));
  candidates.push(path.join(os.homedir(), 'iris-schema.json'));

  for (const p of candidates) {
    const got = fromIrisSchemaFile(p);
    if (!got) continue;
    const profiles: ProfileEntry[] = [];
    for (const [name, raw] of Object.entries(got.connections)) {
      const prof = normalizeProfile(name, { ...raw, origin: 'file' });
      if (prof) profiles.push(prof);
    }
    if (!profiles.length) continue;
    const def = got.def && profiles.some((x) => x.profile === got.def) ? got.def : null;
    return { profiles, defaultProfile: def, path: p };
  }
  return null;
}

// ---------------------------------------------------------------- 合并

/**
 * 按服务器名合并。VS Code 条目在前、字段优先；缺失字段用文件来源补齐。
 * `namespace` 单独处理：VS Code 条目通常没配，此时继承文件的命名空间，
 * 而不是直接掉到 %SYS —— 否则用户会看到一堆指向 %SYS 的连接。
 */
function mergeProfiles(vscodeList: ProfileEntry[], fileList: ProfileEntry[]): ProfileEntry[] {
  const byName = new Map<string, ProfileEntry>();
  for (const p of vscodeList) byName.set(p.profile, { ...p });

  for (const f of fileList) {
    const cur = byName.get(f.profile);
    if (!cur) {
      // 文件里独有的连接也保留，避免"换了来源就看不见了"
      byName.set(f.profile, { ...f });
      continue;
    }
    if (!cur.namespaceExplicit && f.namespaceExplicit) {
      cur.namespace = f.namespace;
      cur.namespaceExplicit = true;
    }
    if (!cur.user && f.user) cur.user = f.user;
    if (!cur.password && f.password) cur.password = f.password;
    if (!cur.description && f.description) cur.description = f.description;
    if (!cur.web_path && f.web_path) cur.web_path = f.web_path;
  }
  return Array.from(byName.values());
}

// ---------------------------------------------------------------- 对外接口

let _cache: ProfileSource | null = null;

/** 读取全部可用连接（带缓存，面板频繁重建时不必反复读盘）。 */
export function loadProfiles(): ProfileSource {
  if (!_cache) _cache = loadProfilesInner();
  return _cache;
}

/** @deprecated 用 loadProfiles()，两者已统一为带缓存。 */
export function loadProfilesCached(): ProfileSource {
  return loadProfiles();
}

export function resetProfileCache(): void {
  _cache = null;
}

function loadProfilesInner(): ProfileSource {
  const cfg = vscode.workspace.getConfiguration('irisSchema');
  const customPath = (cfg.get<string>('configPath') || '').trim();

  const file = loadFileProfiles(customPath);
  const vscodeProfiles = loadVscodeProfiles();

  if (vscodeProfiles.length) {
    const merged = mergeProfiles(vscodeProfiles, file?.profiles || []);
    // 默认选中：文件来源指定过且确实存在则沿用（那是用户明确选过的），
    // 否则取 VS Code 的第一条。
    const fileDef = file?.defaultProfile;
    const def =
      fileDef && merged.some((x) => x.profile === fileDef) ? fileDef : vscodeProfiles[0].profile;
    return {
      profiles: merged,
      defaultProfile: def,
      path: file?.path || null,
      vscodePath: 'settings.json › intersystems.servers',
    };
  }

  if (file) {
    return {
      profiles: file.profiles,
      defaultProfile: file.defaultProfile || file.profiles[0].profile,
      path: file.path,
    };
  }

  return { profiles: [], defaultProfile: null, path: null };
}

export function findProfile(source: ProfileSource, name: string | null): ProfileEntry | undefined {
  if (!source.profiles.length) return undefined;
  if (name) {
    const hit = source.profiles.find((p) => p.profile === name);
    if (hit) return hit;
  }
  const def = source.defaultProfile;
  return source.profiles.find((p) => p.profile === def) || source.profiles[0];
}
