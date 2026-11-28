/**
 * 密码存储 —— 本插件自己的凭据条目，不碰其他扩展的数据。
 *
 * 为什么自己做一套：
 * - `context.secrets` 底层是系统 keychain（Windows 凭据管理器 / macOS Keychain /
 *   Linux libsecret），但**按扩展隔离**：本扩展读不到 InterSystems 扩展存的密码，
 *   反过来它们也读不到我们的。想"借"它的密码只能调它的私有导出 API，
 *   而那不是稳定契约，对方一升级就可能断。
 * - 所以本插件自己建条目：用户第一次连的时候弹输入框，密码写进 keychain，
 *   之后不再出现在 settings.json / ~/.iris-schema.json 里。
 *
 * 存储键与「主机:端口 + 账号」绑定而不是只绑服务器名：
 * 同一个域名下挂多个实例（不同网关端口）、同一个实例换账号登录都很常见，
 * 只按服务器名存会让它们互相覆盖密码。
 *
 * 优先级（见 config.ts 的 applyStoredPassword）：
 *   运行期缓存 > keychain > 配置里的明文
 * 明文排最后是为了兼容老配置：已经写了明文的老用户升级后照常能用，
 * 但只要走过一次"记住密码"，keychain 就会接管。
 */

import * as vscode from 'vscode';

import { t } from './i18n';

/** 存储键前缀。加前缀是为了语义清晰，也便于将来做批量清理。 */
const KEY_PREFIX = 'irisSchema.password:';

/**
 * 本次会话内用过的密码。
 *
 * 用户在弹框里选了"仅本次会话"时只放这里：进程退出即失效，
 * 期间反复查询不必重复弹框。keychain 在 Linux 上可能不可用
 * （没装 libsecret 时 `secrets.store` 会直接抛错），这份缓存也是兜底。
 */
const sessionCache = new Map<string, string>();

/**
 * keychain 是否已确认不可用。
 *
 * `ExtensionContext.secrets` 在类型上一定存在，但 Linux 无 libsecret、
 * 或某些远程/虚拟工作区里读写会抛错。探测到一次就置位，避免每次查询
 * 都重复抛同一个异常。
 */
let keychainBroken = false;
let warnedKeychain = false;

function storageKey(host: string, port: number | string, user: string): string {
  return `${KEY_PREFIX}${host}:${port}/${user.toLowerCase()}`;
}

/** 从 keychain 读密码；读不到、没配账号、环境不支持都返回 null，不抛。 */
export async function getStoredPassword(
  ctx: vscode.ExtensionContext,
  host: string,
  port: number | string,
  user: string
): Promise<string | null> {
  if (!user) return null;
  const key = storageKey(host, port, user);
  const cached = sessionCache.get(key);
  if (cached !== undefined) return cached;
  if (keychainBroken) return null;
  try {
    const v = await ctx.secrets.get(key);
    if (v !== undefined) sessionCache.set(key, v);
    return v ?? null;
  } catch {
    keychainBroken = true;
    if (!warnedKeychain) {
      warnedKeychain = true;
      void vscode.window.showWarningMessage(t('pwd.keychainUnavailable'));
    }
    return null;
  }
}

/** 写入密码。`remember=false` 时只进会话缓存，不落盘。 */
export async function savePassword(
  ctx: vscode.ExtensionContext,
  host: string,
  port: number | string,
  user: string,
  password: string,
  remember: boolean
): Promise<void> {
  if (!user || !password) return;
  const key = storageKey(host, port, user);
  sessionCache.set(key, password);
  if (!remember || keychainBroken) return;
  try {
    await ctx.secrets.store(key, password);
  } catch {
    keychainBroken = true;
  }
}

/**
 * 让缓存里的密码失效（服务端 401 时调用）。
 *
 * 只清内存，不动 keychain：keychain 里的值可能是对的，只是这次密码被改了。
 * 下次 getStoredPassword 会重新读 keychain，用户改回密码后自动恢复。
 */
export function invalidateSessionPassword(host: string, port: number | string, user: string): void {
  if (!user) return;
  sessionCache.delete(storageKey(host, port, user));
}

/** 删掉某个账号在 keychain 与会话缓存里的密码。 */
export async function forgetPassword(
  ctx: vscode.ExtensionContext,
  host: string,
  port: number | string,
  user: string
): Promise<void> {
  if (!user) return;
  const key = storageKey(host, port, user);
  sessionCache.delete(key);
  if (keychainBroken) return;
  try {
    await ctx.secrets.delete(key);
  } catch {
    /* 删不掉也不影响使用：密码没了也就是下次重新弹框 */
  }
}

/**
 * 清空本插件存过的密码（命令 `irisSchema.clearPasswords`）。
 *
 * SecretStorage 没有列举键的 API，只能按当前 profile 列表逐个删。
 * 用户改过配置、把某台服务器删掉了，那条密码就删不到 —— 这是 API 限制，
 * 不影响正确性，只影响"彻底清理"的完整性。
 *
 * 返回值是**真正清掉的条数**，包含仅存在于会话缓存里的那些。
 * keychain 不可用时清不掉持久化的那条，但缓存一定要清 ——
 * 否则"清除密码"之后这次会话仍然拿着旧密码，用户会以为命令没生效。
 */
export async function forgetAllPasswords(
  ctx: vscode.ExtensionContext,
  profiles: { host: string; web_port: number | string; user: string }[]
): Promise<number> {
  let n = 0;
  for (const p of profiles) {
    if (!p.user) continue;
    const key = storageKey(p.host, p.web_port, p.user);
    const hadSession = sessionCache.delete(key);
    let hadStored = false;
    if (!keychainBroken) {
      try {
        // secrets.delete 不返回"是否真的删掉了"，这里只能先读一次确认存在
        hadStored = (await ctx.secrets.get(key)) !== undefined;
        await ctx.secrets.delete(key);
      } catch {
        /* ignore */
      }
    }
    if (hadSession || hadStored) n++;
  }
  return n;
}

/**
 * 弹框让用户输入密码。
 *
 * 返回 `undefined` 表示用户取消 —— 调用方必须中止本次请求，
 * 不能拿空字符串去撞 401（那样界面上只看到"认证失败"，看不出是没输密码）。
 * 返回字符串表示用户确认的密码，可能是空串（无密码账号，合法但少见）。
 */
export async function promptPassword(
  ctx: vscode.ExtensionContext,
  opts: { profile: string; user: string; host: string; port: number | string; reason?: string }
): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: opts.reason ? `iris schema — ${opts.reason}` : `iris schema — ${t('pwd.title')}`,
    prompt: t('pwd.prompt', opts.user, opts.profile),
    placeHolder: `${opts.user}@${opts.host}:${opts.port}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return undefined;

  // 是否记住，单独问一次。默认选中"记住"：用户配 keychain 就是为了不再输密码。
  const picked = await vscode.window.showQuickPick(
    [
      { label: t('pwd.rememberYes'), description: t('pwd.rememberYesDesc'), remember: true },
      { label: t('pwd.rememberNo'), description: t('pwd.rememberNoDesc'), remember: false },
    ],
    { title: t('pwd.rememberTitle'), placeHolder: t('pwd.remember'), ignoreFocusOut: true }
  );
  if (!picked) return undefined;
  await savePassword(ctx, opts.host, opts.port, opts.user, value, picked.remember);
  return value;
}

/** keychain 是否已确认不可用（面板可据此提示"密码只在本次会话有效"）。 */
export function isKeychainBroken(): boolean {
  return keychainBroken;
}
