# iris schema 开发说明

功能和使用方法见 [README.md](README.md)（英文版 [README.en.md](README.en.md)），这里只讲实现、验证和打包。

## 目录

```
src/
  extension.ts     激活入口、命令注册、侧边栏
  panel.ts         查询面板：创建 webview、内联 CSS/JS、消息分发
  config.ts        连接配置加载与合并
  irisClient.ts    IRIS Atelier / Web 网关客户端
  ops.ts           各种查询的实现（表结构、类定义、ER、DDL 等）
media/
  panel.css        面板样式
  panel.js         面板前端逻辑
  mermaid.min.js   本地打包的 mermaid（v10.9.8，MIT）
scripts/           验证脚本，多数不需要真实 IRIS
```

运行时零第三方依赖，业务代码只用 Node 内置的 `http` / `https`。

## 开始

```bash
npm install
npm run compile     # 或 npm run watch
```

按 `F5` 启动扩展开发宿主。

## 实现要点

### 表结构不查 INFORMATION_SCHEMA

从类定义推导，不依赖 `%Development` 权限，还能算出一列落在哪个 Global 节点上，例如
`$P(^ARC("ALIAS",ALIAS_RowId),"^",6)`。这个信息 `INFORMATION_SCHEMA` 给不了。

### CSP 会话复用

IRIS 的 Atelier 接口如果每个请求都不带 Cookie，网关爱新建会话并持续占用 license，几十次请求就能把 license 吃光。客户端按「协议 + 主机 + 端口 + 命名空间 + 账号」维护 Cookie，建立会话后只带 Cookie，401 时回退 Basic；面板关闭时主动发 `IRISLogout=end` 立即释放。

### 网关卡顿和业务错误要分开处理

Atelier 偶发 5xx，这类值得重试。但 `HTTP 400 + ERROR #16006: Document 'xxx.cls' name is invalid` 表示类根本不存在，重试只会变成「等 3 次 400ms 再报个看不懂的 404」。插件对 400 直接快速失败，提示「类 X 在命名空间 Y 中不存在」。

### 并发是安全的

同一会话 12 个并发 `GET doc`，连跑 3 轮全部成功（171–280ms），比串行快一倍以上。ER 图里的被引用表因此全部并发拉取。

### ER 图快在少查，不在并发

ER 只关心图结构和主键，走轻量解析路径，跳过「引用类型 → 目标类 IdKey 类型」的递归（那条链会沿引用一路取几十个类的定义）；被引用表的类名已知，直接按类名取定义，省掉 `%Dictionary` 的表名反查。

实测 `ARC_Alias` 的 ER 图从 109 次请求 / 5.2s 降到 10 次请求 / 1.6s。

### ER 图的类型名必须拍平

mermaid 的 `erDiagram` 词法里 `ATTRIBUTE_WORD` 不认 `.`，而 IRIS 的引用列类型是 `User.SSUser` 这种带包名的写法，直接写进去整张图会报 `Parse error: Expecting 'ATTRIBUTE_WORD', got '.'`。

生成时统一拍平成 `User_SSUser`，原名通过 `meta.typeAliases` 传给渲染端，鼠标停在单元格上能看到原类型。

另外注释块（`--` 开头的 Global 明细）前必须留空行，否则渲染端摘掉注释行后会把 `}` 和残留内容粘在一行。

### mermaid 随扩展打包

`media/mermaid.min.js` 是本地文件，不访问任何 CDN。HIS 内网一般上不了外网，走 CDN 会直接退化成纯文本显示。

升级时从 `node_modules/mermaid/dist/mermaid.min.js` 覆盖即可（MIT 许可，见 `media/mermaid.LICENSE`）。

### 渲染失败要说真原因

早先 `catch` 里一律写「可能是离线环境」，但 mermaid 已经本地打包，离线不影响渲染，真正失败几乎都是语法问题。现在直接显示 `err.message` 原文，并区分「解析错误」和「资源缺失」两种提示。

## 界面样式

视觉参考 Bootstrap 5：卡片分层、1px 边框配轻阴影、紧凑表单控件、4px 栅格间距。颜色全部映射到 VS Code 主题变量，深色 / 浅色 / 高对比度都能自动适配，不用为每种主题单独调色。

