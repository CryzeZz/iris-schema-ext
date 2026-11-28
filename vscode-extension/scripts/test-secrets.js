/**
 * 验证密码来源的优先级与会话行为（不需要真实 VS Code）。
 *
 * 用假的 vscode 模块 + 内存版 SecretStorage 驱动 config.js / secrets.js：
 *   - 场景 A：keychain 里有密码 → 覆盖配置里的明文
 *   - 场景 B：keychain 没有、配置里有明文 → 用明文，标记为 config
 *   - 场景 C：两边都没有 → password 为空，标记为 none
 *   - 场景 D：keychain 抛错（Linux 无 libsecret）→ 不崩，回退明文，且只告警一次
 *   - 场景 E：同一主机不同端口/不同账号 → 各自的密码互不覆盖
 *   - 场景 F：forgetAllPasswords → 清空后回到明文/none
 *
 * 为什么这些要单独测：密码来源判断错了不会报错，只会「莫名其妙用错了账号」，
 * 或者把 keychain 里正确的密码盖成配置里的旧明文 —— 这类问题在界面上完全看不出来。
 *
 * 用法：node scripts/test-secrets.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const EXT_ROOT = path.join(__dirname, '..');

// 假 home：避免读到本机真实的 ~/.iris-schema.json
const tmpHome = path.join(os.tmpdir(), 'iris-sec-test-' + process.pid);
fs.mkdirSync(tmpHome, { recursive: true });
const realHomedir = os.homedir;
os.homedir = () => tmpHome;
const realAppData = process.env.APPDATA;
process.env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');

// ---- 内存版 SecretStorage ----
const store = new Map();
let throwOnAccess = false;
let warnings = [];

const fakeSecrets = {
  async get(k) {
    if (throwOnAccess) throw new Error('keychain unavailable');
    return store.get(k);
  },
  async store(k, v) {
    if (throwOnAccess) throw new Error('keychain unavailable');
    store.set(k, v);
  },
  async delete(k) {
    if (throwOnAccess) throw new Error('keychain unavailable');
    store.delete(k);
  },
  onDidChange: () => ({ dispose() {} }),
};

let mockServers = null;
const fakeVscode = {
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k === 'configPath' ? '' : d),
      inspect: (k) => (k === 'intersystems.servers' && mockServers ? { globalValue: mockServers } : undefined),
    }),
  },
  window: {
    showWarningMessage: async (m) => {
      warnings.push(m);
    },
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-fake';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode-fake'] = { id: 'vscode-fake', filename: 'vscode-fake', loaded: true, exports: fakeVscode };

const config = require(path.join(EXT_ROOT, 'out', 'config.js'));
const secrets = require(path.join(EXT_ROOT, 'out', 'secrets.js'));
const i18n = require(path.join(EXT_ROOT, 'out', 'i18n.js'));
i18n.setLanguage('zh');

const ctx = { secrets: fakeSecrets };
config.setExtensionContext(ctx);

let bad = 0;
function check(name, cond, detail) {
  console.log(' ', cond ? 'PASS' : 'FAIL', name, cond ? '' : `  实际=${JSON.stringify(detail)}`);
  if (!cond) bad++;
}

function writeIrisSchema(obj) {
  fs.writeFileSync(path.join(tmpHome, '.iris-schema.json'), JSON.stringify(obj, null, 2), 'utf8');
}

async function load() {
  config.resetProfileCache();
  return config.applyStoredPasswords(config.loadProfiles());
}

(async () => {
  // ---------------------------------------------------------------- A
  console.log('\n--- A: keychain 有密码，配置文件也有明文 ---');
  mockServers = {
    '138': {
      webServer: { scheme: 'https', host: '10.0.0.138', port: 52773 },
      username: '_SYSTEM',
      password: 'plain-in-settings',
    },
  };
  await secrets.savePassword(ctx, '10.0.0.138', 52773, '_SYSTEM', 'from-keychain', true);
  let src = await load();
  let p = src.profiles.find((x) => x.profile === '138');
  check('keychain 覆盖了配置明文', p.password === 'from-keychain', p.password);
  check('标记来源为 keychain', p.passwordSource === 'keychain', p.passwordSource);

  // ---------------------------------------------------------------- B
  console.log('\n--- B: keychain 没有，配置有明文 ---');
  await secrets.forgetPassword(ctx, '10.0.0.138', 52773, '_SYSTEM');
  src = await load();
  p = src.profiles.find((x) => x.profile === '138');
  check('回退到配置明文', p.password === 'plain-in-settings', p.password);
  check('标记来源为 config', p.passwordSource === 'config', p.passwordSource);

  // ---------------------------------------------------------------- C
  console.log('\n--- C: 两边都没有密码 ---');
  mockServers = {
    noPwd: { webServer: { scheme: 'https', host: '10.0.0.20', port: 52773 }, username: '_SYSTEM' },
  };
  src = await load();
  p = src.profiles[0];
  check('password 为空串', p.password === '', p.password);
  check('标记来源为 none', p.passwordSource === 'none', p.passwordSource);

  // ---------------------------------------------------------------- D
  console.log('\n--- D: keychain 不可用（如 Linux 无 libsecret） ---');
  throwOnAccess = true;
  warnings = [];
  src = await load();
  p = src.profiles[0];
  check('不抛错，正常返回', !!p);
  check('回退到 none', p.passwordSource === 'none', p.passwordSource);
  check('只告警一次', warnings.length <= 1, warnings);

  // 不可用期间写入也不应抛错
  let threw = false;
  try {
    await secrets.savePassword(ctx, '10.0.0.20', 52773, '_SYSTEM', 'x', true);
  } catch {
    threw = true;
  }
  check('keychain 不可用时写入不抛错', !threw);
  check('写入的值仍在会话内可用', (await secrets.getStoredPassword(ctx, '10.0.0.20', 52773, '_SYSTEM')) === 'x');

  throwOnAccess = false;
  secrets.invalidateSessionPassword('10.0.0.20', 52773, '_SYSTEM');

  // ---------------------------------------------------------------- E
  console.log('\n--- E: 同主机不同端口 / 不同账号各存各的 ---');
  // 注意：上面的 D 场景把「keychain 不可用」这个标记置位了，模块里它是粘性的
  // （真实运行时也是——装不上 libsecret 不会自己好起来）。这里要测正常读写，
  // 所以换一个新的模块实例，相当于重启一次 VS Code。
  delete require.cache[path.join(EXT_ROOT, 'out', 'secrets.js')];
  delete require.cache[path.join(EXT_ROOT, 'out', 'config.js')];
  const secrets2 = require(path.join(EXT_ROOT, 'out', 'secrets.js'));
  const config3 = require(path.join(EXT_ROOT, 'out', 'config.js'));
  config3.setExtensionContext(ctx);

  store.clear();
  mockServers = {};
  await secrets2.savePassword(ctx, 'h1', 52773, 'A', 'pwd-52773-A', true);
  await secrets2.savePassword(ctx, 'h1', 1972, 'A', 'pwd-1972-A', true);
  await secrets2.savePassword(ctx, 'h1', 52773, 'B', 'pwd-52773-B', true);
  check('端口区分', (await secrets2.getStoredPassword(ctx, 'h1', 52773, 'A')) === 'pwd-52773-A');
  check('另一端口', (await secrets2.getStoredPassword(ctx, 'h1', 1972, 'A')) === 'pwd-1972-A');
  check('账号区分', (await secrets2.getStoredPassword(ctx, 'h1', 52773, 'B')) === 'pwd-52773-B');
  check('账号大小写不敏感', (await secrets2.getStoredPassword(ctx, 'h1', 52773, 'a')) === 'pwd-52773-A');

  // ---------------------------------------------------------------- F
  console.log('\n--- F: forgetAllPasswords ---');
  const n = await secrets2.forgetAllPasswords(ctx, [
    { host: 'h1', web_port: 52773, user: 'A' },
    { host: 'h1', web_port: 1972, user: 'A' },
    { host: 'h1', web_port: 52773, user: 'B' },
  ]);
  check('删掉 3 条', n === 3, n);
  check('之后读不到 A@52773', (await secrets2.getStoredPassword(ctx, 'h1', 52773, 'A')) === null);
  check('之后读不到 B@52773', (await secrets2.getStoredPassword(ctx, 'h1', 52773, 'B')) === null);

  // ---------------------------------------------------------------- G
  console.log('\n--- G: 没注入 context 时降级为只读明文 ---');
  // 用一个新的模块实例模拟"脚本/测试环境没调 setExtensionContext"
  delete require.cache[path.join(EXT_ROOT, 'out', 'config.js')];
  const config2 = require(path.join(EXT_ROOT, 'out', 'config.js'));
  mockServers = {
    only: {
      webServer: { scheme: 'https', host: '10.0.0.30', port: 52773 },
      username: 'u',
      password: 'from-settings',
    },
  };
  config2.resetProfileCache();
  const src2 = await config2.applyStoredPasswords(config2.loadProfiles());
  check('不注入 ctx 也能标记来源', src2.profiles[0].passwordSource === 'config', src2.profiles[0].passwordSource);
  check('密码来自配置明文', src2.profiles[0].password === 'from-settings', src2.profiles[0].password);

  // ---------------------------------------------------------------- 清理
  os.homedir = realHomedir;
  if (realAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = realAppData;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
  process.exit(bad ? 1 : 0);
})();
