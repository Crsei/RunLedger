/** Builtin Harness Profile lookup；stored ref 与 registry 不一致时 fail closed。 */

import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { builtinHarnessProfiles } from "./builtins.ts";
import {
	isHarnessProfileRef,
	type HarnessProfileDescriptor,
	type HarnessProfileId,
	type HarnessProfileRef,
	type HarnessProfileResolution,
} from "./types.ts";

function key(id: HarnessProfileId, version: number): string {
	return `${id}@${version}`;
}

const descriptorByKey = new Map<string, HarnessProfileDescriptor>(
	builtinHarnessProfiles().map((descriptor) => [key(descriptor.id, descriptor.version), descriptor]),
);

export function harnessProfileDescriptorDigest(descriptor: HarnessProfileDescriptor): RuntimeDigest {
	return runtimeDigest(descriptor);
}

function refFor(id: HarnessProfileId, version: 1 | 2 = 1): HarnessProfileRef {
	const descriptor = descriptorByKey.get(key(id, version));
	if (descriptor === undefined) throw new Error(`builtin harness profile missing: ${id}@${version}`);
	return Object.freeze({
		id,
		version,
		descriptorDigest: Object.freeze(harnessProfileDescriptorDigest(descriptor)),
	});
}

const STANDARD_REF = refFor("standard");
const STANDARD_EXECUTION_REF = refFor("standard", 2);
const MINIMAL_REF = refFor("minimal");
const SHELL_ONLY_REF = refFor("minimal", 2);
const PLAN_REF = refFor("plan");
const PLAN_V2_REF = refFor("plan", 2);

/** 产品当前使用的 plan profile;plan@1 仅为历史 receipt 重放保留。 */
export function planHarnessProfileRef(): HarnessProfileRef {
	return PLAN_V2_REF;
}

/** 历史 plan profile ref(用于读取既有 Session 的 durable ref)。 */
export function legacyPlanHarnessProfileRef(): HarnessProfileRef {
	return PLAN_REF;
}

export function shellOnlyHarnessProfileRef(): HarnessProfileRef {
	return SHELL_ONLY_REF;
}

/** 无参数调用保留旧 ref；产品新建 default 显式选择版本 2。 */
export function standardHarnessProfileRef(version: 1 | 2 = 1): HarnessProfileRef {
	return version === 1 ? STANDARD_REF : STANDARD_EXECUTION_REF;
}

export function minimalHarnessProfileRef(): HarnessProfileRef {
	return MINIMAL_REF;
}

export function resolveHarnessProfileId(id: unknown): HarnessProfileResolution {
	if (id === "standard") return resolveHarnessProfile(STANDARD_EXECUTION_REF);
	if (id === "minimal") return resolveHarnessProfile(SHELL_ONLY_REF);
	return {
		ok: false,
		error: {
			code: "unsupported_harness_profile",
			message: `unsupported harness profile: ${typeof id === "string" ? id : "invalid id"}`,
		},
	};
}

export function resolveHarnessProfile(value: unknown): HarnessProfileResolution {
	if (!isHarnessProfileRef(value)) {
		if (isUnsupportedIdentity(value)) {
			return {
				ok: false,
				error: {
					code: "unsupported_harness_profile",
					message: `unsupported harness profile: ${String(value.id)}@${String(value.version)}`,
				},
			};
		}
		return {
			ok: false,
			error: {
				code: "invalid_harness_profile_ref",
				message: "invalid harness profile ref",
			},
		};
	}

	const descriptor = descriptorByKey.get(key(value.id, value.version));
	if (descriptor === undefined) {
		return {
			ok: false,
			error: {
				code: "unsupported_harness_profile",
				message: `unsupported harness profile: ${value.id}@${value.version}`,
			},
		};
	}
	const expected = harnessProfileDescriptorDigest(descriptor);
	if (value.descriptorDigest.algorithm !== expected.algorithm || value.descriptorDigest.digest !== expected.digest) {
		return {
			ok: false,
			error: {
				code: "harness_profile_digest_mismatch",
				message: `harness profile descriptor digest mismatch: ${value.id}@${value.version}`,
			},
		};
	}
	return { ok: true, ref: value, descriptor };
}

function isUnsupportedIdentity(value: unknown): value is { readonly id: unknown; readonly version: unknown } {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (!("id" in record) || !("version" in record)) return false;
	return (typeof record.id === "string" && record.id !== "standard" && record.id !== "minimal" && record.id !== "plan")
		|| (typeof record.version === "number" && !descriptorByKey.has(`${String(record.id)}@${record.version}`));
}
