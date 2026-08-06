/** Identity-bound reason for an intentional resident Host shutdown. */

import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";
import { hostStateRelativeLocator } from "../../runtime/contracts/storage-layout.ts";
import { RuntimeDigestSchema, RuntimeIdSchema } from "../../runtime/protocol/foundation-schemas.ts";
import { runtimeDigest, type RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { ensureContainedHostStoreDirectory } from "./store-path-safety.ts";

export type PersistedHostShutdownReason = "manual_stop" | "maintenance_restart" | "external_signal" | "auto_update";

export interface HostShutdownIntent {
	readonly format: "runledger-host-shutdown-intent-current";
	readonly workspaceStorageKey: string;
	readonly hostRuntimeId: string;
	readonly hostGeneration: number;
	readonly reason: PersistedHostShutdownReason;
	readonly targetBuildDigest?: RuntimeDigest;
	readonly requestedAt: string;
	readonly intentDigest: RuntimeDigest;
}

export type HostShutdownIntentInput = Omit<HostShutdownIntent, "format" | "intentDigest">;

const HostShutdownIntentSchema = Type.Object({
	format: Type.Literal("runledger-host-shutdown-intent-current"),
	workspaceStorageKey: Type.String({ pattern: "^ws-[a-f0-9]{64}$" }),
	hostRuntimeId: RuntimeIdSchema,
	hostGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	reason: Type.Union([
		Type.Literal("manual_stop"),
		Type.Literal("maintenance_restart"),
		Type.Literal("external_signal"),
		Type.Literal("auto_update"),
	]),
	targetBuildDigest: Type.Optional(RuntimeDigestSchema),
	requestedAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
	intentDigest: RuntimeDigestSchema,
}, { additionalProperties: false });

export function createHostShutdownIntent(input: HostShutdownIntentInput): HostShutdownIntent {
	const body = { format: "runledger-host-shutdown-intent-current" as const, ...input };
	return { ...body, intentDigest: runtimeDigest(body) };
}

export function evaluateHostReplacementAdmission(
	intent: HostShutdownIntent | undefined,
	candidateGeneration: number,
	candidateBuildDigest: RuntimeDigest,
): { readonly ok: true } | { readonly ok: false; readonly code: "host_build_mismatch" } {
	if (intent?.reason !== "maintenance_restart" || intent.targetBuildDigest === undefined || candidateGeneration <= intent.hostGeneration) {
		return { ok: true };
	}
	return intent.targetBuildDigest.digest === candidateBuildDigest.digest
		? { ok: true }
		: { ok: false, code: "host_build_mismatch" };
}

export async function evaluateStoredHostReplacementAdmission(
	store: Pick<HostShutdownIntentStore, "read">,
	candidateGeneration: number,
	candidateBuildDigest: RuntimeDigest,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: "host_build_mismatch" }> {
	return evaluateHostReplacementAdmission(await store.read(), candidateGeneration, candidateBuildDigest);
}

export class HostShutdownIntentStore {
	private readonly filePath: string;
	private readonly layout: RunledgerLayout;
	private readonly workspaceStorageKey: string;

	public constructor(layout: RunledgerLayout, workspaceStorageKey: string) {
		this.layout = layout;
		this.workspaceStorageKey = workspaceStorageKey;
		this.filePath = join(layout.home, hostStateRelativeLocator(workspaceStorageKey), "shutdown-intent.json");
	}

	public path(): string { return this.filePath; }

	public async write(intent: HostShutdownIntent): Promise<void> {
		if (!validIntent(intent) || intent.workspaceStorageKey !== this.workspaceStorageKey) throw new Error("invalid Host shutdown intent");
		await ensureContainedHostStoreDirectory(this.layout.home, dirname(this.filePath));
		await ensureContainedHostStoreDirectory(this.layout.home, this.layout.tmp);
		await assertRegularOrMissing(this.filePath);
		const staging = join(this.layout.tmp, `host-shutdown-intent-${randomUUID()}.tmp`);
		try {
			await writeFile(staging, `${JSON.stringify(intent)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await ensureContainedHostStoreDirectory(this.layout.home, dirname(this.filePath));
			await ensureContainedHostStoreDirectory(this.layout.home, this.layout.tmp);
			await assertRegularOrMissing(this.filePath);
			await rename(staging, this.filePath);
		} finally {
			await unlink(staging).catch(() => undefined);
		}
	}

	public async read(): Promise<HostShutdownIntent | undefined> {
		let content: string;
		try {
			await ensureContainedHostStoreDirectory(this.layout.home, dirname(this.filePath));
			await assertRegularOrMissing(this.filePath);
			content = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
		let parsed: unknown;
		try { parsed = JSON.parse(content) as unknown; } catch { throw new Error("invalid Host shutdown intent JSON"); }
		if (!validIntent(parsed) || parsed.workspaceStorageKey !== this.workspaceStorageKey) throw new Error("invalid Host shutdown intent");
		return parsed;
	}
}

function validIntent(value: unknown): value is HostShutdownIntent {
	if (!Value.Check(HostShutdownIntentSchema, value)) return false;
	const intent = value as unknown as HostShutdownIntent;
	const { intentDigest, ...body } = intent;
	return runtimeDigest(body).digest === intentDigest.digest;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function assertRegularOrMissing(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error("Host shutdown intent symlink is not allowed");
		if (!info.isFile()) throw new Error("Host shutdown intent must be a regular file");
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
}
