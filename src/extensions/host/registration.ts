/**
 * Extension host 注册表的校验、去重、上限与 identity digest。
 *
 * host 自报的注册项不是权威：owner 侧必须重新校验、确定性排序、拒绝
 * 重复 runtime name，并把结果冻结成 `ExtensionRegistrySnapshot`。工具是否
 * 真的能进入 Agent 面由 P2 的准入决定（D3）；本模块只保证注册表本身
 * bounded、确定、可复算。
 */

import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import type { ExtensionHostLimits, ExtensionRegistrySnapshot } from "../../contracts/extensions/registry.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../contracts/extensions/registry.ts";
import { isExtensionEventName } from "../../contracts/extensions/events.ts";

export type ExtensionRegistryValidationCode =
	| "registry_limit_exceeded"
	| "registry_tool_duplicate"
	| "registry_command_duplicate"
	| "registry_flag_duplicate"
	| "registry_subscription_duplicate"
	| "registry_subscription_unknown"
	| "registry_tool_schema_oversize"
	| "registry_identity_mismatch";

export interface ExtensionRegistryValidationError {
	readonly code: ExtensionRegistryValidationCode;
	readonly message: string;
}

export type ExtensionRegistryValidation =
	| { readonly ok: true; readonly snapshot: ExtensionRegistrySnapshot; readonly identityDigest: string }
	| { readonly ok: false; readonly error: ExtensionRegistryValidationError };

export interface ExtensionRegistryValidationOptions {
	readonly packageId: string;
	readonly digest: string;
	readonly hostPid: number;
	readonly generation: number;
	readonly limits?: ExtensionHostLimits;
	readonly maxToolSchemaBytes?: number;
}

function byteLength(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function byName<T extends { readonly name: string }>(left: T, right: T): number {
	return left.name.localeCompare(right.name);
}

function findByDuplicateName<T extends { readonly name: string }>(items: readonly T[]): string | undefined {
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.name)) return item.name;
		seen.add(item.name);
	}
	return undefined;
}

/**
 * 校验并冻结一份注册表。重复名即拒绝（不自动改名，见 §11 风险表）；
 * 拒绝是原子的：任何一项不合法都不产生部分注册表。
 */
export function validateExtensionRegistry(
	candidate: Omit<ExtensionRegistrySnapshot, "limits"> & { readonly limits?: ExtensionHostLimits },
	options: ExtensionRegistryValidationOptions,
): ExtensionRegistryValidation {
	const limits = options.limits ?? candidate.limits ?? EXTENSION_DEFAULT_HOST_LIMITS;
	const maxToolSchemaBytes = options.maxToolSchemaBytes ?? 64 * 1024;
	const fail = (code: ExtensionRegistryValidationCode, message: string): ExtensionRegistryValidation => ({ ok: false, error: { code, message } });

	if (candidate.tools.length > limits.maxRegistrationsPerKind) return fail("registry_limit_exceeded", `tools exceed ${limits.maxRegistrationsPerKind}`);
	if (candidate.commands.length > limits.maxRegistrationsPerKind) return fail("registry_limit_exceeded", `commands exceed ${limits.maxRegistrationsPerKind}`);
	if (candidate.flags.length > limits.maxRegistrationsPerKind) return fail("registry_limit_exceeded", `flags exceed ${limits.maxRegistrationsPerKind}`);
	if (candidate.subscriptions.length > limits.maxRegistrationsPerKind) return fail("registry_limit_exceeded", `subscriptions exceed ${limits.maxRegistrationsPerKind}`);

	const duplicateTool = findByDuplicateName(candidate.tools);
	if (duplicateTool !== undefined) return fail("registry_tool_duplicate", `duplicate tool name: ${duplicateTool}`);
	const duplicateCommand = findByDuplicateName(candidate.commands);
	if (duplicateCommand !== undefined) return fail("registry_command_duplicate", `duplicate command name: ${duplicateCommand}`);
	const duplicateFlag = findByDuplicateName(candidate.flags);
	if (duplicateFlag !== undefined) return fail("registry_flag_duplicate", `duplicate flag name: ${duplicateFlag}`);

	const subscriptionNames = new Set<string>();
	for (const subscription of candidate.subscriptions) {
		if (subscriptionNames.has(subscription.name)) return fail("registry_subscription_duplicate", `duplicate subscription: ${subscription.name}`);
		subscriptionNames.add(subscription.name);
		if (!isExtensionEventName(subscription.name)) return fail("registry_subscription_unknown", `event is not in the projection whitelist: ${subscription.name}`);
	}

	for (const tool of candidate.tools) {
		if (byteLength(tool.parameters) > maxToolSchemaBytes) return fail("registry_tool_schema_oversize", `tool ${tool.name} parameter schema exceeds ${maxToolSchemaBytes} bytes`);
	}

	// host 自报的 package 绑定必须与 owner 当前信任的 digest 一致：host 不能
	// 通过谎报 identity 让自己的注册表绑定到另一个 receipt。
	if (candidate.packageId !== options.packageId || candidate.digest !== options.digest) {
		return fail("registry_identity_mismatch", "registry identity does not match the active package binding");
	}

	const snapshot = {
		generation: options.generation,
		hostPid: options.hostPid,
		packageId: options.packageId,
		digest: options.digest,
		tools: [...candidate.tools].sort(byName),
		commands: [...candidate.commands].sort(byName),
		flags: [...candidate.flags].sort(byName),
		subscriptions: [...candidate.subscriptions].sort(byName),
		limits,
	} satisfies ExtensionRegistrySnapshot;
	return { ok: true, snapshot: Object.freeze(snapshot), identityDigest: extensionRegistryIdentityDigest(snapshot) };
}

/**
 * 注册表 identity：只由 package 绑定与已排序的注册内容决定，与 hostPid、
 * generation、到达顺序无关。trust receipt 与 reload 判定都用它。
 */
export function extensionRegistryIdentityDigest(snapshot: ExtensionRegistrySnapshot): string {
	return canonicalDigest({
		packageId: snapshot.packageId,
		digest: snapshot.digest,
		tools: snapshot.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, approvalClass: tool.approvalClass })),
		commands: snapshot.commands.map((command) => ({ name: command.name, description: command.description, argumentHint: command.argumentHint ?? null })),
		flags: snapshot.flags.map((flag) => ({ name: flag.name, description: flag.description, type: flag.type })),
		subscriptions: snapshot.subscriptions.map((subscription) => subscription.name),
		limits: snapshot.limits,
	});
}

/** 一份不注册任何东西的合法注册表；P1 的握手基线。 */
export function emptyExtensionRegistry(input: {
	readonly packageId: string;
	readonly digest: string;
	readonly hostPid: number;
	readonly generation: number;
	readonly limits?: ExtensionHostLimits;
}): ExtensionRegistrySnapshot {
	const limits = input.limits ?? EXTENSION_DEFAULT_HOST_LIMITS;
	return Object.freeze({
		generation: input.generation,
		hostPid: input.hostPid,
		packageId: input.packageId,
		digest: input.digest,
		tools: [] as ExtensionRegistrySnapshot["tools"],
		commands: [] as ExtensionRegistrySnapshot["commands"],
		flags: [] as ExtensionRegistrySnapshot["flags"],
		subscriptions: [] as ExtensionRegistrySnapshot["subscriptions"],
		limits,
	});
}
