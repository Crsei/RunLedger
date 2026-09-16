/**
 * 最小 .gitignore 匹配器 —— 供 in-process 的 glob 工具复用,不引入第三方依赖。
 *
 * 支持标准语法的常用子集:
 *   - 空行与 `#` 注释
 *   - `!pattern` 取反(最后一条命中的规则生效)
 *   - 尾部 `/` 表示只匹配目录
 *   - 前导 `/` 表示锚定到搜索根;pattern 中间含 `/` 时同样锚定
 *   - 不含 `/` 的 pattern 匹配任意深度的同名条目
 *   - `*` / `?` / `**` / `[...]` 通配
 *
 * 明确限制:**只读取搜索根目录下的 `.gitignore`**,不处理嵌套 `.gitignore` 与
 * `core.excludesFile`。调用方必须把这一点写进工具描述,不得宣称完整 gitignore 语义。
 */

export interface GitignoreMatcher {
  /** 相对搜索根的路径是否被忽略。 */
  isIgnored(relativePath: string, isDirectory: boolean): boolean;
  /** 生效的规则条数;0 表示没有 .gitignore 或全为空行/注释。 */
  readonly ruleCount: number;
}

interface GitignoreRule {
  readonly regex: RegExp;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
}

const NO_RULES: GitignoreMatcher = { isIgnored: () => false, ruleCount: 0 };

export function parseGitignore(text: string): GitignoreMatcher {
  const rules: GitignoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+$/u, "");
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const body = negated ? line.slice(1) : line;
    if (body.length === 0) continue;
    const directoryOnly = body.endsWith("/");
    const pattern = directoryOnly ? body.slice(0, -1) : body;
    const regex = compileGitignorePattern(pattern);
    if (regex === null) continue;
    rules.push({ regex, negated, directoryOnly });
  }
  if (rules.length === 0) return NO_RULES;
  return {
    ruleCount: rules.length,
    isIgnored(relativePath: string, isDirectory: boolean): boolean {
      const target = relativePath.replace(/^\.\//u, "");
      let ignored = false;
      for (const rule of rules) {
        if (rule.directoryOnly && !isDirectory) continue;
        if (rule.regex.test(target)) ignored = !rule.negated;
      }
      return ignored;
    },
  };
}

/**
 * pattern → 正则。锚定规则:含内部 `/` 或前导 `/` 时锚定到搜索根,否则匹配任意
 * 深度上的同名条目(标准 gitignore 语义)。
 */
function compileGitignorePattern(pattern: string): RegExp | null {
  const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
  const body = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (body.length === 0) return null;
  const compiled = globFragmentToRegex(body);
  // 未锚定的 pattern 可命中任意层级;`**/` 前缀等价于"任意深度"。
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // 目录规则同时忽略其下所有内容。
  return new RegExp(`${prefix}${compiled}(?:/.*)?$`, "u");
}

function globFragmentToRegex(fragment: string): string {
  let out = "";
  for (let index = 0; index < fragment.length; index += 1) {
    const ch = fragment[index]!;
    if (ch === "*") {
      if (fragment[index + 1] === "*") {
        // `**/` 吃掉任意层目录;末尾 `**` 吃掉剩余全部。
        const isSlashAfter = fragment[index + 2] === "/";
        out += isSlashAfter ? "(?:.*/)?" : ".*";
        index += isSlashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      const close = fragment.indexOf("]", index + 1);
      if (close > index + 1) {
        const inner = fragment.slice(index + 1, close);
        out += `[${inner.startsWith("!") ? `^${inner.slice(1)}` : inner}]`;
        index = close;
        continue;
      }
    }
    out += ch.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return out;
}
