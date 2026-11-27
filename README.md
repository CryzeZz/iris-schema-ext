# iris schema

A VS Code extension for browsing InterSystems IRIS table structures, class definitions and relationships.

在 VS Code 里查看 InterSystems IRIS 的表结构、类定义和表间关系。

## 文档

| 文档 | 内容 |
|---|---|
| [README.md](vscode-extension/README.md) | 功能与使用说明（中文） |
| [README.en.md](vscode-extension/README.en.md) | Features and usage (English) |
| [DEVELOPMENT.md](vscode-extension/DEVELOPMENT.md) | 实现要点、验证脚本、打包流程 |

## 安装

```bash
cd vscode-extension
npm install
npm run compile
npm run package
code --install-extension iris-schema-1.0.0.vsix --force
```

或者按 `F5` 启动扩展开发宿主直接调试。

## 目录

```
vscode-extension/
  src/         扩展主逻辑（TypeScript）
  media/       面板前端（panel.js / panel.css）、mermaid、图标
  scripts/     验证脚本，多数不需要真实 IRIS
```

扩展本体在 `vscode-extension/` 子目录，仓库根只放图标和这份入口说明。
