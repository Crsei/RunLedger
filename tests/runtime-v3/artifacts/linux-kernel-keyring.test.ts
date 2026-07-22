import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	OsKeyringArtifactKeyProvider,
	type ArtifactKeyProviderStatus,
	type OsKeyringPort,
	type OsKeyringReadResult,
} from "../../../src/runtime/artifacts/key-provider.ts";
import {
	KEYCTL_PROGRAM,
	LinuxKernelKeyringPort,
	LinuxKeyringMutationLock,
	NodeKeyctlCommandPort,
	type KeyctlCommandPort,
	type KeyctlCommandRequest,
	type KeyctlCommandResult,
	type KeyringMutationLockPort,
} from "../../../src/runtime/artifacts/integration/linux-kernel-keyring.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FakeRing {
	id: string;
	description: string;
	children: string[];
}

interface FakeKey {
	id: string;
	type: string;
	description: string;
	payload: Uint8Array;
	ringId: string;
}

interface RecordedInvocation {
	program: string;
	arguments: readonly string[];
	stdinBytes: number;
}

function encoded(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function allZero(value: Uint8Array): boolean {
	return value.every((byte) => byte === 0);
}

class ImmediateMutationLock implements KeyringMutationLockPort {
	public readonly identities: string[] = [];

	public async withLock<T>(identity: string, operation: () => Promise<T>): Promise<T> {
		this.identities.push(identity);
		return operation();
	}
}

/** 只模拟 keyctl 的 argv/stdin 协议；不会把 stdin 写入调用记录或错误。 */
class MemoryKeyctlCommand implements KeyctlCommandPort {
	public readonly invocations: RecordedInvocation[] = [];
	public readonly inputReferences: Uint8Array[] = [];
	public readonly outputReferences: Uint8Array[] = [];
	public failNextVerb?: string;
	public failureMarker = "";
	readonly #rings = new Map<string, FakeRing>();
	readonly #keys = new Map<string, FakeKey>();
	#nextId = 100;

	#serial(): string {
		const value = String(this.#nextId);
		this.#nextId += 1;
		return value;
	}

	#completed(exitCode: number, stdout: Uint8Array | string = "", stderr: Uint8Array | string = ""): KeyctlCommandResult {
		const stdoutBytes = typeof stdout === "string" ? encoded(stdout) : Uint8Array.from(stdout);
		const stderrBytes = typeof stderr === "string" ? encoded(stderr) : Uint8Array.from(stderr);
		this.outputReferences.push(stdoutBytes, stderrBytes);
		return { status: "completed", exitCode, stdout: stdoutBytes, stderr: stderrBytes };
	}

	#missing(): KeyctlCommandResult {
		return this.#completed(1, "", "Required key not available");
	}

	public async run(request: KeyctlCommandRequest): Promise<KeyctlCommandResult> {
		this.invocations.push({
			program: request.program,
			arguments: [...request.arguments],
			stdinBytes: request.stdin?.byteLength ?? 0,
		});
		if (request.stdin !== undefined) this.inputReferences.push(request.stdin);

		const [verb, ...arguments_] = request.arguments;
		if (verb === this.failNextVerb) {
			this.failNextVerb = undefined;
			return this.#completed(1, "", this.failureMarker);
		}
		if (verb === "search") {
			const [ringId, type, description] = arguments_;
			if (ringId === "@u" && type === "keyring") {
				const ring = [...this.#rings.values()].find((candidate) => candidate.description === description);
				return ring === undefined ? this.#missing() : this.#completed(0, `${ring.id}\n`);
			}
			const ring = ringId === undefined ? undefined : this.#rings.get(ringId);
			if (ring === undefined) return this.#missing();
			const key = ring.children
				.map((id) => this.#keys.get(id))
				.find((candidate) => candidate?.type === type && candidate.description === description);
			return key === undefined ? this.#missing() : this.#completed(0, `${key.id}\n`);
		}
		if (verb === "newring") {
			const [description, parent] = arguments_;
			if (description === undefined || parent !== "@u") return this.#completed(1);
			const id = this.#serial();
			this.#rings.set(id, { id, description, children: [] });
			return this.#completed(0, `${id}\n`);
		}
		if (verb === "rlist") {
			const ring = arguments_[0] === undefined ? undefined : this.#rings.get(arguments_[0]);
			return ring === undefined ? this.#missing() : this.#completed(0, `${ring.children.join(" ")}\n`);
		}
		if (verb === "rdescribe") {
			const key = arguments_[0] === undefined ? undefined : this.#keys.get(arguments_[0]);
			return key === undefined
				? this.#missing()
				: this.#completed(0, `${key.type};1000;1000;3f3f0000;${key.description}\n`);
		}
		if (verb === "pipe") {
			const key = arguments_[0] === undefined ? undefined : this.#keys.get(arguments_[0]);
			return key === undefined ? this.#missing() : this.#completed(0, key.payload);
		}
		if (verb === "padd") {
			const [type, description, ringId] = arguments_;
			const ring = ringId === undefined ? undefined : this.#rings.get(ringId);
			if (type === undefined || description === undefined || ring === undefined || request.stdin === undefined) {
				return this.#completed(1);
			}
			const id = this.#serial();
			this.#keys.set(id, {
				id,
				type,
				description,
				payload: Uint8Array.from(request.stdin),
				ringId: ring.id,
			});
			ring.children.push(id);
			return this.#completed(0, `${id}\n`);
		}
		if (verb === "pupdate") {
			const key = arguments_[0] === undefined ? undefined : this.#keys.get(arguments_[0]);
			if (key === undefined || request.stdin === undefined) return this.#completed(1);
			key.payload.fill(0);
			key.payload = Uint8Array.from(request.stdin);
			return this.#completed(0);
		}
		return this.#completed(1);
	}
}

