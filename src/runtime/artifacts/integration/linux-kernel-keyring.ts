/** Linux kernel keyring-backed Artifact key port。 */

import { spawn } from "node:child_process";
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type {
	ArtifactKeyProviderStatus,
	ArtifactKeyPurpose,
	OsKeyringPort,
	OsKeyringReadResult,
} from "../key-provider.ts";

export const KEYCTL_PROGRAM = "/bin/keyctl" as const;

const ROOT_KEYRING = "@u";
const KEY_TYPE = "user";
const KEYRING_TYPE = "keyring";
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_KEYS = 256;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 25;
const DEFAULT_LOCK_STALE_MS = 30_000;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SERIAL_PATTERN = /^[1-9][0-9]*$/u;
const PURPOSES = new Set<ArtifactKeyPurpose>(["source_receipt", "forensic_encrypt", "forensic_decrypt"]);

export type KeyctlCommandStatus = "completed" | "unavailable" | "timed_out" | "output_limit";

export interface KeyctlCommandRequest {
	program: typeof KEYCTL_PROGRAM;
	arguments: readonly string[];
	stdin?: Uint8Array;
	timeoutMs: number;
	maxOutputBytes: number;
}

export interface KeyctlCommandResult {
	status: KeyctlCommandStatus;
	exitCode?: number;
	stdout: Uint8Array;
	stderr: Uint8Array;
	reason?: "unsupported_platform" | "program_not_found" | "process_error";
}

/** 测试可注入 fake；生产实现必须直接执行固定的 `/bin/keyctl`。 */
export interface KeyctlCommandPort {
	run(request: KeyctlCommandRequest): Promise<KeyctlCommandResult>;
}

export interface KeyringMutationLockPort {
	withLock<T>(identity: string, operation: () => Promise<T>): Promise<T>;
}

export type LinuxKeyringUnavailableReason =
	| "unsupported_platform"
	| "command_unavailable"
	| "command_timed_out"
	| "command_output_limit"
	| "command_failed"
	| "invalid_inventory"
	| "inventory_limit"
	| "lock_unavailable"
	| "invalid_key_payload"
	| "mutation_uncertain";

export type LinuxKeyringListResult =
	| {
		status: "available";
		activeVersion: string;
		availableVersions: readonly string[];
	}
	| {
		status: "lost";
		activeVersion?: string;
		availableVersions: readonly string[];
	}
	| {
		status: "unavailable";
		availableVersions: readonly [];
		reason: LinuxKeyringUnavailableReason;
	};

export type LinuxKeyringProvisionResult =
	| {
		status: "available";
		version: string;
		created: boolean;
		availableVersions: readonly string[];
	}
	| {
		status: "lost";
		activeVersion?: string;
		availableVersions: readonly string[];
	}
	| {
		status: "unavailable";
		reason: LinuxKeyringUnavailableReason;
	};

export type LinuxKeyringRotationResult =
	| {
		status: "rotated";
		version: string;
		previousVersion?: string;
		availableVersions: readonly string[];
	}
	| {
		status: "conflict";
		version: string;
		activeVersion?: string;
		availableVersions: readonly string[];
	}
	| {
		status: "lost";
		activeVersion?: string;
		availableVersions: readonly string[];
	}
	| {
		status: "unavailable";
		reason: LinuxKeyringUnavailableReason;
	};

export interface LinuxKernelKeyringOptions {
	namespace: string;
	purpose: ArtifactKeyPurpose;
	command?: KeyctlCommandPort;
	mutationLock?: KeyringMutationLockPort;
	lockDirectory?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	maxKeys?: number;
	lockTimeoutMs?: number;
	lockRetryDelayMs?: number;
	lockStaleMs?: number;
	platform?: NodeJS.Platform;
	randomBytes?: (size: number) => Uint8Array;
	clock?: () => number;
}

export interface LinuxKeyringEnsureRequest {
	version?: string;
}

export interface LinuxKeyringRotationRequest {
	version?: string;
}

export interface EnsuredLinuxKernelKeyringPort {
	port: LinuxKernelKeyringPort;
	result: LinuxKeyringProvisionResult;
}

