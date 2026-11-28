import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { applyStoredPasswords, findProfile, loadProfilesCached, ProfileEntry } from './config';
import { execute, OpRequest } from './ops';
import { logout, namespaces, ConnConfig } from './irisClient';
import { allMessages, getLanguage, t } from './i18n';
import { promptPassword, savePassword } from './secrets';

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
    void this.pushProfiles();
  }

  /** 重新读配置 + keychain 后推给前端。keychain 是异步的，所以这里也异步。 */
  private async pushProfiles(): Promise<void> {
    this.post({ type: 'profiles', ...(await this.profilePayload()) });
  }

  private async profilePayload() {
    const src = await applyStoredPasswords(loadProfilesCached());
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
        // 只暴露「有没有密码、从哪来」，绝不把密码本身发给 webview：
        // webview 是浏览器上下文，密码进去就等于落到 DOM/DevTools 里。
        passwordSource: p.passwordSource || 'none',
      })),
      default: src.defaultProfile,
      configPath: src.vscodePath || src.path || null,
      state: this.state,
    };
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  /** 按名字取 profile，并叠加 keychain 里的密码。 */
  private async resolveProfile(name: string | null): Promise<ProfileEntry> {
    const src = await applyStoredPasswords(loadProfilesCached());
    const p = findProfile(src, name);
    if (!p) {
      const err: any = new Error(t('err.noProfile'));
      err.code = 'NO_PROFILE';
      throw err;
    }
    return p;
  }

  /** 拼出可直接发请求的 ConnConfig：账号密码齐全，命名空间已定。 */
  private async connCfg(profile: string | null, namespace: string | null): Promise<ConnConfig> {
    const p = await this.resolveProfile(profile);
    const cfg: ConnConfig = { ...p, namespace: namespace || p.namespace };
    delete (cfg as any).profile;
    delete (cfg as any).passwordSource;
    delete (cfg as any).namespaceExplicit;
    delete (cfg as any).origin;
    return cfg;
  }

  /**
   * 确保拿到密码再发请求。
   *
   * 三种情况：
   * 1. 已从 keychain / 配置拿到密码 → 直接用；
   * 2. 没账号（user 为空）→ 报错，让用户先去配；
   * 3. 有账号没密码 → 弹框输入。
   *
   * 为什么第 3 种要弹框而不是直接拿空密码去请求：IRIS 对空密码返回 401，
   * 界面上只显示"认证失败"，用户根本看不出是"没配密码"还是"密码错了"。
   * 弹框把这件事变成一次明确的输入，也顺便给了保存到 keychain 的机会。
   */
  private async ensurePassword(p: ProfileEntry, reason?: string): Promise<ConnConfig> {
    if (!p.user) {
      const err: any = new Error(t('pwd.reasonNoUser'));
      err.code = 'NO_USER';
      throw err;
    }
    if (!p.password) {
      const value = await promptPassword(this.ctx, {
        profile: p.profile,
        user: p.user,
        host: p.host,
        port: p.web_port,
        reason,
      });
      // 取消必须中止：拿空密码去请求只会换来一个看不懂的 401
      if (value === undefined) {
        const err: any = new Error(t('pwd.cancelled'));
        err.code = 'PWD_CANCELLED';
        throw err;
      }
      p.password = value;
      p.passwordSource = 'keychain';
    }
    const cfg: ConnConfig = { ...p, namespace: p.namespace };
    delete (cfg as any).profile;
    delete (cfg as any).passwordSource;
    delete (cfg as any).namespaceExplicit;
    delete (cfg as any).origin;
    return cfg;
  }

  /**
   * 带凭据重试一次的执行封装。
   *
   * 首次请求如果因为密码失效被拒（401），会重新弹框问一次密码 ——
   * 这是"密码改了但 keychain 里还是旧的"最常见的表现，用户不必自己
   * 去翻菜单找"设置密码"。
   */
  private async executeWithAuth(
    profile: string | null,
    namespace: string | null,
    req: OpRequest
  ): Promise<{ cfg: ConnConfig; result: Awaited<ReturnType<typeof execute>> }> {
    const p = await this.resolveProfile(profile);
    p.namespace = namespace || p.namespace;
    const cfg = await this.ensurePassword(p);
    try {
      return { cfg, result: await execute(cfg, req) };
    } catch (e) {
      if (!isAuthError(e)) throw e;
      // 密码失效：清掉该账号的会话缓存，重新问一遍
      const old = cfg.password;
      p.password = '';
      p.passwordSource = 'none';
      const retryCfg = await this.ensurePassword(p, t('pwd.reasonExpired'));
      if (retryCfg.password === old) throw e;
      return { cfg: retryCfg, result: await execute(retryCfg, req) };
    }
  }

  private async onMessage(msg: any): Promise<void> {
    try {
      switch (msg?.type) {
        case 'ready':
          await this.pushProfiles();
          return;
        case 'loadNamespaces':
          await this.loadNamespaces(msg.profile);
          return;
        case 'query':
          await this.runQuery(msg);
          return;
        case 'setPassword':
          await this.setPassword(msg.profile);
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(String(msg.text || ''));
          this.post({ type: 'toast', text: t('notice.copied') });
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
      // 用户主动取消输入密码不是错误，别在结果区糊一片红
      if ((e as any)?.code === 'PWD_CANCELLED') {
        this.post({ type: 'toast', text: (e as Error).message });
        return;
      }
      this.post({ type: 'error', text: (e as Error).message || String(e), candidates: (e as any).candidates });
    }
  }

  /** 菜单里的「设置密码…」：直接重置该账号的密码，不管原来有没有。 */
  private async setPassword(profile: string | null): Promise<void> {
    const p = await this.resolveProfile(profile);
    if (!p.user) {
      this.post({ type: 'error', text: t('pwd.reasonNoUser') });
      return;
    }
    const value = await promptPassword(this.ctx, {
      profile: p.profile,
      user: p.user,
      host: p.host,
      port: p.web_port,
    });
    if (value === undefined) return;
    // promptPassword 内部已按用户选择写入 keychain 或会话缓存；
    // 这里再补一次"会话级"确认，确保本次运行立即生效（即使选了不记住）。
    await savePassword(this.ctx, p.host, p.web_port, p.user, value, true);
    // 密码换了，之前的会话 cookie 必然失效
    this.nsCache.clear();
    await logout({ ...p, password: value } as ConnConfig).catch(() => undefined);
    this.post({ type: 'toast', text: t('notice.passwordSaved') });
    await this.pushProfiles();
  }

  private async loadNamespaces(profile: string | null): Promise<void> {
    const p = await this.resolveProfile(profile);
    const want = this.preferredNs(p.profile, p.namespace);
    const cached = this.nsCache.get(p.profile);
    if (cached) {
      this.post({ type: 'namespaces', profile: p.profile, namespaces: cached, current: want });
      return;
    }
    // 列命名空间本身也走 Atelier，需要一个能用的库；优先用用户上次的选择
    const cfg = await this.ensurePassword({ ...p, namespace: want });
    const list = await namespaces(cfg);
    this.nsCache.set(p.profile, list);
    this.post({ type: 'namespaces', profile: p.profile, namespaces: list, current: want });
  }

  private async runQuery(msg: any): Promise<void> {
    if (this.busy) {
      this.post({ type: 'toast', text: t('notice.busy') });
      return;
    }
    const { profile, namespace, mode, keyword } = msg;
    this.state = { profile, namespace, mode, keyword };
    // 记住这次用的库，下次打开面板直接回到这里
    this.rememberNs(profile, namespace);

    this.busy = true;
    this.post({ type: 'busy', on: true });
    const started = Date.now();
    try {
      const req: OpRequest = this.buildRequest(msg);
      const { cfg, result } = await this.executeWithAuth(profile, namespace, req);
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
      filters: { 'ObjectScript': ['cls'], [t('common.allFiles', 'All files')]: ['*'] },
      saveLabel: t('common.saveClass', 'Save class definition'),
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
<html lang="${getLanguage() === 'zh' ? 'zh-CN' : 'en'}">
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
      <button class="seg-btn active" data-mode="describe">${t('mode.describe')}</button>
      <button class="seg-btn" data-mode="udl">${t('mode.udl')}</button>
      <button class="seg-btn" data-mode="er">${t('mode.er')}</button>
      <button class="seg-btn" data-mode="sample">${t('mode.sample')}</button>
    </div>
    <select id="profileSel" title="${t('toolbar.server')}"></select>
    <select id="nsSel" title="${t('toolbar.namespace')}"></select>
    <input id="keyword" type="text" placeholder="${attr(t('toolbar.keywordPlaceholder'))}" spellcheck="false" />
    <button id="queryBtn" class="primary">${t('toolbar.query')}</button>
    <button id="moreBtn" class="icon" title="${t('toolbar.more')}">⋯</button>
    <div id="moreMenu" class="menu hidden">
      <button data-mode="tables">${t('menu.tables')}</button>
      <button data-mode="findColumn">${t('menu.findColumn')}</button>
      <button data-mode="ddl">${t('menu.ddl')}</button>
      <button data-mode="sql">${t('menu.sql')}</button>
      <button data-mode="test">${t('menu.test')}</button>
      <button data-mode="password" id="setPwdBtn">${t('menu.password')}</button>
    </div>
  </header>

  <div id="sqlBar" class="sqlbar hidden">
    <textarea id="sqlInput" rows="4" spellcheck="false" placeholder="${attr(t('sql.placeholder'))}"></textarea>
    <div class="sqlbar-actions">
      <button id="sqlRun" class="primary">${t('sql.run')}</button>
      <button id="sqlClose">${t('sql.close')}</button>
    </div>
  </div>

  <div id="statusbar" class="statusbar">
    <span id="targetInfo" class="muted">${t('status.placeholder')}</span>
    <span id="elapsed" class="muted"></span>
  </div>

  <main id="result" class="result">
    <div class="placeholder">
      <div class="ph-title">${t('placeholder.title')}</div>
      <div class="ph-sub">${t('placeholder.sub')}</div>
    </div>
  </main>

  <div id="toast" class="toast hidden"></div>
  <div id="loading" class="loading hidden"><div class="spinner"></div><span>${t('placeholder.loading')}</span></div>
</div>
<!-- 本地 mermaid：离线/内网环境也能渲染 ER 图 -->
<script nonce="${nonce}" src="${mermaidUri}"></script>
<script nonce="${nonce}">window.__I18N__ = ${JSON.stringify(allMessages())};</script>
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
      delete (cfg as any).passwordSource;
      delete (cfg as any).namespaceExplicit;
      delete (cfg as any).origin;
      void logout(cfg).catch(() => undefined);
    }
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }
}

/**
 * 这个错误是不是「账号密码不对」。
 *
 * 只看 HttpError 的 status，不看 message —— message 已经本地化，
 * 中文环境以「认证」开头、英文以 "auth" 开头，靠文本判断一定有一边失效。
 */
function isAuthError(e: unknown): boolean {
  const status = (e as any)?.status;
  return status === 401 || status === 403;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * 把词条安全地塞进 HTML 属性值。
 *
 * SQL 提示里带换行（`\n`），直接放进 placeholder="" 会被 HTML 解析器
 * 压成空格。用字符引用 `&#10;` 才能保住换行，这也是原来模板里手写的那套做法。
 */
function attr(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}
