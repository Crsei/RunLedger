export function safeJson(text: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { raw: text };
	} catch {
		return { raw: text };
	}
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
