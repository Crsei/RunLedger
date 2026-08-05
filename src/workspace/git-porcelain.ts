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

/** 解析 C-style quoted 字符串（git 对含特殊字符的路径使用该格式）。 */
export function unquoteCStyle(value: string): string {
	if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
	let out = "";
	let i = 1;
	while (i < value.length - 1) {
		const ch = value[i];
		if (ch === "\\" && i + 1 < value.length - 1) {
			const next = value[i + 1];
			if (next === "n") out += "\n";
			else if (next === "t") out += "\t";
			else if (next === "\\") out += "\\";
			else if (next === "\"") out += "\"";
			else if (next === "a") out += "\u0007";
			else if (next === "b") out += "\b";
			else if (next === "f") out += "\f";
			else if (next === "r") out += "\r";
			else if (next === "v") out += "\u000b";
			else if (next === "x" && i + 3 < value.length - 1) {
				const hex = value.slice(i + 2, i + 4);
				if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
					out += String.fromCharCode(Number.parseInt(hex, 16));
					i += 2;
				} else out += next;
			} else out += next;
			i += 2;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
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
