// 由 media/icon-marketplace.png（即仓库根的 icon.png）生成活动栏单色图标 media/activity.svg。
//
// 为什么要脚本：
//   活动栏里图标实际只显示 24px，形状差 1px 就认不出来。所以每个控制点都从原图量出来，
//   并带自检（常量写错会直接报错退出，而不是默默产出一个畸形的图标）。
//   换了原图重跑一次即可同步。
//
// 原 logo 的构成与取舍：
//   深蓝圆角底   → 丢弃。图标颜色由 VS Code 用主题前景色覆盖，硬编码颜色会变成脏块
//   三圈同心弧   → 丢弃。24px 下三圈弧糊成噪点，舍掉反而更利落
//   白色 IR 字标 → 保留。唯一在 24px 还成立的识别符
//
// 测量结果（512x512 原图，判定「墨迹」= 不透明且三通道都 >232）：
//   I：x 192..219（宽 28），y 216..305（高 90），方角实心竖条
//   R：x 241..328，y 216..305；竖干 x 241..268；字腔 x 269..~297；
//      碗部最宽在 y≈234..243（右边界 321），到 y=265 收窄到 300（碗部收口）；
//      右腿自 y=269 起分离，斜向外扩到 y=305 的 328
//
// 画法：R 用「外轮廓 + 字腔内轮廓」两条子路径，配合 fill-rule="evenodd" 挖出字腔。
//       直接把碗部与腿都填实会让 R 变成一坨（第一版就是，预览图里 R 中间是实的）。
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'media', 'icon-marketplace.png');
const OUT_SVG = path.join(ROOT, 'media', 'activity.svg');

const r2 = (n) => Math.round(n * 100) / 100;

// 直接从原图量出来的关键坐标（原图像素）
const G = {
  yTop: 216, yBot: 305,
  ix0: 192, ix1: 219,
  rx0: 241, rStemX1: 268,
  bowlMaxY: 238, bowlMaxR: 321, // 碗部最宽处
  bowlEndY: 265, bowlEndR: 300, // 碗部与竖干相接、收窄处
  legStartY: 269, legEndR: 328,
  // 字腔（counter）：x 269..297 上下界随碗内圆走
  ctrX0: 269, ctrX1: 297,
  ctrY0: 234, ctrY1: 252,
};

