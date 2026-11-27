const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  const file = 'file:///' + path.resolve(__dirname, '..', 'preview.html').replace(/\\/g, '/');
  await page.goto(file);
  await page.waitForTimeout(1200);

  const outdir = path.join(__dirname, '..', 'screenshots');
  require('fs').mkdirSync(outdir, { recursive: true });

  // 1) 表结构视图
  await page.screenshot({ path: path.join(outdir, '01-describe.png') });
  const rowCount = await page.locator('table.grid tbody tr').count();
  const title = await page.locator('.result-title').first().textContent().catch(() => '');
  console.log('表结构视图: 行数 =', rowCount, ' 标题 =', title);

  // 2) 表清单视图
  await page.evaluate(() => window.__demo('tables'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outdir, '02-tables.png') });
  console.log('表清单视图: 行数 =', await page.locator('table.grid tbody tr').count());

  // 3) 空态
  await page.reload();
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    document.getElementById('result').innerHTML =
      '<div class="placeholder"><div class="ph-title">结果</div><div class="ph-sub">选择服务器与命名空间，填入表名后点击「查询」</div></div>';
  });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(outdir, '03-empty.png') });

  console.log('控制台错误:', errs.length ? errs.join('\n') : '无');
  await browser.close();
})().catch((e) => {
  console.error('截图失败:', e.message);
  process.exit(1);
});
