/** macOS Seatbelt backend；仅在 sandbox-exec 实际可用时声称 enforced。 */

import type { SecurityResult } from "../types.ts";
import type {
	SandboxBackend,
	SandboxBackendCapability,
	SandboxCommandProbePort,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxProcessPort,
	SandboxProcessResult,
} from "./types.ts";

function unavailable(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "sandbox_unavailable", message, retryable: false } };
}

function quoteSeatbelt(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export class MacOsSeatbeltBackend implements SandboxBackend {
	readonly #probePort: SandboxCommandProbePort;
	readonly #processes: SandboxProcessPort;
	readonly #shellProgram: string;

	public constructor(probe: SandboxCommandProbePort, processes: SandboxProcessPort, shellProgram = "/bin/sh") {
		this.#probePort = probe;
		this.#processes = processes;
		this.#shellProgram = shellProgram;
	}

	public async probe(): Promise<SandboxBackendCapability> {
		const path = await this.#probePort.which("sandbox-exec");
		return path
			? { backendId: "macos-seatbelt", platform: "macos", status: "available", supportsFilesystemIsolation: true, supportsNetworkDeny: true, supportsChildIsolation: true }
			: { backendId: "macos-seatbelt", platform: "macos", status: "unavailable", supportsFilesystemIsolation: false, supportsNetworkDeny: false, supportsChildIsolation: false, reason: "sandbox-exec is unavailable" };
	}

	public async prepare(request: SandboxPrepareRequest): Promise<SecurityResult<SandboxLaunchPlan>> {
		if (request.requested === "off") {
			return {
				ok: true,
				value: {
					backendId: "macos-off", requested: "off", resolved: "off", effectiveEnforcement: "off",
					policyDigest: request.policyDigest, program: this.#shellProgram, arguments: ["-lc", request.command],
					cwd: request.cwd, environment: request.environment, timeoutMs: request.timeoutMs,
					...(request.stdin === undefined ? {} : { stdin: request.stdin }),
				},
			};
		}
		if (request.requested === "external") return unavailable("Seatbelt backend cannot attest an external sandbox");
		const capability = await this.probe();
		const program = await this.#probePort.which("sandbox-exec");
		if (capability.status !== "available" || !program) return unavailable(capability.reason ?? "Seatbelt is unavailable");
		const rules = ["(version 1)", "(deny default)", "(allow process*)", "(allow file-read*)"];
		for (const root of request.writeRoots) rules.push(`(allow file-write* (subpath \"${quoteSeatbelt(root)}\"))`);
		for (const denied of request.denyRead) rules.push(`(deny file-read* (subpath \"${quoteSeatbelt(denied)}\"))`);
		for (const protectedPath of [...request.denyWrite, ...request.protectedPaths]) {
			rules.push(`(deny file-write* (subpath \"${quoteSeatbelt(protectedPath)}\"))`);
		}
		if (request.network === "allow") rules.push("(allow network*)");
		const profile = rules.join(" ");
		return {
			ok: true,
			value: {
				backendId: capability.backendId,
				requested: request.requested,
				resolved: request.requested,
				effectiveEnforcement: "enforced",
				policyDigest: request.policyDigest,
				program,
				arguments: ["-p", profile, "--", this.#shellProgram, "-lc", request.command],
				cwd: request.cwd,
				environment: request.environment,
				timeoutMs: request.timeoutMs,
				...(request.stdin === undefined ? {} : { stdin: request.stdin }),
			},
		};
	}

	public spawn(plan: SandboxLaunchPlan, signal?: AbortSignal): Promise<SecurityResult<SandboxProcessResult>> {
		return this.#processes.spawn(plan, signal);
	}
}
