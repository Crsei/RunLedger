/**
 * Runtime 唯一的 canonical JSON 编码入口。
 *
 * TODO(runtime-phase-0): 与跨语言实现共同冻结数字、Unicode、换行和大整数
 * 规则，并补齐官方 hash vectors。这里先对 JSON 可表达值做严格、稳定编码，
 * 防止后续事件代码直接依赖不稳定的 JSON.stringify 顺序。
 */

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

function normalize(value: unknown, path: string, seen: Set<object>): CanonicalJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new CanonicalJsonError(`non-finite number at ${path}`);
		}
		return Object.is(value, -0) ? 0 : value;
	}
	if (typeof value === "undefined" || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
		throw new CanonicalJsonError(`unsupported value at ${path}`);
	}
	if (typeof value !== "object") {
		throw new CanonicalJsonError(`unsupported value at ${path}`);
	}
	if (seen.has(value)) {
		throw new CanonicalJsonError(`cyclic value at ${path}`);
	}

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item, index) => normalize(item, `${path}[${index}]`, seen));
		}

		const objectValue: Record<string, CanonicalJsonValue> = {};
		const recordValue = value as Record<string, unknown>;
		for (const key of Object.keys(value).sort()) {
			objectValue[key] = normalize(recordValue[key], `${path}.${key}`, seen);
		}
		return objectValue;
	} finally {
		seen.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalize(value, "$", new Set<object>()));
}

export function canonicalDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
