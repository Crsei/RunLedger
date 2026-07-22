/** Linux bubblewrap backend；缺失时 restrictive profile 不回退 raw shell。 */

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

export class LinuxBwrapBackend implements SandboxBackend {
	readonly #probePort: SandboxCommandProbePort;
	readonly #processes: SandboxProcessPort;
	readonly #shellProgram: string;
	#probeResult: Promise<SandboxBackendCapability> | undefined;

	public constructor(probe: SandboxCommandProbePort, processes: SandboxProcessPort, shellProgram = "/bin/sh") {
		this.#probePort = probe;
		this.#processes = processes;
		this.#shellProgram = shellProgram;
	}

	public probe(): Promise<SandboxBackendCapability> {
		this.#probeResult ??= this.#probeEnforcement();
		return this.#probeResult;
	}

	async #probeEnforcement(): Promise<SandboxBackendCapability> {
		const program = await this.#probePort.which("bwrap");
		const unavailableCapability = (reason: string): SandboxBackendCapability => ({
			backendId: "linux-bwrap",
			platform: "linux",
			status: "unavailable",
			supportsFilesystemIsolation: false,
			supportsNetworkDeny: false,
			supportsChildIsolation: false,
			reason,
		});
		if (!program) return unavailableCapability("bubblewrap executable is unavailable");
		const checked = await this.#processes.spawn({
			backendId: "linux-bwrap",
			requested: "read-only",
			resolved: "read-only",
			effectiveEnforcement: "enforced",
			policyDigest: "0".repeat(64),
			program,
			arguments: [
				"--die-with-parent",
				"--new-session",
				"--ro-bind", "/", "/",
				"--proc", "/proc",
				"--dev", "/dev",
				"--unshare-net",
				"--chdir", "/",
				this.#shellProgram, "-lc", "exit 0",
			],
			cwd: "/",
			environment: {},
			timeoutMs: 2_000,
		});
		if (!checked.ok || checked.value.exitCode !== 0 || checked.value.signaled || checked.value.denied) {
			return unavailableCapability("bubblewrap enforcement self-test failed");
		}
		return {
			backendId: "linux-bwrap",
			platform: "linux",
			status: "available",
			supportsFilesystemIsolation: true,
			supportsNetworkDeny: true,
			supportsChildIsolation: true,
		};
	}

	public async prepare(request: SandboxPrepareRequest): Promise<SecurityResult<SandboxLaunchPlan>> {
		const capability = await this.probe();
		if (request.requested === "off") {
			return {
				ok: true,
				value: {
					backendId: "linux-off",
					requested: "off",
					resolved: "off",
					effectiveEnforcement: "off",
					policyDigest: request.policyDigest,
					program: this.#shellProgram,
					arguments: ["-lc", request.command],
					cwd: request.cwd,
					environment: request.environment,
					timeoutMs: request.timeoutMs,
					...(request.stdin === undefined ? {} : { stdin: request.stdin }),
				},
			};
		}
		if (request.requested === "external") return unavailable("linux bwrap backend cannot attest an external sandbox");
		if (capability.status !== "available") return unavailable(capability.reason ?? "bubblewrap is unavailable");
		const program = await this.#probePort.which("bwrap");
		if (!program) return unavailable("bubblewrap disappeared after probe");
		const launchArguments: string[] = ["--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev"];
		for (const root of request.writeRoots) launchArguments.push("--bind", root, root);
		for (const protectedPath of [...request.denyWrite, ...request.protectedPaths]) {
			launchArguments.push("--ro-bind", protectedPath, protectedPath);
		}
		for (const denied of request.denyRead) launchArguments.push("--tmpfs", denied);
		if (request.network === "deny") launchArguments.push("--unshare-net");
		// bubblewrap 的 CLI 以第一个非 option 参数作为 COMMAND；旧版（例如 0.2.x）
		// 不接受 GNU 风格的 `--` 分隔符。直接追加固定 shell argv 可兼容新旧版本，
		// 且仍由 spawn 的 argv 边界执行，不经过外层 shell 解析。
		launchArguments.push("--chdir", request.cwd, this.#shellProgram, "-lc", request.command);
		return {
			ok: true,
			value: {
				backendId: capability.backendId,
				requested: request.requested,
				resolved: request.requested,
				effectiveEnforcement: "enforced",
				policyDigest: request.policyDigest,
				program,
				arguments: launchArguments,
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
