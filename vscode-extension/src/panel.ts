import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { findProfile, loadProfilesCached, ProfileEntry } from './config';
import { execute, OpRequest } from './ops';
import { logout, namespaces, ConnConfig } from './irisClient';

interface PanelState {
  profile: string | null;
  namespace: string | null;
  mode: 'describe' | 'udl' | 'er' | 'sample';
  keyword: string;
}

/** globalState 里存「每个服务器上次用过的命名空间」 */
const LAST_NS_KEY = 'irisSchema.lastNamespaceByProfile';

export class IrisPanel {
  static current: IrisPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly ctx: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private state: PanelState = {
    profile: null,
    namespace: null,
    mode: 'describe',
    keyword: '',
  };
  private nsCache = new Map<string, string[]>();
  private busy = false;

  /**
   * 每个服务器上次用过的命名空间。
   *
   * Server Manager 的 intersystems.servers 条目不写 namespace，而本插件几乎都在
   * APP 之类的业务库上工作。把它存进 globalState，下次打开面板自动回到上次的库，
   * 不用每次重新选。
   */
  private lastNs(): Record<string, string> {
    return this.ctx.globalState.get<Record<string, string>>(LAST_NS_KEY) || {};
  }

  private rememberNs(profile: string | null, namespace: string | null): void {
    if (!profile || !namespace) return;
    const map = { ...this.lastNs(), [profile]: namespace };
    void this.ctx.globalState.update(LAST_NS_KEY, map);
  }

  /** 该服务器应当默认选中的命名空间：显式配置 > 上次用过 > %SYS */
  private preferredNs(profile: string | null, configured: string): string {
    if (!profile) return configured;
    const remembered = this.lastNs()[profile];
    return remembered || configured;
  }

