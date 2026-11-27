/**
 * 用本机真实配置打印加载结果，人工核对合并效果。
 * 用法：node scripts/show-profiles.js
 */
const path = require('path');
const Module = require('module');

const EXT_ROOT = path.join(__dirname, '..');

// 模拟真实扩展宿主：inspect() 返回空，让它走 settings.json 文件回退路径
const fake = { workspace: { getConfiguration: () => ({ get: (_k, d) => d, inspect: () => undefined }) } };

const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'vscode') return 'vscode-fake';
  return orig.call(this, r, ...a);
};
require.cache['vscode-fake'] = { id: 'vscode-fake', filename: 'vscode-fake', loaded: true, exports: fake };

const { loadProfiles } = require(path.join(EXT_ROOT, 'out', 'config.js'));

const s = loadProfiles();
console.log('VS Code 来源:', s.vscodePath || '（无）');
console.log('文件来源   :', s.path || '（无）');
console.log('默认服务器 :', s.defaultProfile, '｜ 共', s.profiles.length, '条\n');

for (const p of s.profiles) {
  const nsTag = p.namespaceExplicit ? '显式' : '默认';
  console.log(`  ${p.profile.padEnd(10)} ${p.protocol}://${p.host}:${p.web_port}  ns=${p.namespace} (${nsTag})  user=${p.user}  [${p.origin}]  ${p.description || ''}`);
}
