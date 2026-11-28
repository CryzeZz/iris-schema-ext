/**
 * 检查 package.json 里所有 %key% 占位符在两种语言下都能解析到文案。
 *
 * 为什么要单独查：nls 文件缺失或 key 拼错时，VS Code 不会报错，
 * 而是把 `%cmd.foo.title%` 原样显示在命令面板和设置界面上 ——
 * 这只有在用户装完之后才会发现，发版前必须拦住。
 *
 * 用法：node scripts/test-nls.js
 */
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const LOCALES = {
  en: 'package.nls.json',
  'zh-cn': 'package.nls.zh-cn.json',
};

// 递归收集所有形如 "%key%" 的字符串
function collect(obj, out = []) {
  if (typeof obj === 'string') {
    const m = obj.match(/^%([^%]+)%$/);
    if (m) out.push(m[1]);
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) collect(v, out);
  }
  return out;
}

const keys = Array.from(new Set(collect(pkg)));
let bad = 0;
console.log(`package.json 里共有 ${keys.length} 个 nls 占位符\n`);

for (const [lang, file] of Object.entries(LOCALES)) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) {
    console.log(`  FAIL ${lang}: 缺少 ${file}`);
    bad++;
    continue;
  }
  const table = JSON.parse(fs.readFileSync(p, 'utf8'));
  const missing = keys.filter((k) => typeof table[k] !== 'string' || !table[k]);
  const extra = Object.keys(table).filter((k) => !keys.includes(k));
  const okCount = keys.length - missing.length;
  if (missing.length) {
    console.log(`  FAIL ${lang}: ${missing.length} 个占位符无文案 → ${missing.join(', ')}`);
    bad++;
  } else {
    console.log(`  PASS ${lang}: ${okCount}/${keys.length} 个占位符均有文案`);
  }
  if (extra.length) {
    // 不算失败：留着旧 key 不影响功能，但发出来提醒清理
    console.log(`  （${lang} 多出未引用的 key：${extra.join(', ')}）`);
  }
}

// 两种语言的 key 集合要一致，否则英文用户会看到缺项
const en = JSON.parse(fs.readFileSync(path.join(root, LOCALES.en), 'utf8'));
const zh = JSON.parse(fs.readFileSync(path.join(root, LOCALES['zh-cn']), 'utf8'));
const onlyEn = Object.keys(en).filter((k) => !(k in zh));
const onlyZh = Object.keys(zh).filter((k) => !(k in en));
const sameKeys = onlyEn.length === 0 && onlyZh.length === 0;
console.log(
  ' ',
  sameKeys ? 'PASS' : 'FAIL',
  '两种语言的 key 集合一致',
  sameKeys ? '' : `仅英文=${onlyEn.join(',')} 仅中文=${onlyZh.join(',')}`
);
if (!sameKeys) bad++;

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