  static createOrShow(ctx: vscode.ExtensionContext): void {
    if (IrisPanel.current) {
      IrisPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'irisSchemaPanel',
      'iris schema',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
      }
    );
    IrisPanel.current = new IrisPanel(panel, ctx);
  }

  private constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext) {
    this.panel = panel;
    this.ctx = ctx;
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    // 与 package.json 的 icon 指向同一份文件：面板标题栏和扩展列表用同一张图，
    // 打包时只多占一个条目，不重复占体积。
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'iris-schema@256.png');
  }

  /** 命令 "重新加载连接配置" 后调用。 */
  reloadProfiles(): void {
    this.nsCache.clear();
    this.post({ type: 'profiles', ...this.profilePayload() });
  }

  private profilePayload() {
    const src = loadProfilesCached();
    return {
      profiles: src.profiles.map((p) => ({
        name: p.profile,
        host: p.host,
        port: p.web_port,
        protocol: p.protocol,
        user: p.user,
        // 带上前端要默认选中的命名空间（上次用过 / 显式配置）
        namespace: this.preferredNs(p.profile, p.namespace),
        description: p.description || '',
        origin: p.origin || 'file',
      })),
      default: src.defaultProfile,
      configPath: src.vscodePath || src.path || null,
      state: this.state,
    };
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private resolveProfile(name: string | null): ProfileEntry {
    const src = loadProfilesCached();
    const p = findProfile(src, name);
    if (!p) {
      const err: any = new Error(
        '未找到连接配置。请在 VS Code 设置里添加 intersystems.servers（Server Manager），或在用户目录创建 ~/.iris-schema.json。'
      );
      err.code = 'NO_PROFILE';
      throw err;
    }
    return p;
  }

  private connCfg(profile: string | null, namespace: string | null): ConnConfig {
    const p = this.resolveProfile(profile);
    const cfg: ConnConfig = { ...p, namespace: namespace || p.namespace };
    delete (cfg as any).profile;
    return cfg;
  }

  private async onMessage(msg: any): Promise<void> {
    try {
      switch (msg?.type) {
        case 'ready':
          this.post({ type: 'profiles', ...this.profilePayload() });
          return;
        case 'loadNamespaces':
          await this.loadNamespaces(msg.profile);
          return;
        case 'query':
          await this.runQuery(msg);
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(String(msg.text || ''));
          this.post({ type: 'toast', text: '已复制到剪贴板' });
          return;
        case 'saveUdl':
          await this.saveUdl(msg.text, msg.suggested);
          return;
        case 'openAsFile':
          await this.openTextDocument(String(msg.text || ''), msg.language);
          return;
        default:
          return;
      }
    } catch (e) {
      this.post({ type: 'error', text: (e as Error).message || String(e), candidates: (e as any).candidates });
    }
  }

  private async loadNamespaces(profile: string | null): Promise<void> {
    const p = this.resolveProfile(profile);
    const want = this.preferredNs(p.profile, p.namespace);
    const cached = this.nsCache.get(p.profile);
    if (cached) {
      this.post({ type: 'namespaces', profile: p.profile, namespaces: cached, current: want });
      return;
    }
    const cfg: ConnConfig = { ...p };
    delete (cfg as any).profile;
    // 列命名空间本身也走 Atelier，需要一个能用的库；优先用用户上次的选择
    cfg.namespace = want;
    const list = await namespaces(cfg);
    this.nsCache.set(p.profile, list);
    this.post({ type: 'namespaces', profile: p.profile, namespaces: list, current: want });
  }

  private async runQuery(msg: any): Promise<void> {
    if (this.busy) {
      this.post({ type: 'toast', text: '上一次查询还在进行中…' });
      return;
    }
    const { profile, namespace, mode, keyword } = msg;
    this.state = { profile, namespace, mode, keyword };
    // 记住这次用的库，下次打开面板直接回到这里
    this.rememberNs(profile, namespace);
    const cfg = this.connCfg(profile, namespace);

    this.busy = true;
    this.post({ type: 'busy', on: true });
    const started = Date.now();
    try {
      const req: OpRequest = this.buildRequest(msg);
      const result = await execute(cfg, req);
      const elapsed = Date.now() - started;
      this.post({
        type: 'result',
        result,
        elapsed,
        target: {
          profile,
          namespace: cfg.namespace,
          host: cfg.host,
          port: cfg.web_port,
        },
      });
    } finally {
      this.busy = false;
      this.post({ type: 'busy', on: false });
    }
  }

  private buildRequest(msg: any): OpRequest {
    const { mode, keyword, schema, table, sql, limit } = msg;
    switch (mode) {
      case 'udl':
        return { op: 'udl', schema, table: keyword || table, limit };
      case 'er':
        return { op: 'er', schema, table: keyword || table, limit };
      case 'sample':
        return { op: 'sample', schema, table: keyword || table, limit };
      case 'tables':
        return { op: 'tables', keyword: keyword || '', limit };
      case 'findColumn':
        return { op: 'findColumn', keyword: keyword || '', limit };
      case 'ddl':
        return { op: 'ddl', schema, table: keyword || table, limit };
      case 'sql':
        return { op: 'sql', sql: sql || keyword, limit };
      case 'test':
        return { op: 'test', table: keyword || table };
      case 'describe':
      default:
        return { op: 'describe', schema, table: keyword || table, limit };
    }
  }

  private async saveUdl(text: string, suggested?: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      filters: { 'ObjectScript': ['cls'], '所有文件': ['*'] },
      saveLabel: '保存类定义',
      defaultUri: suggested
        ? vscode.Uri.file(suggested)
        : vscode.workspace.workspaceFolders
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'Class.cls')
          : undefined,
    });
    if (!uri) return;
    fs.writeFileSync(uri.fsPath, text, 'utf8');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async openTextDocument(text: string, language?: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content: text, language: language || 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const mediaDir = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const nonce = makeNonce();

    const cssPath = vscode.Uri.joinPath(mediaDir, 'panel.css').fsPath;
    const jsPath = vscode.Uri.joinPath(mediaDir, 'panel.js').fsPath;
    // 内联比外链更稳（避免 localResourceRoots 配错导致白屏）
    const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
    const js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';

    // mermaid 以本地文件形式提供：HIS 内网通常访问不了 CDN，
    // 之前用 jsdelivr 的方案在离线环境会直接退化成"原始定义文本"。
    const mermaidUri = webview
      .asWebviewUri(vscode.Uri.joinPath(mediaDir, 'mermaid.min.js'))
      .toString();

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      // mermaid.min.js 从 localResourceRoots 加载，因此需要放行 cspSource
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>iris schema</title>
<style>${css}</style>
</head>
<body>
<div id="app">
  <header class="toolbar">
    <div class="seg" id="modeSeg" role="tablist">
      <button class="seg-btn active" data-mode="describe">表结构</button>
      <button class="seg-btn" data-mode="udl">类定义</button>
      <button class="seg-btn" data-mode="er">ER 图</button>
      <button class="seg-btn" data-mode="sample">数据</button>
    </div>
    <select id="profileSel" title="服务器"></select>
    <select id="nsSel" title="命名空间"></select>
    <input id="keyword" type="text" placeholder="表名 / 类名，如 SQLUser.Patient" spellcheck="false" />
    <button id="queryBtn" class="primary">查询</button>
    <button id="moreBtn" class="icon" title="更多查询">⋯</button>
    <div id="moreMenu" class="menu hidden">
      <button data-mode="tables">列出全部表</button>
      <button data-mode="findColumn">按列名找表</button>
      <button data-mode="ddl">生成建表 DDL</button>
      <button data-mode="sql">自由 SQL</button>
      <button data-mode="test">测试连接</button>
    </div>
  </header>

  <div id="sqlBar" class="sqlbar hidden">
    <textarea id="sqlInput" rows="4" spellcheck="false" placeholder="-- 仅支持 SELECT / WITH 只读查询&#10;SELECT TOP 50 * FROM SQLUser.Patient"></textarea>
    <div class="sqlbar-actions">
      <button id="sqlRun" class="primary">执行</button>
      <button id="sqlClose">收起</button>
    </div>
  </div>

  <div id="statusbar" class="statusbar">
    <span id="targetInfo" class="muted">—</span>
    <span id="elapsed" class="muted"></span>
  </div>

  <main id="result" class="result">
    <div class="placeholder">
      <div class="ph-title">结果</div>
      <div class="ph-sub">选择服务器与命名空间，填入表名后点击「查询」</div>
    </div>
  </main>

  <div id="toast" class="toast hidden"></div>
  <div id="loading" class="loading hidden"><div class="spinner"></div><span>查询中…</span></div>
</div>
<!-- 本地 mermaid：离线/内网环境也能渲染 ER 图 -->
<script nonce="${nonce}" src="${mermaidUri}"></script>
<script nonce="${nonce}">${js}</script>
</body>
</html>`;
  }

  dispose(): void {
    IrisPanel.current = undefined;
    // 主动注销，立刻释放 license（否则要等会话超时回收）
    const src = loadProfilesCached();
    const p = findProfile(src, this.state.profile);
    if (p) {
      const cfg: ConnConfig = { ...p, namespace: this.state.namespace || p.namespace };
      delete (cfg as any).profile;
      void logout(cfg).catch(() => undefined);
    }
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
