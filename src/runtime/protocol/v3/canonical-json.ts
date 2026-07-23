/** Runtime v3 唯一的 canonical JSON 与 SHA-256 编码入口。 */

import { createHash } from "node:crypto";

export type CanonicalJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

export class CanonicalJsonError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "CanonicalJsonError";
	}
}

function assertWellFormedUnicode(value: string, path: string): void {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new CanonicalJsonError(`lone high surrogate at ${path}`);
			}
			index += 1;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			throw new CanonicalJsonError(`lone low surrogate at ${path}`);
		}
	}
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "string") {
		assertWellFormedUnicode(value, path);
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number at ${path}`);
		if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
			throw new CanonicalJsonError(`unsafe integer at ${path}`);
		}
		return JSON.stringify(Object.is(value, -0) ? 0 : value);
	}
	if (typeof value === "undefined" || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
		throw new CanonicalJsonError(`unsupported value at ${path}`);
	}
	if (typeof value !== "object") throw new CanonicalJsonError(`unsupported value at ${path}`);
	if (seen.has(value)) throw new CanonicalJsonError(`cyclic value at ${path}`);

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const keys = Reflect.ownKeys(value);
			if (keys.some((key) => typeof key === "symbol" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) {
				throw new CanonicalJsonError(`non-index array property at ${path}`);
			}
			const items: string[] = [];
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.prototype.hasOwnProperty.call(value, index)) {
					throw new CanonicalJsonError(`sparse array at ${path}[${index}]`);
				}
				items.push(serialize(value[index], `${path}[${index}]`, seen));
			}
			return `[${items.join(",")}]`;
		}

		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype && prototype !== null) {
			throw new CanonicalJsonError(`non-plain object at ${path}`);
		}
		const record = value as Record<string, unknown>;
		const ownKeys = Reflect.ownKeys(record);
		if (ownKeys.some((key) => typeof key === "symbol")) {
			throw new CanonicalJsonError(`symbol key at ${path}`);
		}
		for (const key of ownKeys as string[]) {
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				throw new CanonicalJsonError(`non-data property at ${path}.${key}`);
			}
		}
		const fields = (ownKeys as string[])
			.sort()
			.map((key) => {
				assertWellFormedUnicode(key, `${path} key`);
				return `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, seen)}`;
			});
		return `{${fields.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

/**
 * 规则冻结为 UTF-8 JSON、UTF-16 code-unit key order、无尾随换行、有限 IEEE-754
 * 数值和 safe-integer 整数。字符串不做 Unicode normalization，但拒绝孤立 surrogate。
 */
export function canonicalJson(value: unknown): string {
	return serialize(value, "$", new Set<object>());
}

export function canonicalUtf8(value: unknown): Uint8Array {
	return Buffer.from(canonicalJson(value), "utf8");
}

export function canonicalDigest(value: unknown): string {
	return createHash("sha256").update(canonicalUtf8(value)).digest("hex");
}