interface BufferedCommandState {
	chunks: Buffer[];
	bytes: number;
}

function wipe(bytes: Uint8Array | undefined): void {
	bytes?.fill(0);
}

function wipeChunks(chunks: Buffer[]): void {
	for (const chunk of chunks) chunk.fill(0);
	chunks.length = 0;
}

function appendBounded(
	state: BufferedCommandState,
	chunk: Buffer,
	maximum: number,
): boolean {
	if (state.bytes + chunk.byteLength > maximum) {
		chunk.fill(0);
		return false;
	}
	const copy = Buffer.from(chunk);
	chunk.fill(0);
	state.chunks.push(copy);
	state.bytes += copy.byteLength;
	return true;
}

function assembled(state: BufferedCommandState): Uint8Array {
	const output = Buffer.concat(state.chunks, state.bytes);
	wipeChunks(state.chunks);
	return output;
}

function emptyCommandResult(
	status: Exclude<KeyctlCommandStatus, "completed">,
	reason?: KeyctlCommandResult["reason"],
): KeyctlCommandResult {
	return {
		status,
		stdout: new Uint8Array(),
		stderr: new Uint8Array(),
		...(reason === undefined ? {} : { reason }),
	};
}

/** `spawn` 只接收固定绝对路径、argv 与空环境，不经过 shell。 */
export class NodeKeyctlCommandPort implements KeyctlCommandPort {
	readonly #platform: NodeJS.Platform;

	public constructor(platform: NodeJS.Platform = process.platform) {
		this.#platform = platform;
	}

	public run(request: KeyctlCommandRequest): Promise<KeyctlCommandResult> {
		if (this.#platform !== "linux") {
			return Promise.resolve(emptyCommandResult("unavailable", "unsupported_platform"));
		}
		if (
			request.program !== KEYCTL_PROGRAM ||
			!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 ||
			!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0 ||
			request.arguments.some((argument) => argument.includes("\0"))
		) {
			return Promise.resolve(emptyCommandResult("unavailable", "process_error"));
		}

		return new Promise((resolveResult) => {
			let child;
			try {
				child = spawn(KEYCTL_PROGRAM, [...request.arguments], {
					env: {},
					shell: false,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
			} catch {
				resolveResult(emptyCommandResult("unavailable", "process_error"));
				return;
			}

			const stdout: BufferedCommandState = { chunks: [], bytes: 0 };
			const stderr: BufferedCommandState = { chunks: [], bytes: 0 };
			let inputCopy = request.stdin === undefined ? undefined : Buffer.from(request.stdin);
			let terminal = false;
			let timedOut = false;
			let outputLimit = false;
			let processError: KeyctlCommandResult["reason"] | undefined;

			const kill = () => {
				try {
					child.kill("SIGKILL");
				} catch {
					// close/error 会给出最终状态。
				}
			};
			const timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, request.timeoutMs);

			const onData = (state: BufferedCommandState, chunk: Buffer) => {
				if (terminal) {
					chunk.fill(0);
					return;
				}
				const remaining = request.maxOutputBytes - stdout.bytes - stderr.bytes;
				if (remaining <= 0 || !appendBounded(state, chunk, remaining)) {
					outputLimit = true;
					kill();
				}
			};
			child.stdout.on("data", (chunk: Buffer) => onData(stdout, chunk));
			child.stderr.on("data", (chunk: Buffer) => onData(stderr, chunk));
			child.stdin.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code !== "EPIPE") {
					processError = "process_error";
					kill();
				}
			});
			child.once("error", (error: NodeJS.ErrnoException) => {
				processError = error.code === "ENOENT" ? "program_not_found" : "process_error";
				kill();
			});
			child.once("close", (code) => {
				if (terminal) return;
				terminal = true;
				clearTimeout(timer);
				wipe(inputCopy);
				inputCopy = undefined;
				if (outputLimit || timedOut || processError !== undefined) {
					wipeChunks(stdout.chunks);
					wipeChunks(stderr.chunks);
					resolveResult(outputLimit
						? emptyCommandResult("output_limit")
						: timedOut
							? emptyCommandResult("timed_out")
							: emptyCommandResult("unavailable", processError));
					return;
				}
				resolveResult({
					status: "completed",
					exitCode: code ?? 1,
					stdout: assembled(stdout),
					stderr: assembled(stderr),
				});
			});

			if (inputCopy === undefined) {
				child.stdin.end();
			} else {
				const pendingInput = inputCopy;
				child.stdin.end(pendingInput, () => pendingInput.fill(0));
			}
		});
	}
}