关键只有一条：**令牌层**。`media/panel.css` 顶部把 `--vscode-*` 收敛成一组语义令牌，下游规则只引用令牌，不直接碰 `--vscode-*`。

```css
:root {
  --surface: var(--vscode-editor-background);          /* 页面底 */
  --surface-raised: var(--vscode-sideBar-background);  /* 工具条 / 卡片头 */
  --surface-sunken: var(--vscode-editorWidget-background);
  --text: var(--vscode-foreground);
  --text-muted: var(--vscode-descriptionForeground);
  --accent: var(--vscode-button-background);
  --line: var(--vscode-panel-border);
  --focus-ring: var(--vscode-focusBorder);
  --sp-1..4: 4/8/12/16px;
  --radius-sm / --radius / --radius-lg: 4/6/10px;
}
```

换主题时只换 VS Code 主题即可，CSS 一行都不用改。

### 深色和高对比度下要额外处理的地方

这几件事单靠 `--vscode-*` 拿不到，必须显式判断主题：

| 问题 | 处理 |
|---|---|
| 黑底上压黑影会变成「洞」 | `body.vscode-dark` 里把 `--shadow*` 加深而不是提亮，斑马纹 `--zebra` 提亮到 3.5% |
| 浅色主题的 `panel-border` 淡到看不见，表格没有行节奏 | 表格线单独用 `--table-line`（前景色混 16%），不复用 `--line` |
| 高对比度下 `color-mix` / 半透明 / 阴影都不可靠 | `body.vscode-high-contrast` 里退回纯色 + `--vscode-contrastBorder`，阴影设 `none` |
| HC 主题的 `button-background` 常与页面背景同为纯黑，实心按钮「消失」 | 引入 `--accent-border`：普通主题为 `transparent`，HC 下指向 `contrastBorder`，给主按钮和分段控件选中态补一圈轮廓 |

最后一条是实测发现的：HC 主题下「查询」按钮和「表结构」选中态都只剩文字，因为它们用纯黑底压在纯黑页面上。光看代码看不出来，只有截图才看得到。

### 表头排序与过滤

全部在 `media/panel.js` 的 `renderTable` 里，纯内存操作。`<thead>` 和 `<table>` 只建一次，`paint()` 只重绘 `<tbody>` 和表头指示器，粘顶表头和横向滚动位置都不会被打断。

三个容易踩的点：

- **重绘必须写回 `data-jump`**。行点击是委托在父容器上的 `closest('tr[data-jump]')`，重绘丢了属性，排完序再点行会静默失效。
- **`th` 的 `nowrap / overflow:hidden / text-overflow:ellipsis` 要放开**，否则过滤输入框被裁掉。单行省略下沉到内部的 `.th-label`。
- **`.th-bar` 用 `inline-flex` 而不是 `flex`**。块级 flex 会撑满整格，`grow` 列里排序指示器会被推到格子最右边，跟列名分家。

## 图标

两张图，来源都是仓库根的 `icon.png`：

| 文件 | 用途 | 说明 |
|---|---|---|
| `media/icon-marketplace.png` | 扩展列表缩略图（`package.json` 的 `icon`）、面板标题栏 | 原图，512×512 |
| `media/activity.svg` | 活动栏图标 | 从原图量出来重画的单色版 |

活动栏那个不能直接贴 PNG。VS Code 会用主题前景色覆盖图标颜色并把它当蒙版，贴一张带深蓝底的位图，结果是一块看不出内容的脏方块。所以只保留 `IR` 字标，抠掉底色和三圈弧（24px 下三圈弧全糊成噪点），由脚本从原图测量后生成：

```bash
node scripts/build-activity-icon.js   # 重新生成 activity.svg（含 12 项几何自检）
node scripts/preview-activity-icon.js # 渲成 PNG 预览，24px / 16px / 明暗两版
```

那 12 项自检不是摆设，常量抄错（比如把 R 的碗部最宽点当成底部）会直接报错退出，而不是默默产出畸形图标。

`R` 用两层 path 画：实心部分 `fill-rule="nonzero"` 求并集，字腔单独一层 `evenodd` 挖空。四块塞进同一个 `evenodd` path 会让重叠区翻转两次变成实心，字腔只剩一个三角形。

