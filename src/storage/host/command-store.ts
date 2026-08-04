/** Durable Host command intent/receipt boundary. */

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { RUNTIME_HOST_BOUNDS, type HostFrameEnvelope } from "../../runtime/host/types.ts";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";

export type HostCommandBeginResult =
	| { readonly status: "execute" }
	| { readonly status: "replay"; readonly response: HostFrameEnvelope }
	| { readonly status: "conflict" | "uncertain" | "capacity" };

export interface HostCommandStore {
	begin(principalId: string, commandId: string, requestDigest: string): Promise<HostCommandBeginResult>;
	complete(principalId: string, commandId: string, requestDigest: string, response: HostFrameEnvelope): Promise<void>;
}

interface HostCommandRecord {
	readonly version: 1;
	readonly principalId: string;
	readonly commandId: string;
	readonly requestDigest: string;
	readonly state: "intent" | "receipt";
	readonly response?: HostFrameEnvelope;
}

export interface JsonHostCommandStoreOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
}

/** One digest-addressed file per command keeps restart lookup bounded to one record. */
export class JsonHostCommandStore implements HostCommandStore {
	private readonly root: string;

	public constructor(options: JsonHostCommandStoreOptions) {
		this.root = join(options.layout.state, "hosts", options.workspaceStorageKey, "commands");
	}

	public async begin(principalId: string, commandId: string, requestDigest: string): Promise<HostCommandBeginResult> {
		const path = this.path(principalId, commandId);
		const intent: HostCommandRecord = { version: 1, principalId, commandId, requestDigest, state: "intent" };
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const staging = join(this.root, `.intent-${randomUUID()}.tmp`);
		try {
			await writeDurable(staging, intent);
			try {
				await link(staging, path);
				return { status: "execute" };
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
			}
		} finally {
			await unlink(staging).catch(() => undefined);
		}
		const prior = await this.read(path);
		if (prior.principalId !== principalId || prior.commandId !== commandId) throw new Error("Host command identity digest collision");
		if (prior.requestDigest !== requestDigest) return { status: "conflict" };
		if (prior.state === "intent") return { status: "uncertain" };
		if (prior.response === undefined) throw new Error("Host command receipt is missing its response");
		return { status: "replay", response: prior.response };
	}

	public async complete(
		principalId: string,
		commandId: string,
		requestDigest: string,
		response: HostFrameEnvelope,
	): Promise<void> {
		const path = this.path(principalId, commandId);
		const prior = await this.read(path);
		if (prior.principalId !== principalId || prior.commandId !== commandId || prior.requestDigest !== requestDigest || prior.state !== "intent") {
			throw new Error("Host command intent does not match receipt");
		}
		const receipt: HostCommandRecord = { ...prior, state: "receipt", response };
		const staging = join(this.root, `.receipt-${randomUUID()}.tmp`);
		try {
			await writeDurable(staging, receipt);
			await rename(staging, path);
		} finally {
			await unlink(staging).catch(() => undefined);
		}
	}

	private path(principalId: string, commandId: string): string {
		const identity = runtimeDigest({ principalId, commandId }).digest;
		return join(this.root, `${identity}.json`);
	}

	private async read(path: string): Promise<HostCommandRecord> {
		const content = await readFile(path, "utf8");
		if (Buffer.byteLength(content, "utf8") > RUNTIME_HOST_BOUNDS.maxFrameBytes) throw new Error("Host command record exceeds frame bound");
		let value: unknown;
		try {
			value = JSON.parse(content) as unknown;
		} catch {
			throw new Error("Host command record is invalid JSON");
		}
		if (!isCommandRecord(value)) throw new Error("Host command record has invalid current-format shape");
		return value;
	}
}

/** Test/in-process fallback is bounded and fails closed instead of evicting dedupe truth. */
export class BoundedHostCommandStore implements HostCommandStore {
	private readonly records = new Map<string, HostCommandRecord>();
	private readonly maxRecords: number;

	public constructor(maxRecords = RUNTIME_HOST_BOUNDS.maxSubscriptionReplay) {
		if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new Error("Host command store bound is invalid");
		this.maxRecords = maxRecords;
	}

	public async begin(principalId: string, commandId: string, requestDigest: string): Promise<HostCommandBeginResult> {
		const key = `${principalId}\u0000${commandId}`;
		const prior = this.records.get(key);
		if (prior) {
			if (prior.requestDigest !== requestDigest) return { status: "conflict" };
			if (prior.state === "intent") return { status: "uncertain" };
			if (prior.response === undefined) throw new Error("Host command receipt is missing its response");
			return { status: "replay", response: prior.response };
		}
		if (this.records.size >= this.maxRecords) return { status: "capacity" };
		this.records.set(key, { version: 1, principalId, commandId, requestDigest, state: "intent" });
		return { status: "execute" };
	}

	public async complete(principalId: string, commandId: string, requestDigest: string, response: HostFrameEnvelope): Promise<void> {
		const key = `${principalId}\u0000${commandId}`;
		const prior = this.records.get(key);
		if (!prior || prior.requestDigest !== requestDigest || prior.state !== "intent") throw new Error("Host command intent does not match receipt");
		this.records.set(key, { ...prior, state: "receipt", response });
	}
}

async function writeDurable(path: string, record: HostCommandRecord): Promise<void> {
	const encoded = `${canonicalJson(record)}\n`;
	if (Buffer.byteLength(encoded, "utf8") > RUNTIME_HOST_BOUNDS.maxFrameBytes) throw new Error("Host command record exceeds frame bound");
	await writeFile(path, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isCommandRecord(value: unknown): value is HostCommandRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.principalId !== "string" || typeof record.commandId !== "string" || typeof record.requestDigest !== "string") return false;
	if (record.state === "intent") return record.response === undefined;
	return record.state === "receipt" && isHostFrame(record.response);
}

function isHostFrame(value: unknown): value is HostFrameEnvelope {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const frame = value as Record<string, unknown>;
	return typeof frame.frameId === "string" && frame.kind === "command_result" && frame.protocolVersion === 1 &&
		typeof frame.body === "object" && frame.body !== null && !Array.isArray(frame.body);
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
