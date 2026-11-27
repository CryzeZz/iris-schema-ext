// 把活动栏图标渲成 PNG 预览，用于目视检查 24px 下是否还能认出来。
// 顺便渲一张「反色版本」（深底白字 / 白底黑字）确认 currentColor 在两种主题下都成立。
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'media', 'activity.svg');
const OUT = process.argv[2] || path.join(ROOT, '.icon-preview');

(async () => {
  // 读 SVG，把 currentColor 换成实际颜色再栅格化（sharp/librsvg 不认 currentColor）
  const raw = fs.readFileSync(SVG, 'utf8');

  // 24px 实际大小、放大 8 倍看细节、以及在 40px 活动栏宽度里的位置
  const variants = [
    { name: 'dark-24', color: '#cccccc', bg: '#333333', size: 24, scale: 8 },
    { name: 'light-24', color: '#616161', bg: '#f3f3f3', size: 24, scale: 8 },
    { name: 'dark-16', color: '#cccccc', bg: '#333333', size: 16, scale: 12 },
  ];

  const tiles = [];
  for (const v of variants) {
    // SVG 根节点已有 width/height，这里改写而不是追加，否则 height 会重复定义（XML 解析直接报错）
    const svg = raw
      .replace(/currentColor/g, v.color)
      .replace(/\bwidth="24"/, `width="${v.size}"`)
      .replace(/\bheight="24"/, `height="${v.size}"`);
    const png = await sharp(Buffer.from(svg), { density: 72 * v.scale })
      .resize(v.size * v.scale, v.size * v.scale, { kernel: 'nearest' })
      .flatten({ background: v.bg })
      .png()
      .toBuffer();
    tiles.push({ ...v, png });
    fs.writeFileSync(path.join(ROOT, `.icon-${v.name}.png`), png);
  }

  // 拼成一张对比图
  const pad = 16;
  const W = tiles.reduce((s, t) => s + t.size * t.scale + pad, pad);
  const H = Math.max(...tiles.map((t) => t.size * t.scale)) + pad * 2;
  let left = pad;
  const composites = tiles.map((t) => {
    const c = { input: t.png, left, top: pad };
    left += t.size * t.scale + pad;
    return c;
  });

  await sharp({
    create: { width: W, height: H, channels: 4, background: '#1e1e1e' },
  })
    .composite(composites)
    .png()
    .toFile(path.join(ROOT, '.icon-preview.png'));

  console.log('预览已生成：.icon-preview.png');
  console.log(tiles.map((t) => `${t.name} ${t.size}px`).join(' | '));
})();