## 侧边栏

活动栏图标（`viewsContainers.activitybar`）在 VS Code 里只能承载视图，不能直接绑命令，所以点图标是展开侧边栏，真正的入口是侧边栏里的按钮。

侧边栏按钮靠 `postMessage` 回扩展侧执行命令，因此视图必须 `enableScripts: true` 且 CSP 的 `script-src` 允许内联。任一条件不满足，按钮会静默失效（点了没反应也不报错），`scripts/test-sidebar-click.js` 用无头 Chrome 真点一次来守这条线。

## 验证

### 需要真实 IRIS 的

```bash
node scripts/smoke-ops.js 138              # profile 名取自 intersystems.servers / ~/.iris-schema.json
node scripts/dump-udl.js 138 User.ARCAlias # 打印类定义原文
node scripts/show-profiles.js              # 打印当前加载到的连接（含来源与 ns 是否显式）
node scripts/test-config.js                # 4 个场景 21 项断言，覆盖合并 / 优先级 / 默认值
```

### 不需要 IRIS 的面板回归

```bash
node scripts/render-panel.js        # 用假 vscode API 调 renderHtml，导出 panel-real.html，断言 CSP 与资源注入
node scripts/test-panel-style.js    # 57 项样式断言：主题安全 / 令牌体系 / HC 适配 / Bootstrap 语言
node scripts/e2e-panel.js           # 伪宿主灌数据，跑通四个视图 + 排序/过滤 + 行跳转，20 项断言
node scripts/shot-panel.js          # 无头 Chrome 截图空态
node scripts/test-sidebar.js        # 侧边栏：命名 / 图标规范 / 两种配置状态 / 消息分发
node scripts/test-sidebar-click.js  # 侧边栏按钮：无头 Chrome 真点一次，验证 postMessage 发出
node scripts/verify-er.js DHC_AntCVReport  # ER 图回归：断言无点号，并用真 mermaid 渲染一遍
```

`e2e-panel.js` 把 `acquireVsCodeApi` 换成假实现，通过真实的 `message` 事件回灌数据，覆盖的是 `panel.js` 里真实的渲染分支（表格、代码块、mermaid SVG）。它会记录回灌之后新发出的消息，用来断言排序和过滤没有触发新的查询请求。

### 样式截图

```bash
node scripts/shot-theme.js              # 深色 + 浅色 × 7 个场景
node scripts/shot-theme.js hc           # 高对比度
node scripts/shot-theme.js dark --keep  # 保留生成的场景页，供其他脚本复用
node scripts/shot-narrow.js 380 dark    # 指定宽度 / 主题截图
node scripts/test-narrow-head.js        # 量 380 / 520 / 760 / 1100 四档下结果头是否完整可见
node scripts/shot-narrow-th.js          # 量 380 / 520 下表头过滤框是否溢出单元格
```

`test-panel-style.js` 守的是约束而不是像素：不许出现写死的十六进制色（`#ffffff` 在浅色主题下等于白字白底）、`--surface` / `--text` / `--accent` 必须由 `--vscode-*` 驱动、深色和 HC 分支必须存在、不许有 JS 里不存在的悬空类名。这些都做过反向验证：故意把 `--accent` 写死成 `#3b82f6`，或者删掉 `body.vscode-dark` 整块，断言会立刻变红。

> 坑：`shot-narrow` 最初用 `--window-size=380` 截图，看起来正常，其实 Chrome 把视口抬到了 500px，所以「380px 也没问题」是个假结论。现在改用 DevTools Protocol 的 `Emulation.setDeviceMetricsOverride`，它没有最小宽度限制。

## 打包

```bash
npm run package          # 产出 iris-schema-<版本>.vsix，版本取自 package.json
code --install-extension iris-schema-1.0.0.vsix --force
```

扩展标识是 `CryzeZz.iris-schema`，由 `package.json` 的 `publisher` 和 `name` 拼成。改 `publisher` 相当于换了一个新扩展，旧标识下装的那份不会被覆盖，要先卸载：

```bash
code --uninstall-extension local.iris-schema
```
