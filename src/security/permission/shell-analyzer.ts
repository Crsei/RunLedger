/** 保守 shell 分类器；无法可靠拆链时返回 unknown。 */

export interface ShellSegment {
	raw: string;
	executable: string;
	arguments: readonly string[];
}

export interface ShellAnalysis {
	analysis: "known" | "unknown";
	segments: readonly ShellSegment[];
	reasonCodes: readonly string[];
}

const WRAPPERS = new Set(["env", "timeout", "nice", "ionice", "stdbuf"]);
const UNSAFE_BUILTINS = new Set(["sudo", "xargs", "nohup", "tee"]);

function splitWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (const character of segment) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "single") {
			escaped = true;
			continue;
		}
		if (character === "'" && quote !== "double") {
			quote = quote === "single" ? undefined : "single";
			continue;
		}
		if (character === '"' && quote !== "single") {
			quote = quote === "double" ? undefined : "double";
			continue;
		}
		if (/\s/.test(character) && quote === undefined) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (escaped || quote !== undefined) return undefined;
	if (current) words.push(current);
	return words;
}

function splitSegments(command: string): { segments: string[]; unknown: boolean } {
	const segments: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let unknown = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		const next = command[index + 1];
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "single") {
			current += character;
			escaped = true;
			continue;
		}
		if (character === "'" && quote !== "double") {
			quote = quote === "single" ? undefined : "single";
			current += character;
			continue;
		}
		if (character === '"' && quote !== "single") {
			quote = quote === "double" ? undefined : "double";
			current += character;
			continue;
		}
		if (quote === undefined && character === "&" && next !== "&") unknown = true;
		if (quote === undefined && (character === "<" || character === ">" || character === "`")) unknown = true;
		if (quote === undefined && character === "$" && next === "(") unknown = true;
		const doubleSeparator = quote === undefined && ((character === "&" && next === "&") || (character === "|" && next === "|"));
		const singleSeparator = quote === undefined && (character === ";" || character === "|" || character === "\n");
		if (doubleSeparator || singleSeparator) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if (doubleSeparator) index += 1;
			continue;
		}
		current += character;
	}
	if (quote !== undefined || escaped) unknown = true;
	if (current.trim()) segments.push(current.trim());
	return { segments, unknown };
}

function normalizeSegment(raw: string): ShellSegment | undefined {
	const words = splitWords(raw);
	if (!words || words.length === 0) return undefined;
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index]!)) index += 1;
	while (index < words.length && WRAPPERS.has(words[index]!)) {
		const wrapper = words[index]!;
		index += 1;
		if (wrapper === "env") {
			while (index < words.length && (words[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index]!))) index += 1;
			continue;
		}
		if (wrapper === "timeout") {
			while (index < words.length && words[index]!.startsWith("-")) {
				const option = words[index]!;
				index += 1;
				if (["-k", "--kill-after", "-s", "--signal"].includes(option)) index += 1;
			}
			index += 1;
			continue;
		}
		while (index < words.length && words[index]!.startsWith("-")) {
			const option = words[index]!;
			index += 1;
			if (["-n", "--adjustment", "-c", "--class", "-p", "--pid"].includes(option)) index += 1;
		}
	}
	const executable = words[index];
	if (!executable) return undefined;
	return { raw, executable, arguments: words.slice(index + 1) };
}

export function analyzeShellCommand(command: string): ShellAnalysis {
	const reasons: string[] = [];
	if (!command.trim() || command.length > 65_536 || command.includes("\0")) {
		return { analysis: "unknown", segments: [], reasonCodes: ["invalid_command"] };
	}
	const split = splitSegments(command);
	if (split.unknown) reasons.push("unsupported_shell_syntax");
	const segments: ShellSegment[] = [];
	for (const raw of split.segments) {
		const normalized = normalizeSegment(raw);
		if (!normalized) {
			reasons.push("unparseable_segment");
			continue;
		}
		segments.push(normalized);
		if (UNSAFE_BUILTINS.has(normalized.executable)) reasons.push(`unsafe_wrapper:${normalized.executable}`);
		if (normalized.executable === "rg" && normalized.arguments.includes("--pre")) reasons.push("rg_preprocessor");
	}
	if (segments.length === 0) reasons.push("empty_segments");
	return {
		analysis: reasons.length === 0 ? "known" : "unknown",
		segments,
		reasonCodes: [...new Set(reasons)].sort(),
	};
}
