/** Linux bubblewrap backend；只做 capability probe 和确定性 launch plan。 */

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
	SandboxResult,
} from "./types.ts";

const LINUX_RUNTIME_READ_ROOTS = ["/bin", "/lib", "/lib64", "/sbin", "/usr"] as const;

function commandPath(probe: SandboxProbePort, program: string): Promise<string | undefined> {
	return "which" in probe ? probe.which(program) : probe.commandAvailable(program);
}

function unavailableCapability(reason: string): SandboxCapability {
	const body = {
		backendId: "linux-bwrap",
		platform: "linux" as const,
		status: "unavailable" as const,
		supportsFilesystemIsolation: false,
		supportsNetworkDeny: false,
		supportsChildIsolation: false,
		reason,
	};
	return { ...body, capabilityDigest: digestOf(body) };
}

export class LinuxBwrapBackend implements SandboxBackend {
	public readonly backendId = "linux-bwrap";
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
			const path = await commandPath(this.#probe, "bwrap");
			if (path === undefined) return unavailableCapability("bubblewrap executable is unavailable");
			const body = {
				backendId: this.backendId,
				platform: "linux" as const,
				status: "available" as const,
				supportsFilesystemIsolation: true,
				supportsNetworkDeny: true,
				supportsChildIsolation: true,
				commandPath: path,
			};
			return { ...body, capabilityDigest: digestOf(body) };
		} catch (error) {
			const reason = error instanceof Error ? error.message : "bubblewrap probe failed";
			return unavailableCapability(`bubblewrap probe failed: ${reason}`);
		}
	}

	public async prepare(request: SandboxPrepareRequest): Promise<SandboxPrepareResult> {
		const normalized = normalizePrepareRequest(request);
		if (!normalized.ok) return normalized;
		if (normalized.value.requested === "off") {
			return { ok: true, value: offPlan(normalized.value, this.#shellProgram) };
		}
		const capability = await this.probe();
		if (capability.status !== "available") return unavailableResult(this.backendId, normalized.value, capability.reason ?? "bubblewrap is unavailable");
		if (normalized.value.resolved === "external") return unavailableResult(this.backendId, normalized.value, "external sandbox requires an external attestation");
		const path = capability.commandPath;
		if (path === undefined) return unavailableResult(this.backendId, normalized.value, "bubblewrap executable disappeared after probe");
		return { ok: true, value: this.#makePlan(normalized.value, path) };
	}

	public async validateFinalLeaf(plan: SandboxLaunchPlan, requestDigest: SandboxDigestInput) {
		return validateFinalLeaf(plan, requestDigest, this);
	}

	#makePlan(request: NormalizedSandboxRequest, bwrapPath: string): SandboxLaunchPlan {
		const state = createResolutionState(this.backendId, request.requested, request.resolved, request.resolved, "enforced");
		const argumentsList: string[] = ["--die-with-parent", "--new-session", "--unshare-pid"];
		for (const root of LINUX_RUNTIME_READ_ROOTS) argumentsList.push("--ro-bind", root, root);
		for (const root of request.readRoots) argumentsList.push("--ro-bind", root, root);
		argumentsList.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
		for (const root of request.writeRoots) {
			if (request.resolved !== "read-only") argumentsList.push("--bind", root, root);
		}
		for (const protectedPath of request.protectedPaths) argumentsList.push("--ro-bind", protectedPath, protectedPath);
		for (const denied of request.denyRead) argumentsList.push("--tmpfs", denied);
		if (request.network === "deny") argumentsList.push("--unshare-net");
		argumentsList.push("--chdir", request.cwd, this.#shellProgram, "-c", request.command);
		return makePlan(state, request, bwrapPath, argumentsList);
	}
}
