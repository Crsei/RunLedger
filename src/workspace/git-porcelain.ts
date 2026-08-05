/** 纯 `git worktree list --porcelain` 解析器（P3：不调用真实 Git，不丢路径大小写）。 */

/**
 * porcelain 格式：每条记录以空行分隔，行首 key + 值。
 * - `worktree <path>`：路径原样输出（特殊字符使用 C-style quoting）
 * - `HEAD <sha>`、`branch refs/heads/<name>`、`detached`、`locked [reason]`、
 *   `prunable [reason]`、`bare`
 *
 * 解析不依赖平台：路径大小写与引号原样保留，由上层 path adapter 处理身份。
 */

export interface PorcelainWorktreeEntry {
	/** 原样路径（C-style quoted 时已解引号，但大小写不丢）。 */
	readonly path: string;
	readonly head?: string;
	/** `refs/heads/<name>` 去掉前缀后的分支名。 */
	readonly branch?: string;
	readonly detached: boolean;
	readonly locked: boolean;
	readonly lockedReason?: string;
	readonly prunable: boolean;
	readonly bare: boolean;
}

/**
 * 解析 C-style quoted 字符串（git 对含特殊字符的路径使用该格式）。
 * 支持常见 escape 与 git 默认的八进制 UTF-8 转义（`\NNN`，如中文路径
 * `"\346\265\213\350\257\225"` = "测试"）。
 */
export function unquoteCStyle(value: string): string {
	if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
	const bytes: number[] = [];
	let i = 1;
	while (i < value.length - 1) {
		const ch = value.charCodeAt(i);
		if (ch === 0x5c /* \ */ && i + 1 < value.length - 1) {
			const next = value[i + 1];
			if (next === "n") { bytes.push(0x0a); i += 2; continue; }
			if (next === "t") { bytes.push(0x09); i += 2; continue; }
			if (next === "\\") { bytes.push(0x5c); i += 2; continue; }
			if (next === "\"") { bytes.push(0x22); i += 2; continue; }
			if (next === "a") { bytes.push(0x07); i += 2; continue; }
			if (next === "b") { bytes.push(0x08); i += 2; continue; }
			if (next === "f") { bytes.push(0x0c); i += 2; continue; }
			if (next === "r") { bytes.push(0x0d); i += 2; continue; }
			if (next === "v") { bytes.push(0x0b); i += 2; continue; }
			if (next === "x" && i + 3 < value.length - 1) {
				const hex = value.slice(i + 2, i + 4);
				if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
					bytes.push(Number.parseInt(hex, 16));
					i += 4;
					continue;
				}
			}
			// git 对非 ASCII UTF-8 字节使用八进制转义：1–3 位八进制数字。
			const octalMatch = /^[0-7]{1,3}/u.exec(value.slice(i + 1));
			if (octalMatch !== null) {
				bytes.push(Number.parseInt(octalMatch[0], 8));
				i += 1 + octalMatch[0].length;
				continue;
			}
			bytes.push(ch);
			i += 1;
			continue;
		}
		bytes.push(ch);
		i++;
	}
	return Buffer.from(bytes).toString("utf8");
}

export function parseWorktreePorcelain(text: string): readonly PorcelainWorktreeEntry[] {
	const entries: PorcelainWorktreeEntry[] = [];
	let current: {
		path?: string;
		head?: string;
		branch?: string;
		detached: boolean;
		locked: boolean;
		lockedReason?: string;
		prunable: boolean;
		bare: boolean;
	} | undefined;

	const flush = (): void => {
		if (current === undefined) return;
		if (current.path === undefined) {
			current = undefined;
			return;
		}
		entries.push({
			path: current.path,
			...(current.head ? { head: current.head } : {}),
			...(current.branch ? { branch: current.branch } : {}),
			detached: current.detached,
			locked: current.locked,
			...(current.lockedReason ? { lockedReason: current.lockedReason } : {}),
			prunable: current.prunable,
			bare: current.bare,
		});
		current = undefined;
	};

	for (const rawLine of text.split("\n")) {
		if (rawLine.length === 0) {
			flush();
			continue;
		}
		const line = rawLine.replace(/\r$/u, "");
		if (current === undefined) current = { detached: false, locked: false, prunable: false, bare: false };
		if (line.startsWith("worktree ")) current.path = unquoteCStyle(line.slice("worktree ".length));
		else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
		else if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
		else if (line === "detached") current.detached = true;
		else if (line.startsWith("locked")) current.locked = true;
		else if (line.startsWith("prunable")) current.prunable = true;
		else if (line === "bare") current.bare = true;
	}
	flush();
	return entries;
}
