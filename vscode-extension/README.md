# iris schema

在 VS Code 里查看 InterSystems IRIS 的表结构、类定义和表间关系。

Browsing InterSystems IRIS table structures, class definitions and relationships inside VS Code.

连接信息直接读 VS Code 自己的 `intersystems.servers` 配置，装好插件就能查，不用另外维护一份连接清单。

Connection details are read straight from VS Code's own `intersystems.servers` setting, so the extension works as soon as it is installed — no second copy of your connection list to maintain.

> 界面语言跟随 VS Code：VS Code 是中文界面就显示中文，其余语言显示英文。
>
> The interface follows your VS Code display language: Chinese for `zh-*`, English for everything else.

## 打开查询面板 / Opening the panel

任选一种：

Any one of these:

- 左侧活动栏点 `IR` 图标，在展开的侧边栏里点「打开查询面板」
- 打开 `.cls` 文件后，点编辑器标题栏右侧的图标
- 按 `Ctrl+Shift+P`，执行 **iris schema: 打开查询面板**

---

- Click the `IR` icon in the Activity Bar, then click **Open Query Panel** in the sidebar that opens
- Open a `.cls` file, then click the icon on the right of the editor title bar
- Press `Ctrl+Shift+P` and run **iris schema: Open Query Panel**

活动栏的图标点开是侧边栏，不能直接绑命令，这是 VS Code 本身的限制。

Clicking the Activity Bar icon opens a sidebar rather than running a command — that is a VS Code limitation, not a missing feature.

## 四种视图 / The four views

顶部四个按钮切换视图，输入表名或类名后点「查询」（也可以直接按回车）。

Four buttons at the top switch between views. Type a table or class name and click **Query**, or just press `Enter`.

| 视图 / View | 输入 / Input | 结果 / Result |
| --- | --- | --- |
| **Columns** 表结构 | 表名或类名 / table or class name | 每列的属性名、类型、长度、是否主键、说明，以及该列落在哪个 Global 节点上；下方另附索引清单和外键关系。Property name, type, length, primary key flag and description for each column, plus the Global node the column lives on. The index list and foreign keys follow below |
| **Class** 类定义 | 类名 / class name | `.cls` 源码全文，可复制、在编辑器中打开或另存为文件。The full `.cls` source, ready to copy, open in an editor or save to a file |
| **ER** ER 图 | 表名 / table name | 表关系图，含被引用表、主键和关系标签。A relationship diagram with referenced tables, primary keys and labelled edges |
| **Sample** 数据 | 表名 / table name | `SELECT TOP 100 *` 采样，可导出 CSV。A `SELECT TOP 100 *` sample, exportable as CSV |

在「列出全部表」的结果里，点任意一行会直接跳到那张表的结构。

In the **List all tables** result, clicking any row jumps to that table's structure.

### 表格的排序和过滤 / Sorting and filtering a table

表格类的结果（表结构、数据、表列表等），列名右侧有排序箭头，点一下升序、再点降序、第三次恢复原顺序。每列下方还有一个过滤框，输入关键字即时筛出包含该关键字的行，多列可以叠加。

Table results — table structure, data, table lists — get a sort arrow next to each column name. Click once for ascending, again for descending, a third time to return to the original order. Each column also has a filter box underneath: type a keyword and rows containing it are kept as you type. Filters on several columns combine.

排序和过滤只在当前这次结果里做，不会重新查询数据库。

Sorting and filtering work on the current result only. No new query is sent to the database.

状态栏会显示当前行数，过滤后变成「2 / 5 行」。此时导出 CSV，导出的是当前看到的这几行。

The status bar shows the row count, which turns into `2 / 5 rows` once a filter is active. Exporting to CSV at that point exports the rows you can see.

## 更多查询 / More queries

右上角 `⋯` 菜单：

The `⋯` menu at the top right:

- **列出全部表** — 可按关键字过滤。List all tables, filterable by keyword.
- **按列名找表** — 例如查 `UpdateUser` 出现在哪些表里。Find which tables a column name appears in, e.g. `UpdateUser`.
- **生成建表 DDL** — 从类定义反推 `CREATE TABLE`，带主键和外键。Derive a `CREATE TABLE` from the class definition, with primary and foreign keys.
- **自由 SQL** — 手写查询，只允许 `SELECT` 和 `WITH`。Write your own query; only `SELECT` and `WITH` are allowed.
- **测试连接** — 确认账号、端口、命名空间是否配对。Check that account, port and namespace actually match.

自由 SQL 的输入框里按 `Ctrl+Enter` 执行。

In the free SQL box, press `Ctrl+Enter` to run.

## 连接配置 / Connection settings

插件优先用 VS Code 设置里的 `intersystems.servers`。装了 InterSystems 插件的话，这部分由 Server Manager 维护，在它里面添加服务器就行。

The extension prefers `intersystems.servers` from VS Code settings. If the InterSystems extension is installed, Server Manager maintains that setting for you — just add your server there.

需要手写时，在 `settings.json` 里加 / To write it by hand, add this to `settings.json`:

```jsonc
"intersystems.servers": {
  "dev": {
    "webServer": { "scheme": "https", "host": "iris.example.com", "port": 52773 },
    "username": "_SYSTEM",
    "password": "******",
    "description": "Development"
  }
}
```

如果之前用过 `iris-schema` 技能，插件也会读 `~/.iris-schema.json`，两份配置按服务器名合并：同名的以 VS Code 设置为准，VS Code 里缺的字段（比如 `namespace`）用配置文件补齐，两边各自独有的服务器都会列出来。

If you have used the `iris-schema` skill before, the extension also reads `~/.iris-schema.json`. The two sources are merged by server name: on a name collision the VS Code setting wins, while fields missing there — `namespace`, for instance — are filled in from the config file. Servers that exist in only one of the two are all listed.

也就是说不必把 `namespace` 抄到 VS Code 设置里，配置文件里写了 `APP`，插件就会用上。

In other words, you do not have to copy `namespace` into VS Code settings. If the config file says `APP`, that is what the extension uses.

命名空间的默认值：配置文件里写了就用配置文件的；没写就用这台服务器上次查询时选的；都没有则是 `%SYS`。

The namespace default, in order: whatever the config file says; otherwise whatever was last selected for that server; otherwise `%SYS`.

只配了 `superServer`（1972 端口）的条目会被跳过 —— 插件走 Web 网关（通常 52773），不是超级服务器端口。

Entries that only define `superServer` (port 1972) are skipped — the extension talks to the Web Gateway, usually on 52773, not to the superserver port.

配置改完，执行命令 **iris schema: 重新加载连接配置**，面板里的服务器和命名空间列表会立刻刷新。服务器下拉框的悬停提示会注明这条连接是从 VS Code 设置读的，还是从配置文件读的。

After editing the config, run **iris schema: Reload Connections** and the server and namespace lists refresh immediately. Hovering a server in the drop-down shows whether the entry came from VS Code settings or from the config file.

## 关于界面 / About the interface

配色跟随 VS Code 当前主题，深色、浅色、高对比度主题都能正常显示，不需要额外设置。

Colours follow the current VS Code theme. Dark, light and high-contrast themes all display correctly with no extra setup.

## 已知限制 / Known limitations

- ER 图只展开直接引用的表（外键、父子关系、`*DR` 引用列），最多 8 张，不做多级扩散。The ER diagram expands only directly referenced tables (foreign keys, parent/child relationships, `*DR` reference columns), up to 8 of them, and does not fan out recursively.
- 嵌入式对象和集合属性按被引用类的 RowID 类型推断，复杂的继承链可能不完全准确。Embedded objects and collection properties are typed by the referenced class's RowID type; deep inheritance chains may not always be exact.
- 自由 SQL 只做了语句层面的只读校验，不是数据库权限控制。Free SQL only gets a statement-level read-only check. It is not database-level permission control.