function defaultLockDirectory(): string {
	if (process.platform !== "linux" || typeof process.getuid !== "function") {
		return "/run/user/0/runledger/keyring-locks";
	}
	return `/run/user/${process.getuid()}/runledger/keyring-locks`;
}

export interface LinuxKeyringMutationLockOptions {
	rootDirectory?: string;
	timeoutMs?: number;
	retryDelayMs?: number;
	staleMs?: number;
}

/** proper-lockfile 使用目录锁与 stale heartbeat，覆盖多个 RunLedger 进程。 */
export class LinuxKeyringMutationLock implements KeyringMutationLockPort {
	readonly #rootDirectory: string;
	readonly #timeoutMs: number;
	readonly #retryDelayMs: number;
	readonly #staleMs: number;

	public constructor(options: LinuxKeyringMutationLockOptions = {}) {
		const rootDirectory = options.rootDirectory ?? defaultLockDirectory();
		if (!isAbsolute(rootDirectory) || resolve(rootDirectory) !== rootDirectory || rootDirectory.includes("\0")) {
			throw new TypeError("keyring lock directory must be an exact absolute path");
		}
		this.#rootDirectory = rootDirectory;
		this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "keyring lock timeout");
		this.#retryDelayMs = positiveInteger(options.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS, "keyring lock retry delay");
		this.#staleMs = positiveInteger(options.staleMs ?? DEFAULT_LOCK_STALE_MS, "keyring lock stale interval");
	}

	async #prepareRoot(): Promise<void> {
		await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
		let stats = await lstat(this.#rootDirectory);
		if (
			!stats.isDirectory() || stats.isSymbolicLink() ||
			resolve(await realpath(this.#rootDirectory)) !== this.#rootDirectory
		) {
			throw new Error("keyring lock root is not a canonical directory");
		}
		if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
			throw new Error("keyring lock root has a different owner");
		}
		if ((stats.mode & 0o077) !== 0) {
			await chmod(this.#rootDirectory, 0o700);
			stats = await lstat(this.#rootDirectory);
			if ((stats.mode & 0o077) !== 0) throw new Error("keyring lock root permissions are too broad");
		}
	}

	public async withLock<T>(identity: string, operation: () => Promise<T>): Promise<T> {
		if (!identity || identity.includes("\0")) throw new TypeError("keyring lock identity is invalid");
		await this.#prepareRoot();
		const digest = createHash("sha256").update(identity, "utf8").digest("hex");
		const target = join(this.#rootDirectory, digest);
		const retries = Math.max(0, Math.ceil(this.#timeoutMs / this.#retryDelayMs) - 1);
		const release = await lockfile.lock(target, {
			realpath: false,
			lockfilePath: `${target}.lock`,
			stale: Math.max(2_000, this.#staleMs),
			update: Math.max(1_000, Math.floor(Math.max(2_000, this.#staleMs) / 2)),
			retries: {
				retries,
				factor: 1,
				minTimeout: this.#retryDelayMs,
				maxTimeout: this.#retryDelayMs,
				randomize: false,
			},
		});
		try {
			return await operation();
		} finally {
			await release();
		}
	}
}

interface KeyInventory {
	ringId: string;
	versionIds: Map<string, string>;
	activeKeyId?: string;
	activeVersion?: string;
	activeCorrupt: boolean;
}

type InventoryResult =
	| { status: "available"; inventory: KeyInventory }
	| { status: "missing" }
	| { status: "unavailable"; reason: LinuxKeyringUnavailableReason };

type SearchResult =
	| { status: "found"; id: string }
	| { status: "missing" }
	| { status: "unavailable"; reason: LinuxKeyringUnavailableReason };

type AddVersionResult =
	| { status: "created" }
	| { status: "conflict" }
	| { status: "unavailable"; reason: LinuxKeyringUnavailableReason };

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
	return value;
}

function commandReason(result: KeyctlCommandResult): LinuxKeyringUnavailableReason | undefined {
	if (result.status === "completed") return undefined;
	if (result.status === "timed_out") return "command_timed_out";
	if (result.status === "output_limit") return "command_output_limit";
	if (result.reason === "unsupported_platform") return "unsupported_platform";
	return "command_unavailable";
}

function decodeText(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

function isMissingKeyFailure(result: KeyctlCommandResult): boolean {
	if (result.status !== "completed" || result.exitCode === 0) return false;
	const message = decodeText(result.stderr).toLowerCase();
	return message.includes("requested key not available") ||
		message.includes("required key not available") ||
		message.includes("key has been revoked") ||
		message.includes("key has expired") ||
		message.includes("no such key");
}

function parseSerial(bytes: Uint8Array): string | undefined {
	const value = decodeText(bytes).trim();
	return SERIAL_PATTERN.test(value) ? value : undefined;
}

function wipeResult(result: KeyctlCommandResult): void {
	wipe(result.stdout);
	wipe(result.stderr);
}

function compareBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function validateVersion(version: string): boolean {
	return VERSION_PATTERN.test(version);
}

/**
 * 每个 namespace/purpose 使用一个独立 user keyring。
 * `key:<version>` payload 永不更新；rotation 只更新非秘密 active 指针。
 */
export class LinuxKernelKeyringPort implements OsKeyringPort {
	readonly backend = "os_keyring" as const;
	readonly #namespace: string;
	readonly #purpose: ArtifactKeyPurpose;
	readonly #command: KeyctlCommandPort;
	readonly #mutationLock: KeyringMutationLockPort;
	readonly #timeoutMs: number;
	readonly #maxOutputBytes: number;
	readonly #maxKeys: number;
	readonly #platform: NodeJS.Platform;
	readonly #randomBytes: (size: number) => Uint8Array;
	readonly #clock: () => number;
	readonly #ringDescription: string;
	readonly #activeDescription: string;
	readonly #versionPrefix: string;

	public constructor(options: LinuxKernelKeyringOptions) {
		if (!NAMESPACE_PATTERN.test(options.namespace)) {
			throw new TypeError("keyring namespace must use 1-64 alphanumeric, dot, underscore, or dash characters");
		}
		if (!PURPOSES.has(options.purpose)) throw new TypeError("artifact key purpose is invalid");
		this.#namespace = options.namespace;
		this.#purpose = options.purpose;
		this.#platform = options.platform ?? process.platform;
		this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "keyctl timeout");
		this.#maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "keyctl output bound");
		this.#maxKeys = positiveInteger(options.maxKeys ?? DEFAULT_MAX_KEYS, "keyring inventory bound");
		this.#command = options.command ?? new NodeKeyctlCommandPort(this.#platform);
		this.#mutationLock = options.mutationLock ?? new LinuxKeyringMutationLock({
			...(options.lockDirectory === undefined ? {} : { rootDirectory: options.lockDirectory }),
			timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
			retryDelayMs: options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
			staleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
		});
		this.#randomBytes = options.randomBytes ?? ((size) => nodeRandomBytes(size));
		this.#clock = options.clock ?? Date.now;
		this.#ringDescription = `runledger:v1:${this.#namespace}:artifact:${this.#purpose}`;
		this.#activeDescription = `${this.#ringDescription}:active`;
		this.#versionPrefix = `${this.#ringDescription}:key:`;
	}

	public get namespace(): string {
		return this.#namespace;
	}

	public get purpose(): ArtifactKeyPurpose {
		return this.#purpose;
	}

	#request(arguments_: readonly string[], stdin?: Uint8Array): Promise<KeyctlCommandResult> {
		return this.#command.run({
			program: KEYCTL_PROGRAM,
			arguments: arguments_,
			...(stdin === undefined ? {} : { stdin }),
			timeoutMs: this.#timeoutMs,
			maxOutputBytes: this.#maxOutputBytes,
		});
	}

	async #search(keyring: string, type: string, description: string): Promise<SearchResult> {
		const result = await this.#request(["search", keyring, type, description]);
		try {
			const unavailable = commandReason(result);
			if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
			if (result.exitCode !== 0) {
				return isMissingKeyFailure(result)
					? { status: "missing" }
					: { status: "unavailable", reason: "command_failed" };
			}
			const id = parseSerial(result.stdout);
			return id === undefined
				? { status: "unavailable", reason: "invalid_inventory" }
				: { status: "found", id };
		} finally {
			wipeResult(result);
		}
	}

	async #readPayload(id: string): Promise<
		| { status: "available"; payload: Uint8Array }
		| { status: "missing" }
		| { status: "unavailable"; reason: LinuxKeyringUnavailableReason }
	> {
		const result = await this.#request(["pipe", id]);
		try {
			const unavailable = commandReason(result);
			if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
			if (result.exitCode !== 0) {
				return isMissingKeyFailure(result)
					? { status: "missing" }
					: { status: "unavailable", reason: "command_failed" };
			}
			return { status: "available", payload: Uint8Array.from(result.stdout) };
		} finally {
			wipeResult(result);
		}
	}

	async #inventory(): Promise<InventoryResult> {
		if (this.#platform !== "linux") return { status: "unavailable", reason: "unsupported_platform" };
		const ring = await this.#search(ROOT_KEYRING, KEYRING_TYPE, this.#ringDescription);
		if (ring.status !== "found") return ring;

		const listed = await this.#request(["rlist", ring.id]);
		let ids: string[];
		try {
			const unavailable = commandReason(listed);
			if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
			if (listed.exitCode !== 0) {
				return isMissingKeyFailure(listed)
					? { status: "missing" }
					: { status: "unavailable", reason: "command_failed" };
			}
			const raw = decodeText(listed.stdout).trim();
			ids = raw === "" ? [] : raw.split(/\s+/u);
			if (ids.length > this.#maxKeys) return { status: "unavailable", reason: "inventory_limit" };
			if (ids.some((id) => !SERIAL_PATTERN.test(id))) {
				return { status: "unavailable", reason: "invalid_inventory" };
			}
		} finally {
			wipeResult(listed);
		}

		const versionIds = new Map<string, string>();
		let activeKeyId: string | undefined;
		for (const id of ids) {
			const described = await this.#request(["rdescribe", id]);
			try {
				const unavailable = commandReason(described);
				if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
				if (described.exitCode !== 0) {
					if (isMissingKeyFailure(described)) continue;
					return { status: "unavailable", reason: "command_failed" };
				}
				const fields = decodeText(described.stdout).trim().split(";");
				if (fields.length !== 5) return { status: "unavailable", reason: "invalid_inventory" };
				const [type, , , , description] = fields;
				if (type !== KEY_TYPE || description === undefined) continue;
				if (description === this.#activeDescription) {
					if (activeKeyId !== undefined) return { status: "unavailable", reason: "invalid_inventory" };
					activeKeyId = id;
					continue;
				}
				if (!description.startsWith(this.#versionPrefix)) continue;
				const version = description.slice(this.#versionPrefix.length);
				if (!validateVersion(version) || versionIds.has(version)) {
					return { status: "unavailable", reason: "invalid_inventory" };
				}
				versionIds.set(version, id);
			} finally {
				wipeResult(described);
			}
		}

		let activeVersion: string | undefined;
		let activeCorrupt = false;
		if (activeKeyId !== undefined) {
			const active = await this.#readPayload(activeKeyId);
			if (active.status === "unavailable") return active;
			if (active.status === "missing") {
				activeKeyId = undefined;
				activeCorrupt = true;
			} else {
				try {
					const decoded = decodeText(active.payload);
					if (validateVersion(decoded)) activeVersion = decoded;
					else activeCorrupt = true;
				} finally {
					wipe(active.payload);
				}
			}
		}

		return {
			status: "available",
			inventory: { ringId: ring.id, versionIds, activeKeyId, activeVersion, activeCorrupt },
		};
	}

	#listFromInventory(inventory: KeyInventory): LinuxKeyringListResult {
		const availableVersions = [...inventory.versionIds.keys()].sort();
		if (
			!inventory.activeCorrupt && inventory.activeVersion !== undefined &&
			inventory.versionIds.has(inventory.activeVersion)
		) {
			return { status: "available", activeVersion: inventory.activeVersion, availableVersions };
		}
		return {
			status: "lost",
			...(inventory.activeVersion === undefined ? {} : { activeVersion: inventory.activeVersion }),
			availableVersions,
		};
	}

	public async listVersions(): Promise<LinuxKeyringListResult> {
		try {
			const result = await this.#inventory();
			if (result.status === "unavailable") {
				return { status: "unavailable", availableVersions: [], reason: result.reason };
			}
			if (result.status === "missing") return { status: "lost", availableVersions: [] };
			return this.#listFromInventory(result.inventory);
		} catch {
			return { status: "unavailable", availableVersions: [], reason: "command_unavailable" };
		}
	}

	public async status(): Promise<ArtifactKeyProviderStatus> {
		const listed = await this.listVersions();
		if (listed.status === "unavailable") {
			return { state: "unavailable", availableVersions: [], backend: "unavailable" };
		}
		return {
			state: listed.status,
			...(listed.activeVersion === undefined ? {} : { activeVersion: listed.activeVersion }),
			availableVersions: listed.availableVersions,
			backend: "os_keyring",
		};
	}

	public async readArtifactKey(version?: string): Promise<OsKeyringReadResult> {
		if (version !== undefined && !validateVersion(version)) return { status: "unavailable" };
		try {
			const result = await this.#inventory();
			if (result.status === "unavailable") return { status: "unavailable" };
			if (result.status === "missing") return { status: "lost", availableVersions: [] };
			const inventory = result.inventory;
			const availableVersions = [...inventory.versionIds.keys()].sort();
			const selected = version ?? inventory.activeVersion;
			if (selected === undefined) {
				return {
					status: "lost",
					...(inventory.activeVersion === undefined ? {} : { activeVersion: inventory.activeVersion }),
					availableVersions,
				};
			}
			const id = inventory.versionIds.get(selected);
			if (id === undefined) {
				return {
					status: "lost",
					...(inventory.activeVersion === undefined ? {} : { activeVersion: inventory.activeVersion }),
					availableVersions,
				};
			}
			const read = await this.#readPayload(id);
			if (read.status === "unavailable") return { status: "unavailable" };
			if (read.status === "missing") {
				return { status: "lost", activeVersion: inventory.activeVersion, availableVersions };
			}
			if (read.payload.byteLength !== 32) {
				wipe(read.payload);
				return { status: "lost", activeVersion: inventory.activeVersion, availableVersions };
			}
			return { status: "available", version: selected, key: read.payload };
		} catch {
			return { status: "unavailable" };
		}
	}

	#generatedVersion(): string {
		const entropy = this.#randomBytes(8);
		try {
			if (entropy.byteLength !== 8) throw new Error("version entropy source returned an invalid length");
			const timestamp = this.#clock();
			if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("keyring clock returned an invalid value");
			const suffix = Buffer.from(entropy.buffer, entropy.byteOffset, entropy.byteLength).toString("hex");
			return `v1-${timestamp.toString(36)}-${suffix}`;
		} finally {
			wipe(entropy);
		}
	}

	async #createRing(): Promise<InventoryResult> {
		const created = await this.#request(["newring", this.#ringDescription, ROOT_KEYRING]);
		try {
			const unavailable = commandReason(created);
			if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
			if (created.exitCode !== 0) return { status: "unavailable", reason: "command_failed" };
			const ringId = parseSerial(created.stdout);
			if (ringId === undefined) return { status: "unavailable", reason: "invalid_inventory" };
			return {
				status: "available",
				inventory: {
					ringId,
					versionIds: new Map(),
					activeCorrupt: false,
				},
			};
		} finally {
			wipeResult(created);
		}
	}

	async #addVersion(inventory: KeyInventory, version: string): Promise<AddVersionResult> {
		const description = `${this.#versionPrefix}${version}`;
		const existing = await this.#search(inventory.ringId, KEY_TYPE, description);
		if (existing.status === "found") return { status: "conflict" };
		if (existing.status === "unavailable") return existing;

		const key = this.#randomBytes(32);
		if (key.byteLength !== 32) {
			wipe(key);
			return { status: "unavailable", reason: "invalid_key_payload" };
		}
		try {
			const added = await this.#request(["padd", KEY_TYPE, description, inventory.ringId], key);
			let keyId: string | undefined;
			try {
				const unavailable = commandReason(added);
				if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
				if (added.exitCode !== 0) return { status: "unavailable", reason: "command_failed" };
				keyId = parseSerial(added.stdout);
				if (keyId === undefined) return { status: "unavailable", reason: "mutation_uncertain" };
			} finally {
				wipeResult(added);
			}

			const verified = await this.#readPayload(keyId);
			if (verified.status !== "available") {
				return {
					status: "unavailable",
					reason: verified.status === "unavailable" ? verified.reason : "mutation_uncertain",
				};
			}
			try {
				if (!compareBytes(key, verified.payload)) {
					return { status: "unavailable", reason: "mutation_uncertain" };
				}
			} finally {
				wipe(verified.payload);
			}
			return { status: "created" };
		} finally {
			wipe(key);
		}
	}

	async #activate(inventory: KeyInventory, version: string): Promise<LinuxKeyringUnavailableReason | undefined> {
		const payload = new TextEncoder().encode(version);
		try {
			const command = inventory.activeKeyId === undefined
				? ["padd", KEY_TYPE, this.#activeDescription, inventory.ringId]
				: ["pupdate", inventory.activeKeyId];
			const updated = await this.#request(command, payload);
			let activeId = inventory.activeKeyId;
			try {
				const unavailable = commandReason(updated);
				if (unavailable !== undefined) return unavailable;
				if (updated.exitCode !== 0) return "command_failed";
				if (activeId === undefined) activeId = parseSerial(updated.stdout);
				if (activeId === undefined) return "mutation_uncertain";
			} finally {
				wipeResult(updated);
			}
			const verified = await this.#readPayload(activeId);
			if (verified.status !== "available") {
				return verified.status === "unavailable" ? verified.reason : "mutation_uncertain";
			}
			try {
				return compareBytes(payload, verified.payload) ? undefined : "mutation_uncertain";
			} finally {
				wipe(verified.payload);
			}
		} finally {
			wipe(payload);
		}
	}

	async #chooseGeneratedVersion(existing: ReadonlyMap<string, string>): Promise<string | undefined> {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const version = this.#generatedVersion();
			if (!existing.has(version)) return version;
		}
		return undefined;
	}

	public async ensureProvisioned(request: LinuxKeyringEnsureRequest = {}): Promise<LinuxKeyringProvisionResult> {
		if (request.version !== undefined && !validateVersion(request.version)) {
			return { status: "unavailable", reason: "invalid_inventory" };
		}
		if (this.#platform !== "linux") return { status: "unavailable", reason: "unsupported_platform" };
		try {
			return await this.#mutationLock.withLock(this.#ringDescription, async () => {
				let inspected = await this.#inventory();
				if (inspected.status === "unavailable") return inspected;
				if (inspected.status === "missing") inspected = await this.#createRing();
				if (inspected.status !== "available") {
					return inspected.status === "missing"
						? { status: "lost", availableVersions: [] }
						: inspected;
				}
				const inventory = inspected.inventory;
				const listed = this.#listFromInventory(inventory);
				if (listed.status === "available") {
					return {
						status: "available",
						version: listed.activeVersion,
						created: false,
						availableVersions: listed.availableVersions,
					};
				}
				if (inventory.versionIds.size > 0 || inventory.activeKeyId !== undefined || inventory.activeCorrupt) {
					return listed;
				}

				const version = request.version ?? await this.#chooseGeneratedVersion(inventory.versionIds);
				if (version === undefined) return { status: "unavailable", reason: "mutation_uncertain" };
				const added = await this.#addVersion(inventory, version);
				if (added.status === "unavailable") return added;
				if (added.status === "conflict") return { status: "unavailable", reason: "mutation_uncertain" };
				const activationError = await this.#activate(inventory, version);
				if (activationError !== undefined) return { status: "unavailable", reason: activationError };
				const verified = await this.#inventory();
				if (verified.status !== "available") {
					return verified.status === "unavailable"
						? verified
						: { status: "unavailable", reason: "mutation_uncertain" };
				}
				const after = this.#listFromInventory(verified.inventory);
				if (after.status !== "available" || after.activeVersion !== version) {
					return { status: "unavailable", reason: "mutation_uncertain" };
				}
				return { status: "available", version, created: true, availableVersions: after.availableVersions };
			});
		} catch {
			return { status: "unavailable", reason: "lock_unavailable" };
		}
	}

	public async rotateArtifactKey(request: LinuxKeyringRotationRequest = {}): Promise<LinuxKeyringRotationResult> {
		if (request.version !== undefined && !validateVersion(request.version)) {
			return { status: "unavailable", reason: "invalid_inventory" };
		}
		if (this.#platform !== "linux") return { status: "unavailable", reason: "unsupported_platform" };
		try {
			return await this.#mutationLock.withLock(this.#ringDescription, async () => {
				const inspected = await this.#inventory();
				if (inspected.status === "unavailable") return inspected;
				if (inspected.status === "missing") return { status: "lost", availableVersions: [] };
				const inventory = inspected.inventory;
				const availableVersions = [...inventory.versionIds.keys()].sort();
				if (inventory.versionIds.size === 0 && inventory.activeKeyId === undefined && !inventory.activeCorrupt) {
					return { status: "lost", availableVersions };
				}
				if (request.version !== undefined && inventory.versionIds.has(request.version)) {
					return {
						status: "conflict",
						version: request.version,
						...(inventory.activeVersion === undefined ? {} : { activeVersion: inventory.activeVersion }),
						availableVersions,
					};
				}
				const version = request.version ?? await this.#chooseGeneratedVersion(inventory.versionIds);
				if (version === undefined) return { status: "unavailable", reason: "mutation_uncertain" };
				const added = await this.#addVersion(inventory, version);
				if (added.status === "unavailable") return added;
				if (added.status === "conflict") {
					return {
						status: "conflict",
						version,
						...(inventory.activeVersion === undefined ? {} : { activeVersion: inventory.activeVersion }),
						availableVersions,
					};
				}
				const activationError = await this.#activate(inventory, version);
				if (activationError !== undefined) return { status: "unavailable", reason: activationError };
				const verified = await this.#inventory();
				if (verified.status !== "available") {
					return verified.status === "unavailable"
						? verified
						: { status: "unavailable", reason: "mutation_uncertain" };
				}
				const after = this.#listFromInventory(verified.inventory);
				if (after.status !== "available" || after.activeVersion !== version) {
					return { status: "unavailable", reason: "mutation_uncertain" };
				}
				return {
					status: "rotated",
					version,
					...(inventory.activeVersion === undefined ? {} : { previousVersion: inventory.activeVersion }),
					availableVersions: after.availableVersions,
				};
			});
		} catch {
			return { status: "unavailable", reason: "lock_unavailable" };
		}
	}
}

/** 只构造读端口；不会创建 keyring、active pointer 或 key bytes。 */
export function createLinuxKernelKeyringPort(options: LinuxKernelKeyringOptions): LinuxKernelKeyringPort {
	return new LinuxKernelKeyringPort(options);
}

/** 唯一默认 provisioning 入口；调用名显式表达它可能创建 32-byte key。 */
export async function ensureLinuxKernelKeyringPort(
	options: LinuxKernelKeyringOptions,
	request: LinuxKeyringEnsureRequest = {},
): Promise<EnsuredLinuxKernelKeyringPort> {
	const port = createLinuxKernelKeyringPort(options);
	return { port, result: await port.ensureProvisioned(request) };
}
