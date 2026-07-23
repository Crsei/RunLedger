/** requested/resolved/backend/effective 四层决策，restrictive unavailable 时 fail closed。 */

import type { SandboxProfileName } from "../../runtime/protocol/v3/capability.ts";
import type { SecurityResult } from "../types.ts";
import type { SandboxBackendCapability } from "./types.ts";

export interface ResolvedSandboxPolicy {
	requested: SandboxProfileName;
	resolved: SandboxProfileName;
	effectiveEnforcement: "enforced" | "degraded" | "unavailable" | "off";
	backendId: string;
	reason?: string;
}

export function resolveSandboxPolicy(
	requested: SandboxProfileName,
	capability: SandboxBackendCapability,
): SecurityResult<ResolvedSandboxPolicy> {
	if (requested === "off") {
		return { ok: true, value: { requested, resolved: "off", effectiveEnforcement: "off", backendId: `${capability.backendId}-off` } };
	}
	if (requested === "external") {
		return capability.status === "external"
			? { ok: true, value: { requested, resolved: "external", effectiveEnforcement: "degraded", backendId: capability.backendId, reason: capability.reason ?? "external enforcement is not locally attestable" } }
			: { ok: false, error: { code: "sandbox_unavailable", message: "external sandbox was requested without an external attestation", retryable: false } };
	}
	if (
		capability.status !== "available" ||
		!capability.supportsFilesystemIsolation ||
		!capability.supportsChildIsolation
	) {
		return { ok: false, error: { code: "sandbox_unavailable", message: capability.reason ?? "restrictive sandbox backend is unavailable", retryable: false } };
	}
	return { ok: true, value: { requested, resolved: requested, effectiveEnforcement: "enforced", backendId: capability.backendId } };
}
