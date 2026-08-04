/** 只解析 sandbox 的四层状态；restrictive backend unavailable 时不静默降级。 */

import type { SandboxProfileName } from "../../runtime/contracts/public.ts";
import { createResolutionState } from "./common.ts";
import type { SandboxCapability, SandboxResolutionState, SandboxResult } from "./types.ts";

export function resolveSandboxPolicy(
	requested: SandboxProfileName,
	capability: SandboxCapability,
	resolved = requested,
): SandboxResult<SandboxResolutionState> {
	if (requested === "off") {
		if (resolved !== "off") return { ok: false, error: { code: "invalid_request", message: "off request cannot resolve to a restrictive profile", retryable: false } };
		return { ok: true, value: createResolutionState("builtin-none", requested, resolved, "off", "off", "explicit builtin-none/off request") };
	}
	if (resolved === "off") return { ok: false, error: { code: "invalid_request", message: "restrictive request cannot resolve to builtin-none/off", retryable: false } };
	if (resolved === "external") return { ok: false, error: { code: "sandbox_unavailable", message: "external sandbox requires an external attestation", retryable: false } };
	if (
		capability.status !== "available" ||
		!capability.supportsFilesystemIsolation ||
		!capability.supportsChildIsolation
	) {
		return {
			ok: false,
			error: {
				code: "sandbox_unavailable",
				message: capability.reason ?? "restrictive sandbox backend is unavailable",
				retryable: false,
				state: createResolutionState(capability.backendId, requested, resolved, resolved, "unavailable", capability.reason),
			},
		};
	}
	return { ok: true, value: createResolutionState(capability.backendId, requested, resolved, resolved, "enforced") };
}