function deterministicRandomBytes(): (size: number) => Uint8Array {
	let call = 0;
	return (size) => {
		call += 1;
		return Uint8Array.from({ length: size }, (_, index) => ((call * 37) + index) % 256);
	};
}

function keyring(command: MemoryKeyctlCommand, lock = new ImmediateMutationLock()): LinuxKernelKeyringPort {
	return new LinuxKernelKeyringPort({
		namespace: "verification",
		purpose: "source_receipt",
		command,
		mutationLock: lock,
		platform: "linux",
		randomBytes: deterministicRandomBytes(),
	});
}

describe("Linux kernel keyring Artifact adapter", () => {
	it("uses the fixed absolute keyctl path and reports unsupported platforms without probing", async () => {
		const command = new MemoryKeyctlCommand();
		const port = new LinuxKernelKeyringPort({
			namespace: "verification",
			purpose: "source_receipt",
			command,
			mutationLock: new ImmediateMutationLock(),
			platform: "darwin",
		});
		expect(await port.status()).toEqual({ state: "unavailable", availableVersions: [], backend: "unavailable" });
		expect(await port.ensureProvisioned({ version: "verification-v1" })).toEqual({
			status: "unavailable",
			reason: "unsupported_platform",
		});
		expect(await port.rotateArtifactKey({ version: "verification-v2" })).toEqual({
			status: "unavailable",
			reason: "unsupported_platform",
		});
		expect(command.invocations).toHaveLength(0);

		const processPort = new NodeKeyctlCommandPort("win32");
		expect(await processPort.run({
			program: KEYCTL_PROGRAM,
			arguments: ["show", "@u"],
			timeoutMs: 100,
			maxOutputBytes: 1024,
		})).toEqual({
			status: "unavailable",
			reason: "unsupported_platform",
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
		});
		expect(KEYCTL_PROGRAM).toBe("/bin/keyctl");
	});

	it("serializes mutations across a private metadata-only lock directory", async () => {
		const parent = await mkdtemp(join(tmpdir(), "runledger-keyring-lock-"));
		temporaryRoots.push(parent);
		const rootDirectory = join(parent, "locks");
		const lock = new LinuxKeyringMutationLock({
			rootDirectory,
			timeoutMs: 1_000,
			retryDelayMs: 10,
			staleMs: 2_000,
		});
		const order: string[] = [];
		let firstStartedResolve: () => void = () => undefined;
		let firstReleaseResolve: () => void = () => undefined;
		const firstStarted = new Promise<void>((resolve) => {
			firstStartedResolve = resolve;
		});
		const firstRelease = new Promise<void>((resolve) => {
			firstReleaseResolve = resolve;
		});
		const identity = "runledger:v1:verification:artifact:source_receipt";
		const first = lock.withLock(identity, async () => {
			order.push("first:start");
			firstStartedResolve();
			await firstRelease;
			order.push("first:end");
		});
		await firstStarted;
		const second = lock.withLock(identity, async () => {
			order.push("second:start");
			order.push("second:end");
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 40));
		expect(order).toEqual(["first:start"]);
		const heldEntries = await readdir(rootDirectory);
		expect(heldEntries).toHaveLength(1);
		expect(heldEntries[0]).toMatch(/^[0-9a-f]{64}\.lock$/u);
		expect(heldEntries[0]).not.toContain("verification");
		firstReleaseResolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
		expect(await readdir(rootDirectory)).toEqual([]);
		const stats = await lstat(rootDirectory);
		expect(stats.mode & 0o077).toBe(0);
	});

	it("provisions once, signs through ArtifactKeyProvider, and clears transient key buffers", async () => {
		const command = new MemoryKeyctlCommand();
		const lock = new ImmediateMutationLock();
		const port = keyring(command, lock);
		expect(await port.ensureProvisioned({ version: "verification-v1" })).toEqual({
			status: "available",
			version: "verification-v1",
			created: true,
			availableVersions: ["verification-v1"],
		});
		expect(await port.ensureProvisioned()).toEqual({
			status: "available",
			version: "verification-v1",
			created: false,
			availableVersions: ["verification-v1"],
		});
		expect(lock.identities).toEqual([
			"runledger:v1:verification:artifact:source_receipt",
			"runledger:v1:verification:artifact:source_receipt",
		]);
		expect(await port.status()).toEqual({
			state: "available",
			activeVersion: "verification-v1",
			availableVersions: ["verification-v1"],
			backend: "os_keyring",
		});

		let operationKey: Uint8Array | undefined;
		const provider = new OsKeyringArtifactKeyProvider(port);
		const signed = await provider.withKey({ purpose: "source_receipt" }, (descriptor) => {
			operationKey = descriptor.key;
			return createHash("sha256").update(descriptor.key).digest("hex");
		});
		expect(signed).toMatchObject({ ok: true, value: expect.stringMatching(/^[0-9a-f]{64}$/u) });
		expect(operationKey).toBeDefined();
		expect(operationKey === undefined ? false : allZero(operationKey)).toBe(true);
		expect(command.invocations.every((request) => request.program === KEYCTL_PROGRAM)).toBe(true);
		expect(command.invocations.some((request) => request.arguments[0] === "padd" && request.stdinBytes === 32)).toBe(true);
		expect(command.invocations.every((request) => !request.arguments.join("\0").includes("25262728"))).toBe(true);
		expect(command.inputReferences.every(allZero)).toBe(true);
		expect(command.outputReferences.every(allZero)).toBe(true);
	});

	it("rotates atomically while retaining explicitly versioned reads and rejecting reuse", async () => {
		const command = new MemoryKeyctlCommand();
		const port = keyring(command);
		expect(await port.ensureProvisioned({ version: "verification-v1" })).toMatchObject({ status: "available" });
		expect(await port.rotateArtifactKey({ version: "verification-v2" })).toEqual({
			status: "rotated",
			version: "verification-v2",
			previousVersion: "verification-v1",
			availableVersions: ["verification-v1", "verification-v2"],
		});
		expect(await port.listVersions()).toEqual({
			status: "available",
			activeVersion: "verification-v2",
			availableVersions: ["verification-v1", "verification-v2"],
		});

		const oldKey = await port.readArtifactKey("verification-v1");
		const activeKey = await port.readArtifactKey();
		expect(oldKey.status).toBe("available");
		expect(activeKey.status).toBe("available");
		if (oldKey.status === "available" && activeKey.status === "available") {
			expect(oldKey.version).toBe("verification-v1");
			expect(activeKey.version).toBe("verification-v2");
			expect(oldKey.key).not.toEqual(activeKey.key);
			oldKey.key.fill(0);
			activeKey.key.fill(0);
		}
		expect(await port.rotateArtifactKey({ version: "verification-v2" })).toEqual({
			status: "conflict",
			version: "verification-v2",
			activeVersion: "verification-v2",
			availableVersions: ["verification-v1", "verification-v2"],
		});
		expect(command.inputReferences.every(allZero)).toBe(true);
		expect(command.outputReferences.every(allZero)).toBe(true);
	});

	it("fails closed without returning keyctl stderr or retaining command buffers", async () => {
		const command = new MemoryKeyctlCommand();
		command.failNextVerb = "padd";
		command.failureMarker = "sensitive-kernel-diagnostic-marker";
		const result = await keyring(command).ensureProvisioned({ version: "verification-v1" });
		expect(result).toEqual({ status: "unavailable", reason: "command_failed" });
		expect(JSON.stringify(result)).not.toContain(command.failureMarker);
		expect(command.inputReferences.every(allZero)).toBe(true);
		expect(command.outputReferences.every(allZero)).toBe(true);
	});

	it("clears both the port-owned source key and the operation copy", async () => {
		const source = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
		const keyringPort: OsKeyringPort = {
			backend: "os_keyring",
			readArtifactKey: async (): Promise<OsKeyringReadResult> => ({
				status: "available",
				version: "verification-v1",
				key: source,
			}),
			status: async (): Promise<ArtifactKeyProviderStatus> => ({
				state: "available",
				activeVersion: "verification-v1",
				availableVersions: ["verification-v1"],
				backend: "os_keyring",
			}),
		};
		let operationKey: Uint8Array | undefined;
		const result = await new OsKeyringArtifactKeyProvider(keyringPort).withKey(
			{ purpose: "source_receipt" },
			(descriptor) => {
				operationKey = descriptor.key;
				return descriptor.version;
			},
		);
		expect(result).toEqual({ ok: true, value: "verification-v1" });
		expect(allZero(source)).toBe(true);
		expect(operationKey === undefined ? false : allZero(operationKey)).toBe(true);
	});

	it("sanitizes backend and key-operation exceptions before they cross the provider boundary", async () => {
		const marker = "sensitive-key-material-in-error";
		const status = async (): Promise<ArtifactKeyProviderStatus> => ({
			state: "available",
			activeVersion: "verification-v1",
			availableVersions: ["verification-v1"],
			backend: "os_keyring",
		});
		const throwingPort: OsKeyringPort = {
			backend: "os_keyring",
			readArtifactKey: async () => {
				throw new Error(marker);
			},
			status,
		};
		const readFailure = await new OsKeyringArtifactKeyProvider(throwingPort).withKey(
			{ purpose: "source_receipt" },
			() => "unreachable",
		);
		expect(readFailure).toEqual({
			ok: false,
			error: { code: "key_unavailable", message: "OS keyring read failed", retryable: true },
		});
		expect(JSON.stringify(readFailure)).not.toContain(marker);

		const source = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
		const operationPort: OsKeyringPort = {
			backend: "os_keyring",
			readArtifactKey: async () => ({ status: "available", version: "verification-v1", key: source }),
			status,
		};
		let operationKey: Uint8Array | undefined;
		const operationFailure = await new OsKeyringArtifactKeyProvider(operationPort).withKey(
			{ purpose: "source_receipt" },
			(descriptor) => {
				operationKey = descriptor.key;
				throw new Error(marker);
			},
		);
		expect(operationFailure).toEqual({
			ok: false,
			error: { code: "key_unavailable", message: "artifact key operation failed", retryable: false },
		});
		expect(JSON.stringify(operationFailure)).not.toContain(marker);
		expect(allZero(source)).toBe(true);
		expect(operationKey === undefined ? false : allZero(operationKey)).toBe(true);
	});
});
