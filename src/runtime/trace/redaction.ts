/** Artifact/模型可见文本的默认脱敏边界。 */

const REPLACEMENT_RULES: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
	{
		pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
		replacement: "[REDACTED_PRIVATE_KEY]",
	},
	{
		pattern: /<system_prompt>[\s\S]*?<\/system_prompt>/giu,
		replacement: "[REDACTED_PROMPT]",
	},
	{
		pattern: /((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer|basic)\s+[^\s\r\n,;"']+/giu,
		replacement: "$1[REDACTED_CREDENTIAL]",
	},
	{
		pattern: /\b(bearer|basic)\s+[^\s\r\n,;"']+/giu,
		replacement: "$1 [REDACTED_CREDENTIAL]",
	},
	{
		pattern: /\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*(?:["']?)[^\s,;}"']+/giu,
		replacement: "$1=[REDACTED_CREDENTIAL]",
	},
	{
		pattern: /\b(?:sk|rk|pk|ghp|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}\b/gu,
		replacement: "[REDACTED_SECRET]",
	},
	{
		pattern: /(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)(?:[\\/][^\s"'<>]*)?/gu,
		replacement: "[REDACTED_PATH]",
	},
];

/**
 * 对进入模型、Trace Artifact 或公开投影的文本执行同一套默认脱敏。
 * 规则也作用于 JSON 序列化后的文本，因此不会因 `\\n` 边界而绕过。
 */
export function redactRuntimeArtifactText(value: string): string {
	let result = value;
	for (const rule of REPLACEMENT_RULES) result = result.replace(rule.pattern, rule.replacement);
	return result;
}
