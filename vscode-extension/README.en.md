# iris schema

Browse InterSystems IRIS table structures, class definitions and relationships inside VS Code.

Connection details are read straight from VS Code's own `intersystems.servers` setting, so the extension works as soon as it is installed — no second copy of your connection list to maintain.

[中文说明](README.md)

The panel UI is currently in Chinese only, so command titles, buttons and view names are quoted exactly as they appear on screen.

## Opening the panel

Any one of these:

- Click the `IR` icon in the Activity Bar, then click **打开查询面板** in the sidebar that opens
- Open a `.cls` file, then click the icon on the right of the editor title bar
- Press `Ctrl+Shift+P` and run **iris schema: 打开查询面板**

Clicking the Activity Bar icon opens a sidebar rather than running a command — that is a VS Code limitation, not a missing feature.

## The four views

Four buttons at the top switch between views. Type a table or class name and click **查询**, or just press `Enter`.

| View | Input | Result |
| --- | --- | --- |
| **表结构** (table structure) | Table or class name | Property name, type, length, primary key flag and description for each column, plus the Global node the column lives on. The index list and foreign keys follow below |
| **类定义** (class definition) | Class name | The full `.cls` source, ready to copy, open in an editor or save to a file |
| **ER 图** (ER diagram) | Table name | A relationship diagram with referenced tables, primary keys and labelled edges |
| **数据** (data) | Table name | A `SELECT TOP 100 *` sample, exportable as CSV |

In the **列出全部表** (list all tables) result, clicking any row jumps to that table's structure.

### Sorting and filtering a table

Table results — table structure, data, table lists — get a sort arrow next to each column name. Click once for ascending, again for descending, a third time to return to the original order. Each column also has a filter box underneath: type a keyword and rows containing it are kept as you type. Filters on several columns combine.

Sorting and filtering work on the current result only. No new query is sent to the database.

The status bar shows the row count, which turns into `2 / 5 行` once a filter is active. Exporting to CSV at that point exports the rows you can see.

## More queries

The `⋯` menu at the top right:

- **列出全部表** — list all tables, filterable by keyword
- **按列名找表** — find which tables a column name appears in, e.g. `UpdateUser`
- **生成建表 DDL** — derive a `CREATE TABLE` from the class definition, with primary and foreign keys
- **自由 SQL** — write your own query; only `SELECT` and `WITH` are allowed
- **测试连接** — check that account, port and namespace actually match

In the free SQL box, press `Ctrl+Enter` to run.

## Connection settings

The extension prefers `intersystems.servers` from VS Code settings. If the InterSystems extension is installed, Server Manager maintains that setting for you — just add your server there.

To write it by hand, add this to `settings.json`:

```jsonc
"intersystems.servers": {
  "dev": {
    "webServer": { "scheme": "https", "host": "10.0.0.138", "port": 52773 },
    "username": "_SYSTEM",
    "password": "******",
    "description": "测试库"
  }
}
```

If you have used the `iris-schema` skill before, the extension also reads `~/.iris-schema.json`. The two sources are merged by server name: on a name collision the VS Code setting wins, while fields missing there — `namespace`, for instance — are filled in from the config file. Servers that exist in only one of the two are all listed.

In other words, you do not have to copy `namespace` into VS Code settings. If the config file says `APP`, that is what the extension uses.

The namespace default, in order: whatever the config file says; otherwise whatever was last selected for that server; otherwise `%SYS`.

Entries that only define `superServer` (port 1972) are skipped — the extension talks to the Web Gateway, usually on 52773 or 2443, not to the superserver port.

After editing the config, run **iris schema: 重新加载连接配置** and the server and namespace lists refresh immediately. Hovering a server in the drop-down shows whether the entry came from VS Code settings or from the config file.

## About the interface

Colours follow the current VS Code theme. Dark, light and high-contrast themes all display correctly with no extra setup.

## Known limitations

- The ER diagram expands only directly referenced tables (foreign keys, parent/child relationships, `*DR` reference columns), up to 8 of them, and does not fan out recursively.
- Embedded objects and collection properties are typed by the referenced class's RowID type; deep inheritance chains may not always be exact.
- Free SQL only gets a statement-level read-only check. It is not database-level permission control.
