/** Windows 第一版仅 external/off；没有外部证明时 restrictive profile unavailable。 */

import type { SecurityResult } from "../types.ts";
import type {
	SandboxBackend,
	SandboxBackendCapability,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxProcessPort,
	SandboxProcessResult,
} from "./types.ts";

export class WindowsExternalSandboxBackend implements SandboxBackend {
	readonly #processes: SandboxProcessPort;
	readonly #externalAttested: boolean;
	readonly #shellProgram: string;

	public constructor(processes: SandboxProcessPort, externalAttested: boolean, shellProgram = "cmd.exe") {
		this.#processes = processes;
		this.#externalAttested = externalAttested;
		this.#shellProgram = shellProgram;
	}

	public async probe(): Promise<SandboxBackendCapability> {
		return this.#externalAttested
			? { backendId: "windows-external", platform: "windows", status: "external", supportsFilesystemIsolation: false, supportsNetworkDeny: false, supportsChildIsolation: false, reason: "isolation is asserted by the external executor" }
			: { backendId: "windows-unavailable", platform: "windows", status: "unavailable", supportsFilesystemIsolation: false, supportsNetworkDeny: false, supportsChildIsolation: false, reason: "native Windows sandbox backend is not implemented" };
	}

	public async prepare(request: SandboxPrepareRequest): Promise<SecurityResult<SandboxLaunchPlan>> {
		const off = request.requested === "off";
		const external = request.requested === "external" && this.#externalAttested;
		if (!off && !external) {
			return { ok: false, error: { code: "sandbox_unavailable", message: "restrictive Windows sandbox is unavailable", retryable: false } };
		}
		return {
			ok: true,
			value: {
				backendId: off ? "windows-off" : "windows-external",
				requested: request.requested,
				resolved: request.requested,
				effectiveEnforcement: off ? "off" : "degraded",
				policyDigest: request.policyDigest,
				program: this.#shellProgram,
				arguments: ["/d", "/s", "/c", request.command],
				cwd: request.cwd,
				environment: request.environment,
				timeoutMs: request.timeoutMs,
				reason: external ? "external executor attestation required" : undefined,
				...(request.stdin === undefined ? {} : { stdin: request.stdin }),
			},
		};
	}

	public spawn(plan: SandboxLaunchPlan, signal?: AbortSignal): Promise<SecurityResult<SandboxProcessResult>> {
		return this.#processes.spawn(plan, signal);
	}
}
