/**
 * Private POSIX process supervisor used by the governed pipe backend.
 *
 * The Host owns this process only through pipes and the IPC channel. The
 * command's process group is created here, so a stop or a Host disconnect can
 * settle the whole descendant group before the supervisor exits. No message
 * from this file is a public process DTO.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

interface SupervisorCommand {
	readonly type: "start";
	readonly command: {
		readonly executable: string;
		readonly args: readonly string[];
		readonly cwd: string;
		readonly env?: NodeJS.ProcessEnv;
	};
}

interface SupervisorStop {
	readonly type: "stop";
	readonly signal: NodeJS.Signals;
}

interface SupervisorExit {
	readonly type: "exit";
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly containment: "zero_members" | "unknown";
}

let child: ChildProcess | undefined;
let finishing = false;
let started = false;

process.stdin.on("data", (chunk: Buffer) => {
	try {
		if (!child?.stdin || child.stdin.destroyed) return;
		child.stdin.write(chunk);
	} catch {
		// The Host may close stdin concurrently with process settlement.
	}
});
process.stdin.on("end", () => {
	try {
		child?.stdin?.end();
	} catch {
		// EOF is best effort after the Host disconnects.
	}
});

process.on("message", (message: unknown) => {
	if (!started && isStart(message)) {
		started = true;
		start(message);
		return;
	}
	if (isStop(message)) void stop(message.signal);
});

process.once("disconnect", () => {
	void stop("SIGTERM");
});
process.once("SIGTERM", () => {
	void stop("SIGTERM");
});
process.once("SIGINT", () => {
	void stop("SIGINT");
});

function start(message: SupervisorCommand): void {
	try {
		child = spawn(message.command.executable, [...message.command.args], {
			cwd: message.command.cwd,
			env: message.command.env,
			shell: false,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
		child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
		child.stdin?.on("error", () => {});
		child.once("error", () => { void finish(null, null); });
		child.once("close", (exitCode, signal) => { void finish(exitCode, signal); });
	} catch {
		void finish(null, null);
	}
}

async function stop(signal: NodeJS.Signals): Promise<void> {
	if (finishing) return;
	const pid = child?.pid;
	try {
		if (pid !== undefined && process.platform !== "win32") process.kill(-pid, signal);
		else child?.kill(signal);
	} catch {
		// A child that has already exited is settled by its close event.
	}
	if (child === undefined) await finish(null, signal);
}

async function finish(exitCode: number | null, signal: string | null): Promise<void> {
	if (finishing) return;
	finishing = true;
	const containment = await settleProcessGroup(child?.pid);
	send({ type: "exit", exitCode, signal, containment });
	process.exitCode = 0;
	if (process.connected) process.disconnect();
	process.stdin.pause();
	process.stdin.destroy();
}

async function settleProcessGroup(pid: number | undefined): Promise<"zero_members" | "unknown"> {
	if (pid === undefined || process.platform === "win32") return "unknown";
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			process.kill(-pid, 0);
		} catch (error) {
			if (isNoSuchProcess(error)) return "zero_members";
			return "unknown";
		}
		await delay(10);
	}
	return "unknown";
}

function send(message: SupervisorExit): void {
	if (!process.connected || !process.send) return;
	try {
		process.send(message, () => {});
	} catch {
		// The parent may have died before the settlement receipt was delivered.
	}
}

function isStart(value: unknown): value is SupervisorCommand {
	if (!isRecord(value) || value.type !== "start" || !isRecord(value.command)) return false;
	return typeof value.command.executable === "string" && value.command.executable.length > 0 &&
		Array.isArray(value.command.args) && value.command.args.every((arg): arg is string => typeof arg === "string") &&
		typeof value.command.cwd === "string" && value.command.cwd.length > 0;
}

function isStop(value: unknown): value is SupervisorStop {
	if (!isRecord(value) || value.type !== "stop") return false;
	return typeof value.signal === "string" && value.signal.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNoSuchProcess(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
