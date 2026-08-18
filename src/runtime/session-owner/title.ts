/** Pure Session display-title contract helpers. No storage, UI, or model I/O. */

export const SESSION_TITLE_MAX_BYTES = 160 as const;

export type SessionTitleSource = "auto" | "user";

export interface SessionTitleModelRef {
	readonly providerId: string;
	readonly modelId: string;
}

export interface SessionTitleState {
	readonly title?: string;
	readonly titleSource?: SessionTitleSource;
	readonly titleUpdatedAtMs?: number;
}

/** Normalize a title supplied by a user or by the bounded title generator. */
export function normalizeSessionTitle(value: string): string | null {
	const normalized = value
		.replace(/\u001B\[[0-?]*[ -\/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|$)/gu, "")
		.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
		.replace(/\r?\n/gu, " ")
		.trim()
		.replace(/^(?:["'`]|“|‘)+/u, "")
		.replace(/(?:["'`]|”|’)+$/u, "")
		.trim()
		.replace(/\s+/gu, " ");
	if (normalized.length === 0) return null;
	if (new TextEncoder().encode(normalized).byteLength > SESSION_TITLE_MAX_BYTES) return null;
	return normalized;
}

export function isSessionTitleSource(value: unknown): value is SessionTitleSource {
	return value === "auto" || value === "user";
}

export function isValidSessionTitleState(value: SessionTitleState): boolean {
	if (value.title === undefined) return value.titleSource === undefined && value.titleUpdatedAtMs === undefined;
	return value.titleSource !== undefined
		&& typeof value.titleUpdatedAtMs === "number"
		&& Number.isSafeInteger(value.titleUpdatedAtMs)
		&& value.titleUpdatedAtMs >= 0
		&& normalizeSessionTitle(value.title) === value.title;
}
