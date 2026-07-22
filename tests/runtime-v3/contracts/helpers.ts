import { readFileSync } from "node:fs";

export const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function loadContractFixture(relativePath: string): unknown {
	const url = new URL(`../fixtures/${relativePath}`, import.meta.url);
	return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

export function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("fixture must be an object");
	}
	return value as Record<string, unknown>;
}
