/**
 * 路径纯函数 —— cwd 编码 / session 文件名构造。
 *
 * 对照参考 pi `core/session-manager.ts` 的 `encodeCwd` 与文件名约定,
 * 但 RunLedger 把它们抽到无 fs / 无 homedir 依赖的纯函数文件,
 * 方便在 vitest 单测里精准串验证。
 */

/**
 * 把 cwd 编码成 sessions 子目录名。
 * pi 约定:`--${cwd 去首 /\\/ 后把 / \\ : 全换为 -}--`。
 *
 * 例:
 *   `/home/foo/projects/x`  → `--home-foo-projects-x--`
 *   `C:\Users\foo\bar`       → `--C-Users-foo-bar--`
 *   `/`                      → `----`  (去首 / 后空串)
 */
export function encodeCwd(cwd: string): string {
  const stripped = cwd.replace(/^[/\\]/, "");
  const escaped = stripped.replace(/[/\\:]/g, "-");
  return `--${escaped}--`;
}

/**
 * 把 ISO 时间戳变成文件名安全的子串:替换 `:` 与 `.` 为 `-`。
 *
 * 例:`2026-07-20T16:42:33.079Z` → `2026-07-20T16-42-33-079Z`
 */
export function safeIso(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * 生成 session 文件名。pi 用 ISO 时间戳 + uuidv7 拼接,
 * RunLedger 本期不定 uuid 版本,只确保文件名内不含 `:` `.` 与路径分隔符。
 *
 * 形如:`<safeIso><sep><rawId>.jsonl`
 */
export function buildSessionFileName(
  date: Date = new Date(),
  id: string = "",
): string {
  const ts = safeIso(date);
  return id.length > 0 ? `${ts}_${id}.jsonl` : `${ts}_${randomFileId()}.jsonl`;
}

/**
 * 8 字符随机 id(沿用 `ledger/types.ts` 风格,但此处独立不引该模块以避免环依赖)。
 * 失败回退到 Math.random,保持纯函数性质即可。
 */
function randomFileId(): string {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID().replace(/-/g, "").slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

type Crypto = {
  randomUUID(): string;
};
