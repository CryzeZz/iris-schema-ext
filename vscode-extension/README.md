# iris schema

Browsing InterSystems IRIS table structures, class definitions and relationships inside VS Code.

在 VS Code 里查看 InterSystems IRIS 的表结构、类定义和表间关系。

---

Connection details are read straight from VS Code's own `intersystems.servers` setting, so the extension works as soon as it is installed — no second copy of your connection list to maintain.

连接信息直接读 VS Code 自己的 `intersystems.servers` 配置，装好插件就能查，不用另外维护一份连接清单。

> The interface follows your VS Code display language: Chinese for `zh-*`, English for everything else.
>
> 界面语言跟随 VS Code：VS Code 是中文界面就显示中文，其余语言显示英文。

## Opening the panel

Any one of these:

- Click the `IR` icon in the Activity Bar, then click **Open Query Panel** in the sidebar that opens
- Open a `.cls` file, then click the icon on the right of the editor title bar
- Press `Ctrl+Shift+P` and run **iris schema: Open Query Panel**

Clicking the Activity Bar icon opens a sidebar rather than running a command — that is a VS Code limitation, not a missing feature.

<details>
<summary>打开查询面板</summary>

任选一种：

- 左侧活动栏点 `IR` 图标，在展开的侧边栏里点「打开查询面板」
- 打开 `.cls` 文件后，点编辑器标题栏右侧的图标
- 按 `Ctrl+Shift+P`，执行 **iris schema: 打开查询面板**

活动栏的图标点开是侧边栏，不能直接绑命令，这是 VS Code 本身的限制。

</details>

## The four views

Four buttons at the top switch between views. Type a table or class name and click **Query**, or just press `Enter`.

| View | Input | Result |
| --- | --- | --- |
| **Columns** | table or class name | Property name, type, length, primary key flag and description for each column, plus the Global node the column lives on. The index list and foreign keys follow below |
| **Class** | class name | The full `.cls` source, ready to copy, open in an editor or save to a file |
| **ER** | table name | A relationship diagram with referenced tables, primary keys and labelled edges |
| **Sample** | table name | A `SELECT TOP 100 *` sample, exportable as CSV |

In the **List all tables** result, clicking any row jumps to that table's structure.

<details>
<summary>四种视图</summary>

顶部四个按钮切换视图，输入表名或类名后点「查询」（也可以直接按回车）。

| 视图 | 输入 | 结果 |
| --- | --- | --- |
| **Columns** 表结构 | 表名或类名 | 每列的属性名、类型、长度、是否主键、说明，以及该列落在哪个 Global 节点上；下方另附索引清单和外键关系 |
| **Class** 类定义 | 类名 | `.cls` 源码全文，可复制、在编辑器中打开或另存为文件 |
| **ER** ER 图 | 表名 | 表关系图，含被引用表、主键和关系标签 |
| **Sample** 数据 | 表名 | `SELECT TOP 100 *` 采样，可导出 CSV |

在「列出全部表」的结果里，点任意一行会直接跳到那张表的结构。

</details>

### Sorting and filtering a table

Table results — table structure, data, table lists — get a sort arrow next to each column name. Click once for ascending, again for descending, a third time to return to the original order. Each column also has a filter box underneath: type a keyword and rows containing it are kept as you type. Filters on several columns combine. Sorting and filtering work on the current result only — no new query is sent to the database. The status bar shows the row count, which turns into `2 / 5 rows` once a filter is active; exporting to CSV at that point exports the rows you can see.

<details>
<summary>表格的排序和过滤</summary>

表格类的结果（表结构、数据、表列表等），列名右侧有排序箭头，点一下升序、再点降序、第三次恢复原顺序。每列下方还有一个过滤框，输入关键字即时筛出包含该关键字的行，多列可以叠加。排序和过滤只在当前这次结果里做，不会重新查询数据库。状态栏会显示当前行数，过滤后变成「2 / 5 行」；此时导出 CSV，导出的是当前看到的这几行。

</details>

## More queries

The `⋯` menu at the top right:

- **List all tables** — filterable by keyword
- **Find tables by column name** — e.g. find which tables `UpdateUser` appears in
- **Generate CREATE TABLE DDL** — derived from the class definition, with primary and foreign keys
- **Free SQL** — write your own query; only `SELECT` and `WITH` are allowed. Press `Ctrl+Enter` to run
- **Test connection** — check that account, port and namespace actually match

<details>
<summary>更多查询</summary>

右上角 `⋯` 菜单：

- **列出全部表** — 可按关键字过滤
- **按列名找表** — 例如查 `UpdateUser` 出现在哪些表里
- **生成建表 DDL** — 从类定义反推 `CREATE TABLE`，带主键和外键
- **自由 SQL** — 手写查询，只允许 `SELECT` 和 `WITH`；输入框里按 `Ctrl+Enter` 执行
- **测试连接** — 确认账号、端口、命名空间是否配对

</details>

## Connection settings

The extension prefers `intersystems.servers` from VS Code settings. If the InterSystems extension is installed, Server Manager maintains that setting for you — just add your server there. To write it by hand:

```jsonc
"intersystems.servers": {
  "dev": {
    "webServer": { "scheme": "https", "host": "iris.example.com", "port": 52773 },
    "username": "_SYSTEM",
    "description": "Development"
  }
}
```

