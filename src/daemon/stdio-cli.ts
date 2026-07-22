/** `runledger-daemon` 的参数解析与 production stdio 装配。 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { resolveCliRuntimeConfiguration } from "../cli/v3-session-commands.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	createRuntimeUnhandledErrorTrigger,
	type RuntimeShutdownTrigger,
} from "../runtime/lifecycle/shutdown.ts";
import { loadProjectSettings, saveProjectSettings } from "../storage/settings-manager.ts";
import { resolveSessionDir } from "../storage/paths.ts";
import { startLocalV3Daemon } from "./local-v3-daemon.ts";
import { createStdioParentPeerEvidence, runStdioControlPlaneHost } from "./stdio-host.ts";

const VERSION = readVersionFromPackage();

export const DAEMON_USAGE = `Usage: runledger-daemon [options]

Run the local Runtime v3 Control Plane over strict JSONL stdin/stdout.
Requires runtimeFeatures.daemon=true and all declared rollout dependencies.

Options:
  --cwd <path>                 Project working directory (default: process.cwd())
  --session-dir <path>         Override the v3 session directory
  --shutdown-timeout-ms <ms>   Bounded drain timeout, 1..300000 (default: 30000)
  -h, --help                   Show this help
  -v, --version                Show the package version
`;

interface ParsedDaemonArgs {
	cwd?: string;
	sessionDir?: string;
	shutdownTimeoutMs: number;
	help: boolean;
	version: boolean;
}

export interface DaemonCliIo {
	input: Readable;
	output: Writable;
	error: Writable;
}

export type DaemonProcessSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** 包装 Node process 事件，使生产 listener 可移除，也可在不触发全局事件的情况下测试。 */
export interface DaemonLifecycleEventSource {
	addSignalListener(signal: DaemonProcessSignal, listener: () => void): void;
	removeSignalListener(signal: DaemonProcessSignal, listener: () => void): void;
	addUncaughtExceptionListener(listener: (error: unknown) => void): void;
	removeUncaughtExceptionListener(listener: (error: unknown) => void): void;
	addUnhandledRejectionListener(listener: (reason: unknown) => void): void;
	removeUnhandledRejectionListener(listener: (reason: unknown) => void): void;
}

export interface InstalledDaemonLifecycleListeners {
	dispose(): void;
}

const NODE_PROCESS_LIFECYCLE_EVENTS: DaemonLifecycleEventSource = {
	addSignalListener: (signal, listener) => { process.on(signal, listener); },
	removeSignalListener: (signal, listener) => { process.off(signal, listener); },
	addUncaughtExceptionListener: (listener) => { process.on("uncaughtException", listener); },
	removeUncaughtExceptionListener: (listener) => { process.off("uncaughtException", listener); },
	addUnhandledRejectionListener: (listener) => { process.on("unhandledRejection", listener); },
	removeUnhandledRejectionListener: (listener) => { process.off("unhandledRejection", listener); },
};

/**
 * 进程级终止源只用 typed trigger 中断 host。stdio host 独占 gate-close/drain 路径；
 * listener 不调用 process.exit，也不向 stdout 写诊断。
 */
export function installDaemonLifecycleListeners(
	controller: AbortController,
	source: DaemonLifecycleEventSource = NODE_PROCESS_LIFECYCLE_EVENTS,
	targetVersion = VERSION,
): InstalledDaemonLifecycleListeners {
	const requestShutdown = (trigger: RuntimeShutdownTrigger): void => {
		if (!controller.signal.aborted) controller.abort(trigger);
	};
	const onSigint = (): void => requestShutdown({ kind: "signal", signal: "SIGINT" });
	const onSigterm = (): void => requestShutdown({ kind: "signal", signal: "SIGTERM" });
	const onSighup = (): void => requestShutdown({
		kind: "daemon_upgrade",
		targetVersionDigest: canonicalDigest(targetVersion),
	});
	const onUncaughtException = (error: unknown): void => requestShutdown(
		createRuntimeUnhandledErrorTrigger("uncaught_exception", error),
	);
	const onUnhandledRejection = (reason: unknown): void => requestShutdown(
		createRuntimeUnhandledErrorTrigger("unhandled_rejection", reason),
	);

	source.addSignalListener("SIGINT", onSigint);
	source.addSignalListener("SIGTERM", onSigterm);
	source.addSignalListener("SIGHUP", onSighup);
	source.addUncaughtExceptionListener(onUncaughtException);
	source.addUnhandledRejectionListener(onUnhandledRejection);
	let disposed = false;
	return {
		dispose: () => {
			if (disposed) return;
			disposed = true;
			source.removeSignalListener("SIGINT", onSigint);
			source.removeSignalListener("SIGTERM", onSigterm);
			source.removeSignalListener("SIGHUP", onSighup);
			source.removeUncaughtExceptionListener(onUncaughtException);
			source.removeUnhandledRejectionListener(onUnhandledRejection);
		},
	};
}

