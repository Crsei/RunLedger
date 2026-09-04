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

function key(id: HarnessProfileId, version: 1): string {
	return `${id}@${version}`;
}

const descriptorByKey = new Map<string, HarnessProfileDescriptor>(
	builtinHarnessProfiles().map((descriptor) => [key(descriptor.id, descriptor.version), descriptor]),
);

export function harnessProfileDescriptorDigest(descriptor: HarnessProfileDescriptor): RuntimeDigest {
	return runtimeDigest(descriptor);
}

function refFor(id: HarnessProfileId): HarnessProfileRef {
	const descriptor = descriptorByKey.get(key(id, 1));
	if (descriptor === undefined) throw new Error(`builtin harness profile missing: ${id}@1`);
	return Object.freeze({
		id,
		version: 1,
		descriptorDigest: Object.freeze(harnessProfileDescriptorDigest(descriptor)),
	});
}

const STANDARD_REF = refFor("standard");
const MINIMAL_REF = refFor("minimal");

export function standardHarnessProfileRef(): HarnessProfileRef {
	return STANDARD_REF;
}

export function minimalHarnessProfileRef(): HarnessProfileRef {
	return MINIMAL_REF;
}

export function resolveHarnessProfileId(id: unknown): HarnessProfileResolution {
	if (id === "standard") return resolveHarnessProfile(STANDARD_REF);
	if (id === "minimal") return resolveHarnessProfile(MINIMAL_REF);
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
	return (typeof record.id === "string" && record.id !== "standard" && record.id !== "minimal")
		|| (typeof record.version === "number" && record.version !== 1);
}
