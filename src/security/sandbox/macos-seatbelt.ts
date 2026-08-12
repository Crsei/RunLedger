/** macOS Seatbelt backend；sandbox-exec 只生成 profile，不在此处 spawn。 */

import {
	createResolutionState,
	digestOf,
	makePlan,
	normalizePrepareRequest,
	offPlan,
	unavailableResult,
	validateFinalLeaf,
	type NormalizedSandboxRequest,
} from "./common.ts";
import type {
	SandboxBackend,
	SandboxCapability,
	SandboxDigestInput,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxPrepareResult,
	SandboxProbePort,
} from "./types.ts";

const MACOS_RUNTIME_READ_ROOTS = ["/System", "/bin", "/lib", "/usr"] as const;

function commandPath(probe: SandboxProbePort, program: string): Promise<string | undefined> {
	return "which" in probe ? probe.which(program) : probe.commandAvailable(program);
}

function quoteSeatbelt(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function unavailableCapability(reason: string): SandboxCapability {
	const body = {
		backendId: "macos-seatbelt",
		platform: "macos" as const,
		status: "unavailable" as const,
		supportsFilesystemIsolation: false,
		supportsNetworkDeny: false,
		supportsChildIsolation: false,
		deprecated: true,
		reason,
	};
	return { ...body, capabilityDigest: digestOf(body) };
}

export class MacOsSeatbeltBackend implements SandboxBackend {
	public readonly backendId = "macos-seatbelt";
	readonly #probe: SandboxProbePort;
	readonly #shellProgram: string;
	#capability: Promise<SandboxCapability> | undefined;

	public constructor(probe: SandboxProbePort, shellProgram = "/bin/sh") {
		this.#probe = probe;
		this.#shellProgram = shellProgram;
	}

	public probe(): Promise<SandboxCapability> {
		this.#capability ??= this.#runProbe();
		return this.#capability;
	}

	async #runProbe(): Promise<SandboxCapability> {
		try {
			const path = await commandPath(this.#probe, "sandbox-exec");
			if (path === undefined) return unavailableCapability("sandbox-exec is unavailable; Seatbelt CLI is deprecated");
			const body = {
				backendId: this.backendId,
				platform: "macos" as const,
				status: "available" as const,
				supportsFilesystemIsolation: true,
				supportsNetworkDeny: true,
				supportsChildIsolation: true,
				deprecated: true,
				commandPath: path,
			};
			return { ...body, capabilityDigest: digestOf(body) };
		} catch (error) {
			const reason = error instanceof Error ? error.message : "Seatbelt probe failed";
			return unavailableCapability(`Seatbelt probe failed: ${reason}`);
		}
	}

	public async prepare(request: SandboxPrepareRequest): Promise<SandboxPrepareResult> {
		const normalized = normalizePrepareRequest(request);
		if (!normalized.ok) return normalized;
		if (normalized.value.requested === "off") {
			return { ok: true, value: offPlan(normalized.value, this.#shellProgram) };
		}
		const capability = await this.probe();
		if (capability.status !== "available") return unavailableResult(this.backendId, normalized.value, capability.reason ?? "Seatbelt is unavailable");
		if (normalized.value.resolved === "external") return unavailableResult(this.backendId, normalized.value, "external sandbox requires an external attestation");
		const path = capability.commandPath;
		if (path === undefined) return unavailableResult(this.backendId, normalized.value, "sandbox-exec disappeared after probe");
		return { ok: true, value: this.#makePlan(normalized.value, path) };
	}

	public async validateFinalLeaf(plan: SandboxLaunchPlan, requestDigest: SandboxDigestInput) {
		return validateFinalLeaf(plan, requestDigest, this);
	}

	#makePlan(request: NormalizedSandboxRequest, sandboxExecPath: string): SandboxLaunchPlan {
		const state = createResolutionState(this.backendId, request.requested, request.resolved, request.resolved, "enforced");
		const rules: string[] = ["(version 1)", "(deny default)", "(allow process*)"];
		for (const root of [...MACOS_RUNTIME_READ_ROOTS, ...request.readRoots].sort()) {
			rules.push(`(allow file-read* (subpath "${quoteSeatbelt(root)}"))`);
		}
		for (const root of request.writeRoots) {
			if (request.resolved !== "read-only") rules.push(`(allow file-write* (subpath "${quoteSeatbelt(root)}"))`);
		}
		for (const denied of request.denyRead) rules.push(`(deny file-read* (subpath "${quoteSeatbelt(denied)}"))`);
		for (const protectedPath of request.protectedPaths) rules.push(`(deny file-write* (subpath "${quoteSeatbelt(protectedPath)}"))`);
		if (request.network === "allow") rules.push("(allow network*)");
		return makePlan(state, request, sandboxExecPath, ["-p", rules.join(" "), "--", this.#shellProgram, "-c", request.command]);
	}
}
