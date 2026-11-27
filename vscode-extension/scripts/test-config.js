/**
 * 验证连接配置的加载与合并逻辑（不需要真实 VS Code）。
 *
 * 用假的 vscode 模块驱动 config.js：
 *   - 场景 A：VS Code 设置里有 intersystems.servers，同时存在 ~/.iris-schema.json
 *              → 应当合并，VS Code 优先，namespace 从文件补齐
 *   - 场景 B：只有 VS Code 设置，条目不带 namespace → 应当回退 %SYS
 *   - 场景 C：只有文件（模拟没装 InterSystems 插件）→ 应当照旧可用
 *   - 场景 D：两边都没有 → 空列表
 *
 * 用法：node scripts/test-config.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const EXT_ROOT = path.join(__dirname, '..');
const OUT = path.join(EXT_ROOT, 'out', 'config.js');

// 假 home：把 ~/.iris-schema.json 指到临时目录，避免读真实的用户文件
const tmpHome = path.join(os.tmpdir(), 'iris-cfg-test-' + process.pid);
fs.mkdirSync(tmpHome, { recursive: true });

const realHomedir = os.homedir;
os.homedir = () => tmpHome;
// 场景 C/D 需要模拟"没装 InterSystems 插件"。config.js 在 inspect() 读不到时
// 会回退去读 settings.json 文件，所以必须把 APPDATA 也指向临时目录，
// 否则会读到本机真实配置，测试结果不可信。
const realAppData = process.env.APPDATA;
process.env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');

// ---- 假 vscode 模块 ----
let mockServers = null;
const fakeVscode = {
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k === 'configPath' ? '' : d),
      inspect: (k) => (k === 'intersystems.servers' && mockServers ? { globalValue: mockServers } : undefined),
    }),
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-fake';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode-fake'] = { id: 'vscode-fake', filename: 'vscode-fake', loaded: true, exports: fakeVscode };

const { loadProfiles, resetProfileCache } = require(OUT);

let bad = 0;
function check(name, cond, detail) {
  console.log(' ', cond ? 'PASS' : 'FAIL', name, cond ? '' : `  实际=${JSON.stringify(detail)}`);
  if (!cond) bad++;
}

function writeIrisSchema(obj) {
  fs.writeFileSync(path.join(tmpHome, '.iris-schema.json'), JSON.stringify(obj, null, 2), 'utf8');
}
function clearIrisSchema() {
  const p = path.join(tmpHome, '.iris-schema.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ---------------------------------------------------------------- 场景 A
console.log('\n--- A: VS Code 设置 + 文件并存（同名合并） ---');
mockServers = {
  '138': {
    webServer: { scheme: 'https', host: '10.0.0.138', port: 52773 },
    description: '测试库',
    username: '_SYSTEM',
    password: 'secret',
  },
  vscodeOnly: {
    webServer: { scheme: 'http', host: '10.0.0.9', port: 52773 },
    username: '_SYSTEM',
    password: 'sys',
  },
  superOnly: { superServer: { host: '10.0.0.10', port: 1972 } },
};
writeIrisSchema({
  connections: {
    // 与 VS Code 同名：namespace 应当从这份补齐
    '138': { host: '10.0.0.138', web_port: 52773, protocol: 'https', namespace: 'APP', user: '_SYSTEM', password: 'secret' },
    // 文件独有：应当也保留
    local: { host: '127.0.0.1', web_port: 52773, protocol: 'http', namespace: 'APP', user: '_system', password: 'sys', description: 'local server' },
  },
  default: '138',
});
resetProfileCache();
let src = loadProfiles();
const names = src.profiles.map((p) => p.profile);
console.log('  加载到:', names.join(', '), '| 默认:', src.defaultProfile, '| 来源:', src.vscodePath);

check('138 存在', names.includes('138'), names);
check('VS Code 独有条目被保留', names.includes('vscodeOnly'), names);
check('文件独有条目被保留', names.includes('local'), names);
check('只配 superServer 的条目被跳过（连不上 Atelier）', !names.includes('superOnly'), names);
check('138 的 namespace 从文件补齐为 APP', src.profiles.find((p) => p.profile === '138')?.namespace === 'APP', src.profiles.find((p) => p.profile === '138'));
check('138 的 host 以 VS Code 为准', src.profiles.find((p) => p.profile === '138')?.host === '10.0.0.138');
check('138 标记 namespace 显式', src.profiles.find((p) => p.profile === '138')?.namespaceExplicit === true);
check('vscodeOnly 无 namespace → %SYS', src.profiles.find((p) => p.profile === 'vscodeOnly')?.namespace === '%SYS');
check('vscodeOnly 标记 namespace 非显式', src.profiles.find((p) => p.profile === 'vscodeOnly')?.namespaceExplicit === false);
check('origin 区分来源', src.profiles.find((p) => p.profile === '138')?.origin === 'vscode' && src.profiles.find((p) => p.profile === 'local')?.origin === 'file');
check('default 沿用文件指定的 138', src.defaultProfile === '138');

// ---------------------------------------------------------------- 场景 B
console.log('\n--- B: 只有 VS Code 设置，条目无 namespace ---');
clearIrisSchema();
mockServers = {
  dev: { webServer: { scheme: 'https', host: '10.1.1.1', port: 52773 }, username: 'u', password: 'p' },
};
resetProfileCache();
src = loadProfiles();
check('加载 1 条', src.profiles.length === 1, src.profiles.length);
check('namespace 回退 %SYS', src.profiles[0].namespace === '%SYS');
check('path 为 null（无文件来源）', src.path === null);
check('vscodePath 有值', !!src.vscodePath);

// ---------------------------------------------------------------- 场景 C
console.log('\n--- C: 只有文件（未装 InterSystems 插件） ---');
mockServers = null;
writeIrisSchema({
  connections: { only: { host: '1.2.3.4', web_port: 52773, protocol: 'https', namespace: 'APP', user: 'u', password: 'p' } },
  default: 'only',
});
resetProfileCache();
src = loadProfiles();
check('加载 1 条', src.profiles.length === 1, src.profiles.length);
check('default 正确', src.defaultProfile === 'only');
check('path 指向文件', !!src.path);

// ---------------------------------------------------------------- 场景 D
console.log('\n--- D: 两边都没有 ---');
clearIrisSchema();
resetProfileCache();
src = loadProfiles();
check('空列表', src.profiles.length === 0);
check('defaultProfile 为 null', src.defaultProfile === null);

// ---------------------------------------------------------------- 清理
os.homedir = realHomedir;
if (realAppData === undefined) delete process.env.APPDATA;
else process.env.APPDATA = realAppData;
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