function readVersionFromPackage(): string {
	try {
		const here = new URL(".", import.meta.url);
		const pkgUrl = new URL("../../package.json", here);
		const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "0.0.0-unknown";
	} catch {
		return "0.0.0-unknown";
	}
}

function parsePositiveTimeout(value: string | undefined): number | undefined {
	if (!value || !/^[0-9]+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 300_000 ? parsed : undefined;
}

export function parseDaemonArgs(argv: readonly string[]): { args?: ParsedDaemonArgs; error?: string } {
	const args: ParsedDaemonArgs = { shutdownTimeoutMs: 30_000, help: false, version: false };
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		switch (token) {
			case "-h":
			case "--help":
				args.help = true;
				break;
			case "-v":
			case "--version":
				args.version = true;
				break;
			case "--cwd": {
				const value = argv[index + 1];
				if (!value || value.startsWith("-")) return { error: "--cwd requires a path" };
				args.cwd = value;
				index += 1;
				break;
			}
			case "--session-dir": {
				const value = argv[index + 1];
				if (!value || value.startsWith("-")) return { error: "--session-dir requires a path" };
				args.sessionDir = value;
				index += 1;
				break;
			}
			case "--shutdown-timeout-ms": {
				const value = parsePositiveTimeout(argv[index + 1]);
				if (value === undefined) return { error: "--shutdown-timeout-ms must be an integer from 1 to 300000" };
				args.shutdownTimeoutMs = value;
				index += 1;
				break;
			}
			default:
				return { error: `unknown option: ${token ?? ""}` };
		}
	}
	return { args };
}

function write(stream: Writable, content: string): void {
	stream.write(content, "utf8");
}

export async function daemonMain(
	argv: readonly string[],
	io: DaemonCliIo = { input: process.stdin, output: process.stdout, error: process.stderr },
): Promise<number> {
	const parsed = parseDaemonArgs(argv);
	if (!parsed.args) {
		write(io.error, `[runledger-daemon] ${parsed.error ?? "invalid arguments"}\n\n${DAEMON_USAGE}`);
		return 2;
	}
	if (parsed.args.help) {
		write(io.output, DAEMON_USAGE);
		return 0;
	}
	if (parsed.args.version) {
		write(io.output, `runledger-daemon ${VERSION}\n`);
		return 0;
	}

	const cwd = resolve(parsed.args.cwd ?? process.cwd());
	let settings = await loadProjectSettings(cwd);
	const runtimeConfiguration = resolveCliRuntimeConfiguration(settings);
	const features = runtimeConfiguration.features;
	if (runtimeConfiguration.requiresHistoryPersistence) {
		settings = {
			...settings,
			sessionV3HighestActivatedState: runtimeConfiguration.sessionV3HighestActivatedState,
		};
		await saveProjectSettings(cwd, settings);
	}
	const sessionDir = parsed.args.sessionDir ?? resolveSessionDir(cwd, settings.sessionDir);
	const started = await startLocalV3Daemon({
		cwd,
		sessionDir,
		features,
		shutdownTimeoutMs: parsed.args.shutdownTimeoutMs,
	});
	if (!started.ok) {
		write(io.error, `[runledger-daemon] startup failed: ${started.error.code}: ${started.error.message}\n`);
		return 1;
	}

	const controller = new AbortController();
	const lifecycleListeners = installDaemonLifecycleListeners(controller);
	try {
		const result = await runStdioControlPlaneHost({
			server: started.value.composition.server,
			shutdown: started.value.composition.shutdown,
			input: io.input,
			output: io.output,
			evidence: createStdioParentPeerEvidence(),
			shutdownTimeoutMs: parsed.args.shutdownTimeoutMs,
			signal: controller.signal,
		});
		if (result.shutdown.recoveryRequired) {
			write(io.error, "[runledger-daemon] shutdown completed with recovery-required participants\n");
		}
		if (["terminal_error", "input_error", "output_error", "uncaught_exception", "unhandled_rejection", "transport_error"].includes(result.reason)) {
			write(io.error, `[runledger-daemon] lifecycle shutdown source: ${result.reason}\n`);
			return 1;
		}
		return result.reason === "framing_error" ? 2 : 0;
	} finally {
		lifecycleListeners.dispose();
	}
}