(async () => {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const ch = info.channels;
  const isInk = (x, y) => {
    const i = (y * W + x) * ch;
    // 阈值 232：字标纯白(255)，最内圈弧是浅蓝白(~202,224,236)。
    // 用 190 会把弧一起算进来，包围盒就错了（这坑踩过一次）。
    return data[i + 3] > 200 && data[i] > 232 && data[i + 1] > 232 && data[i + 2] > 232;
  };
  const rowRange = (y, xa, xb) => {
    let l = -1, r = -1;
    for (let x = xa; x <= xb; x++) if (isInk(x, y)) { if (l < 0) l = x; r = x; }
    return { l, r };
  };

  // ---- 自检 ----
  // 两组断言：点是/否（像素级），行右边界是否等于期望值（形状级）。
  // 之前把两种混成一个数组，取值比较拿坐标当了 want，报了一堆假失败。
  const pointChecks = [
    ['I 左上角有墨', G.ix0, G.yTop, true],
    ['I 左边外一格空白', G.ix0 - 1, G.yTop, false],
    ['I 右下角有墨', G.ix1, G.yBot, true],
    ['I 右边外一格空白', G.ix1 + 1, G.yBot, false],
    ['R 竖干顶有墨', G.rx0, G.yTop, true],
    ['竖干 x268 处有墨', G.rStemX1, 240, true],
    ['字腔 x269 开始空', G.rStemX1 + 1, 240, false],
    ['字腔中心空', (G.ctrX0 + G.ctrX1) >> 1, (G.ctrY0 + G.ctrY1) >> 1, false],
  ];
  const edgeChecks = [
    ['顶行最右 = 295', G.yTop, 295],
    ['碗部最宽 = 321', G.bowlMaxY, G.bowlMaxR],
    ['碗部收口 = 300', G.bowlEndY, G.bowlEndR],
    ['底行最右 = 328', G.yBot, G.legEndR],
  ];
  const failed = [];
  for (const [name, x, y, want] of pointChecks) {
    const got = isInk(x, y);
    if (got !== want) failed.push({ name, x, y, want, got });
  }
  for (const [name, y, want] of edgeChecks) {
    const got = rowRange(y, G.rx0, 340).r;
    if (got !== want) failed.push({ name, y, want, got });
  }
  if (failed.length) {
    console.error('自检失败：常量与原图不符，先修正 G 再生成\n', failed);
    process.exit(1);
  }
  console.log(`自检通过（${pointChecks.length + edgeChecks.length} 项）：I/R 几何与原图一致`);

  // ---- 映射到 24x24 ----
  const glyphW = G.legEndR - G.ix0 + 1;   // 137
  const glyphH = G.yBot - G.yTop + 1;     // 90
  const MARGIN = 3.1;                     // 24px 里留 3.1 边 → 字标约 17.8×11.7
  const s = (24 - MARGIN * 2) / glyphW;
  const cx = (G.ix0 + G.legEndR) / 2;
  const cy = (G.yTop + G.yBot) / 2;
  const X = (x) => r2((x - cx) * s + 12);
  const Y = (y) => r2((y - cy) * s + 12);

  const top = Y(G.yTop);
  const bot = Y(G.yBot);
  const h = r2(bot - top);
  const stemR = X(G.rStemX1);        // 竖干右边
  const bowlR = X(G.bowlMaxR);       // 碗部最右
  const bowlMidY = Y(G.bowlMaxY);    // 碗部最宽处
  const bowlEndR = X(G.bowlEndR);    // 碗部收口 x
  const bowlEndY = Y(G.bowlEndY);    // 碗部收口 y
  const legY = Y(G.legStartY);       // 右腿分离处
  const legR = X(G.legEndR);         // 右腿终端

  // I：方角竖条
  const ix = X(G.ix0);
  const iw = r2(X(G.ix1) - X(G.ix0));
  const iY = r2(top + 0.05);
  const iH = r2(h - 0.1);

  // ---- R ----
  // 用 4 条子路径描述，配合 fill-rule="evenodd"：
  //   (1) 竖干           矩形
  //   (2) 碗部           上半的圆角块（顶边 + 右侧半圆 + 底边收回竖干）
  //   (3) 右腿           从竖干中下段斜出去的楔形
  //   (4) 字腔           上圆下平的 D 形，挖空
  // 为什么不画成一个整体外轮廓：原图碗部(y 252..268)与右腿之间有一道横桥是实心的，
  // 只有 y>=269 才重新出现缺口。一笔画会丢掉这个结构，R 会退化成一块梯形。
  const rStem = [
    `M${X(G.rx0)} ${bot}`,
    `H${stemR}`,
    `V${top}`,
    `H${X(G.rx0)}`,
    'Z',
  ].join(' ');

  // 碗部：顶边右端到 295（原图顶行右侧），右侧走一段近似圆弧到收口，再沿收口回竖干
  const bowlRight = X(295);
  const bowlBotY = Y(258);            // 碗部底边（横桥起点）
  const rBowl = [
    `M${X(G.rx0)} ${top}`,
    `H${r2(bowlRight - (bowlR - bowlRight) * 0.4)}`,
    `C${bowlR} ${r2(top + 0.2)} ${bowlR} ${r2(bowlMidY + 1.4)} ${r2(bowlRight)} ${r2(bowlBotY - 0.5)}`,
    `C${r2(bowlRight - 1.1)} ${r2(bowlBotY)} ${r2(stemR + 1.2)} ${r2(bowlBotY)} ${stemR} ${r2(bowlBotY)}`,
    `V${top}`,
    'Z',
  ].join(' ');

  // 右腿：上沿从竖干 y≈(原图 262) 出发，右下斜到底部 328；内沿从底部缺口左端回到竖干
  const legTopY = Y(262);
  const legFootW = r2((legR - stemR) * 0.30);
  const rLeg = [
    `M${r2(stemR - 0.05)} ${r2(legTopY)}`,
    `L${r2(legR)} ${bot}`,
    `H${r2(legR - legFootW)}`,
    `L${r2(stemR - 0.05)} ${Y(276)}`,
    'Z',
  ].join(' ');

  // 字腔：左平、右侧半圆的 D 形。
  // 逐行实测（原图）：左边界恒为 269，右侧从 y234 的 287 鼓到 y240~244 的 294，
  // 再收到 y251 的 285 —— 18 行高、半宽约 13，是个横椭圆的一半。
  // 早先当成「正圆顶 + 竖直下身」，圆顶只占顶部 3px，视觉上像个被切了一刀的洞。
  const ctrX0 = X(G.ctrX0);
  const ctrX1 = X(G.ctrX1);
  const ctrTop = Y(G.ctrY0);
  const ctrBot = Y(G.ctrY1);
  const ctrRx = r2(ctrX1 - ctrX0);
  const ctrRy = r2((ctrBot - ctrTop) / 2);
  const rCounter = [
    `M${ctrX0} ${ctrBot}`,
    `V${ctrTop}`,
    `A${ctrRx} ${ctrRy} 0 0 1 ${ctrX0} ${ctrBot}`,
    'Z',
  ].join(' ');

  const svg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- 由 scripts/build-activity-icon.js 从 media/icon-marketplace.png 生成，勿手改。
       活动栏图标会被 VS Code 用主题前景色覆盖，所以必须单色：只用 currentColor，不要写死颜色。

       R 分两层画，不是随意拆的：
         第 1 层 竖干+碗部+右腿 用 nonzero 求「并集」—— 几个块互相压着是好事，不会出现缝
         第 2 层 字腔 单独用 evenodd 挖空
       如果把四块塞进同一个 path 再开 evenodd，竖干与字腔重叠的那片会被翻转两次变成实心，
       字腔就只剩一个三角形（这个 bug 出过一版，预览图一眼能看出来）。 -->
  <g fill="currentColor">
    <rect x="${ix}" y="${iY}" width="${iw}" height="${iH}" />
    <path fill-rule="nonzero" d="${rStem} ${rBowl} ${rLeg}" />
    <path fill-rule="evenodd" d="${rCounter}" />
  </g>
</svg>
`;

  fs.writeFileSync(OUT_SVG, svg, 'utf8');
  console.log('几何', { top, bot, h, ix, iw, stemR, bowlR, bowlMidY, bowlRight, bowlBotY, legTopY, legR });
  console.log('写入 media/activity.svg');
})();
