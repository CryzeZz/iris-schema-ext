import * as vscode from 'vscode';
import { IrisPanel } from './panel';
import { loadProfiles, resetProfileCache } from './config';
import { detectLanguage, getLanguage, setLanguage, t } from './i18n';

export function activate(context: vscode.ExtensionContext): void {
  // 界面语言跟随 VS Code：zh* 用中文，其余用英文。只需在激活时判定一次。
  setLanguage(detectLanguage(vscode.env.language));

  context.subscriptions.push(
    vscode.commands.registerCommand('irisSchema.openPanel', () => {
      IrisPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand('irisSchema.refreshConnections', () => {
      resetProfileCache();
      const src = loadProfiles();
      if (!src.profiles.length) {
        vscode.window.showWarningMessage(t('notice.noProfiles'));
      } else {
        const from = src.vscodePath || src.path || t('notice.unknownSource');
        vscode.window.showInformationMessage(t('notice.profilesLoaded', src.profiles.length, from));
      }
      IrisPanel.current?.reloadProfiles();
    }),

    vscode.window.registerWebviewViewProvider('irisSchema.welcome', new SidebarWelcomeProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

/**
 * 侧边栏欢迎视图：只做入口和状态提示，真正的查询都在编辑器区的面板里完成。
 *
 * 为什么不用 viewsWelcome 的静态文案就够：静态文案不能显示「当前读到几个连接」，
 * 而连接配置是这个插件最容易出错的地方（拿不到 intersystems.servers 就完全没法用）。
 * 这里顺带把服务器数量和来源显示出来，用户点开侧边栏就知道配没配对。
 */
class SidebarWelcomeProvider implements vscode.WebviewViewProvider {
  public resolveWebviewView(view: vscode.WebviewView): void {
    // 必须开 enableScripts：按钮靠内联脚本 postMessage 回扩展侧。
    // 之前写成 false，导致 <script> 整段不执行、两个按钮都没绑上点击事件。
    view.webview.options = { enableScripts: true };
    view.webview.html = this.render();

    // 点按钮 → 扩展侧处理
    view.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m?.type === 'open') void vscode.commands.executeCommand('irisSchema.openPanel');
      if (m?.type === 'reload') void vscode.commands.executeCommand('irisSchema.refreshConnections');
    });
  }

  private render(): string {
    const src = loadProfiles();
    const count = src.profiles.length;
    const from = src.vscodePath || src.path || '';

    const status = count
      ? `<p class="ok">${t('sidebar.connected', count)}</p><p class="dim">${esc(from)}</p>`
      : `<p class="warn">${t('sidebar.notConfigured')}</p>
         <p class="dim">${t('sidebar.addServer')}</p>`;

    return `<!DOCTYPE html><html lang="${htmlLang()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
       color:var(--vscode-foreground);padding:12px 14px;margin:0;line-height:1.6}
  h3{margin:0 0 10px;font-size:1.05em;font-weight:600}
  p{margin:6px 0}
  .dim{color:var(--vscode-descriptionForeground);font-size:.9em;word-break:break-all}
  .ok{color:var(--vscode-testing-iconPassed,#3fb950)}
  .warn{color:var(--vscode-editorWarning-foreground,#d7ba7d)}
  code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px;
       font-family:var(--vscode-editor-font-family);font-size:.92em}
  button{width:100%;margin-top:10px;padding:6px 10px;border:none;border-radius:2px;cursor:pointer;
         font-family:inherit;font-size:inherit;
         background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  button:hover{background:var(--vscode-button-hoverBackground)}
  button.sec{background:var(--vscode-button-secondaryBackground);
             color:var(--vscode-button-secondaryForeground)}
  button.sec:hover{background:var(--vscode-button-secondaryHoverBackground)}
</style></head><body>
  <h3>iris schema</h3>
  <p>${t('sidebar.desc')}</p>
  ${status}
  <button id="open">${t('sidebar.open')}</button>
  <button id="reload" class="sec">${t('sidebar.reload')}</button>
  <p class="dim" style="margin-top:14px">${t('sidebar.hint')}</p>
  <script>
    const api = acquireVsCodeApi();
    document.getElementById('open').onclick = () => api.postMessage({ type: 'open' });
    document.getElementById('reload').onclick = () => api.postMessage({ type: 'reload' });
  </script>
</body></html>`;
  }
}

/** `<html lang>` 跟着界面语言走，影响断行和字数统计这类排版细节。 */
function htmlLang(): string {
  return getLanguage() === 'zh' ? 'zh-CN' : 'en';
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function deactivate(): void {
  /* 会话由 Webview 面板在 dispose 时注销 */
}
