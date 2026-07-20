/**
 * `resolveConfigValue` 简化版 —— pi 支持把 `key` 配成 shell 命令或 `${ENV_VAR}` 模板，
 * RunLedger 是轻量运行时，仅保留字面值与 `${ENV_VAR}` 模板两项；不支持 `$(cmd)` 形式，
 * 因而不引入 pi 的 `utils/shell.ts`（git-bash 检测等）这条重链。
 *
 * 该函数被 `storage/auth-storage.ts` 调用，用于在加载凭证时把存储里写的
 * `key: "abc-${MY_SECRET}-xyz"` 模板解析成最终字符串。
 */

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

interface ConfigValueReference {
	type: "template";
	parts: ReadonlyArray<TemplatePart>;
}

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseTemplate(input: string): ConfigValueReference {
	const parts: TemplatePart[] = [];
	let position = 0;
	while (position < input.length) {
		const nextDollar = input.indexOf("${", position);
		if (nextDollar === -1) {
			appendLiteral(parts, input.slice(position));
			break;
		}
		if (nextDollar > position) {
			appendLiteral(parts, input.slice(position, nextDollar));
		}
		const endBrace = input.indexOf("}", nextDollar);
		if (endBrace === -1) {
			// 未闭合的 ${ —— 当作字面值处理，避免吞掉用户输入
			appendLiteral(parts, input.slice(nextDollar));
			break;
		}
		const name = input.slice(nextDollar + 2, endBrace);
		if (!ENV_VAR_NAME_RE.test(name)) {
			appendLiteral(parts, input.slice(nextDollar, endBrace + 1));
		} else {
			parts.push({ type: "env", name });
		}
		position = endBrace + 1;
	}
	return { type: "template", parts };
}

function renderTemplate(ref: ConfigValueReference, providerEnv?: Readonly<Record<string, string>>): string {
	let result = "";
	for (const part of ref.parts) {
		if (part.type === "literal") {
			result += part.value;
			continue;
		}
		// 优先用 provider-scoped env 字段，再回退到进程环境变量
		const explicit = providerEnv?.[part.name];
		if (typeof explicit === "string") {
			result += explicit;
			continue;
		}
		const ambient = process.env[part.name];
		if (typeof ambient === "string") result += ambient;
	}
	return result;
}

/** 支持的字面值或 `${ENV_VAR}` 模板；不支持 shell 命令、不支持默认值。 */
export function resolveConfigValue(
	literal: string | undefined,
	envRecord?: Readonly<Record<string, string>>,
): string | undefined {
	if (literal === undefined) return undefined;
	if (literal.length === 0) return "";
	const ref = parseTemplate(literal);
	// 无插值片段时（parts 全部 literal 且只有 1 个）—— 文本与 input 等价，直接返回 input
	if (ref.parts.length === 1) {
		const only = ref.parts[0];
		if (only === undefined) return literal;
		return only.type === "literal" ? literal : renderTemplate(ref, envRecord);
	}
	return renderTemplate(ref, envRecord);
}
