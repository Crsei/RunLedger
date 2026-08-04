/** Windows/未知平台的显式 unavailable backend；不把限制请求降级为 raw shell。 */

import {
	digestOf,
	normalizePrepareRequest,
	offPlan,
	validateFinalLeaf,
	unavailableResult,
	type NormalizedSandboxRequest,
} from "./common.ts";
import type {
	SandboxBackend,
	SandboxCapability,
	SandboxDigestInput,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxPrepareResult,
} from "./types.ts";

export class UnavailableSandboxBackend implements SandboxBackend {
	public readonly backendId: string;
	readonly #platform: "windows" | "unknown";
	readonly #reason: string;
	readonly #shellProgram: string;

	public constructor(platform: "windows" | "unknown", reason: string, shellProgram = "/bin/sh") {
		this.#platform = platform;
		this.#reason = reason;
		this.#shellProgram = shellProgram;
		this.backendId = `${platform}-sandbox-unavailable`;
	}

	public async probe(): Promise<SandboxCapability> {
		const body = {
			backendId: this.backendId,
			platform: this.#platform,
			status: "unavailable" as const,
			supportsFilesystemIsolation: false,
			supportsNetworkDeny: false,
			supportsChildIsolation: false,
			reason: this.#reason,
		};
		return { ...body, capabilityDigest: digestOf(body) };
	}

	public async prepare(request: SandboxPrepareRequest): Promise<SandboxPrepareResult> {
		const normalized = normalizePrepareRequest(request);
		if (!normalized.ok) return normalized;
		if (normalized.value.requested === "off") return { ok: true, value: offPlan(normalized.value, this.#shellProgram) };
		return unavailableResult(this.backendId, normalized.value, this.#reason);
	}

	public async validateFinalLeaf(plan: SandboxLaunchPlan, requestDigest: SandboxDigestInput) {
		return validateFinalLeaf(plan, requestDigest, this);
	}
}

export class WindowsSandboxBackend extends UnavailableSandboxBackend {
	public constructor() {
		super("windows", "native Windows sandbox backend is unavailable; no implicit downgrade is allowed", "cmd.exe");
	}
}
