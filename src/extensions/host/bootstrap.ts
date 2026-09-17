/**
 * Extension host 子进程的 bootstrap 配置。
 *
 * 这份配置只在 owner 与 host 之间传递，属于运行时私有上下文：它含
 * **native path**（package root 与 entrypoint），因此不进入任何公共 DTO、
 * canonical event 载荷或扩展可见事件（见 `src/contracts/extensions/**` 的
 * 边界说明）。owner 侧必须先用 `serializeExtensionHostBootstrap` 做
 * containment 校验，host 侧再用 `parseExtensionHostBootstrap` 独立复核：
 * 两端都不信任对端已经校验过。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { Value } from "typebox/value";
import { Type } from "typebox";
import type { Static } from "typebox";
import { ExtensionDigestSchema, ExtensionPackageIdSchema } from "../../contracts/extensions/common.ts";
import { ExtensionHostLimitsSchema } from "../../contracts/extensions/registry.ts";
import type { ExtensionHostLimits } from "../../contracts/extensions/registry.ts";

const ExtensionHostBootstrapSchema = Type.Object(
	{
		packageId: ExtensionPackageIdSchema,
		digest: ExtensionDigestSchema,
		generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		apiVersion: Type.String({ minLength: 1, maxLength: 64, pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }),
		limits: ExtensionHostLimitsSchema,
		rootPath: Type.String({ minLength: 1, maxLength: 4_096 }),
		entrypoint: Type.String({ minLength: 1, maxLength: 4_096 }),
	},
	{ additionalProperties: false },
);

export interface ExtensionHostBootstrap {
	readonly packageId: string;
	readonly digest: string;
	readonly generation: number;
	readonly apiVersion: string;
	readonly limits: ExtensionHostLimits;
	/** package root 的绝对路径；仅用于 containment 判定与该进程的 cwd。 */
	readonly rootPath: string;
	/** 可执行 entrypoint 的绝对路径；必须在 rootPath 之内。 */
	readonly entrypoint: string;
}

type BootstrapDocument = Static<typeof ExtensionHostBootstrapSchema>;

export type ExtensionHostBootstrapParse =
	| { readonly ok: true; readonly bootstrap: ExtensionHostBootstrap }
	| { readonly ok: false; readonly message: string };

function contained(rootPath: string, candidate: string): boolean {
	if (!isAbsolute(rootPath) || !isAbsolute(candidate)) return false;
	const root = resolve(rootPath);
	const target = resolve(candidate);
	if (target === root) return true;
	const rel = relative(root, target);
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validate(document: unknown): ExtensionHostBootstrapParse {
	if (!Value.Check(ExtensionHostBootstrapSchema, document)) return { ok: false, message: "host bootstrap does not match its contract" };
	const value = document as BootstrapDocument;
	if (value.rootPath.includes("\0") || value.entrypoint.includes("\0")) return { ok: false, message: "host bootstrap paths must not contain NUL" };
	if (!contained(value.rootPath, value.entrypoint)) return { ok: false, message: "host entrypoint escapes its package root" };
	return { ok: true, bootstrap: Object.freeze({ ...value, limits: Object.freeze({ ...value.limits }) }) };
}

/** host 侧解析；对 argv 输入做与 owner 相同的独立校验。 */
export function parseExtensionHostBootstrap(json: string): ExtensionHostBootstrapParse {
	let document: unknown;
	try {
		document = JSON.parse(json) as unknown;
	} catch {
		return { ok: false, message: "host bootstrap is not valid JSON" };
	}
	return validate(document);
}

/** owner 侧序列化；返回前完成 containment 校验，非法输入不产生 argv。 */
export function serializeExtensionHostBootstrap(bootstrap: ExtensionHostBootstrap): ExtensionHostBootstrapParse {
	const validated = validate(bootstrap);
	if (!validated.ok) return validated;
	return { ok: true, bootstrap: validated.bootstrap };
}
