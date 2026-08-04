/** Production Linux Unix-socket peer attestor backed by SO_PEERCRED. */

import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type net from "node:net";
import { runtimeDigest, type RuntimeDigest } from "../runtime/protocol/foundation.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import type { HostConnectionPrincipal } from "../runtime/host/types.ts";
import type { HostTransportAttestor } from "./runtime-host-transport.ts";

export type LinuxPeerAttestorFailure = "adapter_unavailable" | "peer_uid_mismatch";

export type LinuxPeerAttestorPreflight =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: LinuxPeerAttestorFailure };

export interface LinuxPeerCredentialProbe {
	readonly pid: number;
	readonly uid: number;
	readonly gid: number;
	readonly device: string;
	readonly inode: string;
	readonly nonce: string;
}

export interface LinuxSocketPeerAttestorOptions {
	readonly helperPath: string;
	readonly expectedUid?: number;
	readonly scopeDigest: RuntimeDigest;
	readonly hostGeneration: number;
	readonly timeoutMs?: number;
}

interface SocketWithHandle extends net.Socket {
	readonly _handle?: { readonly fd?: number };
}

const DIGEST = /^[a-f0-9]{64}$/u;

export function defaultLinuxPeerCredentialHelperPath(): string {
	return fileURLToPath(new URL("../../dist/native/runledger-linux-peer-credential", import.meta.url));
}

export class LinuxSocketPeerAttestor implements HostTransportAttestor {
	private readonly helperPath: string;
	private readonly expectedUid: number;
	private readonly scopeDigest: RuntimeDigest;
	private readonly hostGeneration: number;
	private readonly timeoutMs: number;

	public constructor(options: LinuxSocketPeerAttestorOptions) {
		if (process.platform !== "linux") throw new Error("Linux SO_PEERCRED attestor is unsupported on this platform");
		if (!Number.isSafeInteger(options.hostGeneration) || options.hostGeneration < 0) throw new Error("hostGeneration is invalid");
		if (!DIGEST.test(options.scopeDigest.digest)) throw new Error("scopeDigest is invalid");
		const expectedUid = options.expectedUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
		if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) throw new Error("expectedUid is invalid");
		const timeoutMs = options.timeoutMs ?? 1_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("timeoutMs is invalid");
		this.helperPath = options.helperPath;
		this.expectedUid = expectedUid;
		this.scopeDigest = options.scopeDigest;
		this.hostGeneration = options.hostGeneration;
		this.timeoutMs = timeoutMs;
	}

	public async preflight(): Promise<LinuxPeerAttestorPreflight> {
		if (this.expectedUid !== (typeof process.getuid === "function" ? process.getuid() : -1)) return { ok: false, code: "peer_uid_mismatch" };
		try {
			const info = await lstat(this.helperPath);
			if (!info.isFile() || (info.mode & 0o111) === 0) return { ok: false, code: "adapter_unavailable" };
			return { ok: true };
		} catch {
			return { ok: false, code: "adapter_unavailable" };
		}
	}

	public async attest(socket: net.Socket): Promise<HostConnectionPrincipal | undefined> {
		if ((await this.preflight()).ok === false) return undefined;
		const fd = (socket as SocketWithHandle)._handle?.fd;
		if (fd === undefined || socket.destroyed) return undefined;
		const nonce = randomBytes(32).toString("hex");
		const probe = await runProbe(this.helperPath, fd, nonce, this.timeoutMs);
		if (!probe || probe.uid !== this.expectedUid || probe.nonce !== nonce || probe.pid < 1 || probe.gid < 0) return undefined;
		const channelBindingDigest = runtimeDigest({
			adapter: "linux-so-peercred",
			device: probe.device,
			gid: probe.gid,
			hostGeneration: this.hostGeneration,
			inode: probe.inode,
			nonce,
			peerPid: probe.pid,
			peerUid: probe.uid,
			scopeDigest: this.scopeDigest,
		});
		return {
			principalId: createRuntimeId("principal", `uid_${probe.uid}`),
			connectionId: createRuntimeId("connection", nonce),
			attestationDigest: runtimeDigest({
				adapter: "linux-so-peercred",
				channelBindingDigest,
				hostGeneration: this.hostGeneration,
				scopeDigest: this.scopeDigest,
			}),
		};
	}
}

export function createLinuxSocketPeerAttestor(options: LinuxSocketPeerAttestorOptions): LinuxSocketPeerAttestor {
	return new LinuxSocketPeerAttestor(options);
}

async function runProbe(helperPath: string, fd: number, nonce: string, timeoutMs: number): Promise<LinuxPeerCredentialProbe | undefined> {
	return new Promise((resolve) => {
		const child = spawn(helperPath, [nonce], { stdio: [fd, "pipe", "ignore"] });
		let output = "";
		let settled = false;
		const finish = (value: LinuxPeerCredentialProbe | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(undefined);
		}, timeoutMs);
		timer.unref?.();
		child.once("error", () => finish(undefined));
		child.once("close", (code) => {
			if (code !== 0) {
				finish(undefined);
				return;
			}
			const newline = output.indexOf("\n");
			if (newline < 0 || Buffer.byteLength(output.slice(0, newline), "utf8") > 4_096) {
				finish(undefined);
				return;
			}
			try {
				const parsed = JSON.parse(output.slice(0, newline)) as unknown;
				finish(isProbe(parsed) ? parsed : undefined);
			} catch {
				finish(undefined);
			}
		});
		readBounded(child.stdout, (chunk) => {
			output += chunk;
			if (Buffer.byteLength(output, "utf8") > 4_096) finish(undefined);
		});
	});
}

function readBounded(stream: Readable | null, onChunk: (chunk: string) => void): void {
	if (!stream) return;
	stream.setEncoding("utf8");
	stream.on("data", onChunk);
}

function isProbe(value: unknown): value is LinuxPeerCredentialProbe {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return Number.isSafeInteger(candidate.pid) && typeof candidate.uid === "number" && Number.isSafeInteger(candidate.uid) &&
		typeof candidate.gid === "number" && Number.isSafeInteger(candidate.gid) && typeof candidate.device === "string" &&
		typeof candidate.inode === "string" && typeof candidate.nonce === "string";
}
