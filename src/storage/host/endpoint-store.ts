/** Canonical user-home Host endpoint metadata store. */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";
import { hostEndpointRelativeLocator } from "../../runtime/contracts/storage-layout.ts";
import { RuntimeDigestSchema, RuntimeIdSchema } from "../../runtime/protocol/foundation-schemas.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { RUNTIME_HOST_BOUNDS } from "../../runtime/host/types.ts";

export interface HostEndpointRecord {
	readonly protocolVersion: 1;
	readonly workspaceStorageKey: string;
	readonly hostRuntimeId: string;
	readonly hostGeneration: number;
	readonly state: "starting" | "ready" | "draining";
	readonly compatibilityDigest: RuntimeDigest;
}

export const HostEndpointRecordSchema = Type.Object(
	{
		protocolVersion: Type.Literal(1),
		workspaceStorageKey: Type.String({ pattern: "^ws-[a-f0-9]{64}$", minLength: 67, maxLength: 67 }),
		hostRuntimeId: RuntimeIdSchema,
		hostGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		state: Type.Union([Type.Literal("starting"), Type.Literal("ready"), Type.Literal("draining")]),
		compatibilityDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export type EndpointAdmissionInput = {
	readonly endpoint: "missing" | "ready" | "stale";
	readonly transport: "reachable" | "unreachable";
	readonly writer: "active" | "absent" | "unknown";
	readonly compatibility: "match" | "conflict" | "unknown";
};

export type EndpointAdmissionDecision =
	| { readonly decision: "spawn" }
	| { readonly decision: "connect" }
	| { readonly decision: "spawn_after_stale_cleanup" }
	| { readonly decision: "conflict"; readonly code: "active_writer_unreachable" | "host_configuration_conflict" }
	| { readonly decision: "unsupported"; readonly code: "peer_attestation_required" };

export function decideEndpointAdmission(input: EndpointAdmissionInput): EndpointAdmissionDecision {
	if (input.endpoint === "missing") return { decision: "spawn" };
	if (input.compatibility === "conflict") return { decision: "conflict", code: "host_configuration_conflict" };
	if (input.writer === "active" && input.transport === "unreachable") {
		return { decision: "conflict", code: "active_writer_unreachable" };
	}
	if (input.endpoint === "stale" && input.writer === "absent") return { decision: "spawn_after_stale_cleanup" };
	if (input.transport === "reachable" && input.compatibility === "match") return { decision: "connect" };
	return { decision: "unsupported", code: "peer_attestation_required" };
}

export class EndpointStore {
	private readonly endpointFile: string;
	private readonly layout: RunledgerLayout;
	private readonly workspaceStorageKey: string;

	public constructor(layout: RunledgerLayout, workspaceStorageKey: string) {
		this.layout = layout;
		this.workspaceStorageKey = workspaceStorageKey;
		this.endpointFile = join(layout.home, hostEndpointRelativeLocator(workspaceStorageKey));
	}

	public endpointPath(): string {
		return this.endpointFile;
	}

	public async publish(record: HostEndpointRecord): Promise<void> {
		if (!Value.Check(HostEndpointRecordSchema, record)) throw new Error("invalid Host endpoint record");
		if (record.workspaceStorageKey !== this.workspaceStorageKey) throw new Error("endpoint scope mismatch");
		const parent = dirname(this.endpointFile);
		await ensureContainedDirectoryChain(this.layout.home, parent);
		try {
			const existing = await lstat(this.endpointFile);
			if (existing.isSymbolicLink()) throw new Error("endpoint symlink is not allowed");
		} catch (error) {
			if (isNotFound(error)) {
				// The endpoint is being created for the first time.
			} else {
				throw error;
			}
		}
		const staging = join(this.layout.tmp, `host-endpoint-${randomUUID()}.tmp`);
		await ensureContainedDirectoryChain(this.layout.home, this.layout.tmp);
		try {
			const encoded = JSON.stringify(record);
			if (Buffer.byteLength(encoded, "utf8") > RUNTIME_HOST_BOUNDS.maxFrameBytes) {
				throw new Error("endpoint record exceeds frame bound");
			}
			await writeFile(staging, `${encoded}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			const handle = await open(staging, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
			// 缩短祖先目录被替换后的竞态窗口；Node 没有跨平台 openat/renameat。
			await ensureContainedDirectoryChain(this.layout.home, parent);
			await ensureContainedDirectoryChain(this.layout.home, this.layout.tmp);
			await rename(staging, this.endpointFile);
		} finally {
			await unlink(staging).catch(() => undefined);
		}
	}

	public async read(): Promise<HostEndpointRecord | undefined> {
		let info;
		try {
			info = await lstat(this.endpointFile);
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
		if (info.isSymbolicLink()) throw new Error("endpoint symlink is not allowed");
		const content = await readFile(this.endpointFile, "utf8");
		if (Buffer.byteLength(content, "utf8") > RUNTIME_HOST_BOUNDS.maxFrameBytes) throw new Error("endpoint record exceeds frame bound");
		let parsed: unknown;
		try {
			parsed = JSON.parse(content) as unknown;
		} catch {
			throw new Error("endpoint record is not valid JSON");
		}
		if (!Value.Check(HostEndpointRecordSchema, parsed)) throw new Error("endpoint record has invalid current-format shape");
		if (parsed.workspaceStorageKey !== this.workspaceStorageKey) throw new Error("endpoint scope mismatch");
		return parsed as unknown as HostEndpointRecord;
	}

	public async remove(): Promise<void> {
		await unlink(this.endpointFile).catch((error: unknown) => {
			if (!isNotFound(error)) throw error;
		});
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function ensureContainedDirectoryChain(home: string, target: string): Promise<void> {
	const resolvedHome = resolve(home);
	const resolvedTarget = resolve(target);
	const targetRelative = relative(resolvedHome, resolvedTarget);
	if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
		throw new Error("endpoint directory containment violation");
	}
	await mkdir(resolvedHome, { recursive: true, mode: 0o700 });
	await assertSafeDirectory(resolvedHome, resolvedHome);
	let current = resolvedHome;
	for (const segment of targetRelative.split(sep).filter((value) => value.length > 0)) {
		current = join(current, segment);
		try {
			await mkdir(current, { mode: 0o700 });
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
		}
		await assertSafeDirectory(resolvedHome, current);
	}
}

async function assertSafeDirectory(home: string, candidate: string): Promise<void> {
	const info = await lstat(candidate);
	if (info.isSymbolicLink()) throw new Error("endpoint ancestor symlink is not allowed");
	if (!info.isDirectory()) throw new Error("endpoint ancestor must be a directory");
	const canonicalHome = await realpath(home);
	const canonicalCandidate = await realpath(candidate);
	const candidateRelative = relative(canonicalHome, canonicalCandidate);
	if (candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative)) {
		throw new Error("endpoint directory containment violation");
	}
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