**`password` may be omitted.** The first time you connect, the extension asks for it; choose "Remember password" and it is stored in the OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret). You will not be asked again, and no plaintext password needs to exist in any config file.

Password priority is "keychain > plaintext in config": existing configs with a plaintext password keep working, but once you enter a password and choose to remember it, the keychain value takes over. The status bar tells you which one is in use — "password in config file" means a plaintext password is still sitting in your settings.

Passwords live in VS Code's `SecretStorage`, which is **isolated per extension** — this extension cannot read the passwords the InterSystems extension stored, and vice versa. That is deliberate: cross-extension access would mean calling another extension's private API, which can break on any upgrade, and it is not our data to touch.

To wipe them, run **iris schema: Clear Stored Passwords**. Editing `settings.json` will not do it — the passwords are not stored there. The **⋯** menu in the panel toolbar lets you set a new password for the current server, which is useful when the password changed or when migrating away from a plaintext one.

<details>
<summary>连接配置</summary>

插件优先用 VS Code 设置里的 `intersystems.servers`。装了 InterSystems 插件的话，这部分由 Server Manager 维护，在它里面添加服务器就行。需要手写时，在 `settings.json` 里加：

```jsonc
"intersystems.servers": {
  "dev": {
    "webServer": { "scheme": "https", "host": "iris.example.com", "port": 52773 },
    "username": "_SYSTEM",
    "description": "Development"
  }
}
```

**`password` 可以不写。** 第一次连这台服务器时会弹出输入框，勾选「记住密码」就存进系统钥匙串（Windows 凭据管理器 / macOS Keychain / Linux libsecret），之后不再询问，配置文件里也不需要出现明文。

密码来源的优先级是「钥匙串 > 配置里的明文」：已经有明文密码的老配置照常能用，但只要输过一次并选择记住，钥匙串里的值就会接管。状态栏会标出当前用的是哪种 —— 「密码在配置文件中」说明这条连接的明文密码还留在配置里，可以考虑删掉。

密码存在 VS Code 的 `SecretStorage` 里，它**按扩展隔离** —— 本插件读不到 InterSystems 扩展存的密码，反之亦然。这是有意为之：跨扩展读取只能调对方的私有 API，对方一升级就可能失效，也不该动别人的私有数据。

想彻底忘掉这些密码，执行命令 **iris schema: 清除已保存的密码**。直接改 `settings.json` 是清不掉的，因为密码根本不在那里。在面板右上角的 **⋯** 菜单里可以给当前服务器重新设置密码（用于密码改了、或者想从明文迁移到钥匙串）。

</details>

### The config file

If you have used the `iris-schema` skill before, the extension also reads `~/.iris-schema.json`. The two sources are merged by server name: on a name collision the VS Code setting wins, while fields missing there — `namespace`, for instance — are filled in from the config file. Servers that exist in only one of the two are all listed. In other words, you do not have to copy `namespace` into VS Code settings: if the config file says `APP`, that is what the extension uses.

The namespace default, in order: whatever the config file says; otherwise whatever was last selected for that server; otherwise `%SYS`.

Entries that only define `superServer` (port 1972) are skipped — the extension talks to the Web Gateway, usually on 52773, not to the superserver port.

After editing the config, run **iris schema: Reload Connections** and the server and namespace lists refresh immediately. Hovering a server in the drop-down shows whether the entry came from VS Code settings or from the config file.

<details>
<summary>配置文件</summary>

如果之前用过 `iris-schema` 技能，插件也会读 `~/.iris-schema.json`，两份配置按服务器名合并：同名的以 VS Code 设置为准，VS Code 里缺的字段（比如 `namespace`）用配置文件补齐，两边各自独有的服务器都会列出来。也就是说不必把 `namespace` 抄到 VS Code 设置里，配置文件里写了 `APP`，插件就会用上。

命名空间的默认值：配置文件里写了就用配置文件的；没写就用这台服务器上次查询时选的；都没有则是 `%SYS`。

只配了 `superServer`（1972 端口）的条目会被跳过 —— 插件走 Web 网关（通常 52773），不是超级服务器端口。

配置改完，执行命令 **iris schema: 重新加载连接配置**，面板里的服务器和命名空间列表会立刻刷新。服务器下拉框的悬停提示会注明这条连接是从 VS Code 设置读的，还是从配置文件读的。

</details>

## About the interface

Colours follow the current VS Code theme. Dark, light and high-contrast themes all display correctly with no extra setup.

<details>
<summary>关于界面</summary>

配色跟随 VS Code 当前主题，深色、浅色、高对比度主题都能正常显示，不需要额外设置。

</details>

## Known limitations

- The ER diagram expands only directly referenced tables (foreign keys, parent/child relationships, `*DR` reference columns), up to 8 of them, and does not fan out recursively
- Embedded objects and collection properties are typed by the referenced class's RowID type; deep inheritance chains may not always be exact
- Free SQL only gets a statement-level read-only check. It is not database-level permission control

<details>
<summary>已知限制</summary>

- ER 图只展开直接引用的表（外键、父子关系、`*DR` 引用列），最多 8 张，不做多级扩散
- 嵌入式对象和集合属性按被引用类的 RowID 类型推断，复杂的继承链可能不完全准确
- 自由 SQL 只做了语句层面的只读校验，不是数据库权限控制

</details>
