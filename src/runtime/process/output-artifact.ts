/** R7 process output -> Trace/Artifact boundary。
 *
 * Private output remains the canonical process record. This module only
 * projects a sealed bounded copy according to the already-resolved recording
 * mode; it never changes process state and never exposes a private locator.
 */

import type { RuntimeContentRef, RuntimeDigest } from "../protocol/foundation.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { createHash } from "node:crypto";
import type { ArtifactMetadata } from "../trace/artifact-store.ts";
import type { TraceArtifactRef, TraceContentDescriptor } from "../trace/types.ts";

export type ProcessRecordingMode = "off" | "events" | "events_and_artifacts";

export interface ProcessOutputArtifactStore {
	put(input: {
		readonly bytes: Uint8Array;
		readonly mediaType: string;
		readonly redactionPolicyDigest: string;
		readonly sourceDigest?: string;
	}): Promise<TraceArtifactRef>;
	read?(ref: TraceArtifactRef): Promise<Uint8Array>;
	metadata?(ref: TraceArtifactRef): Promise<ArtifactMetadata>;
}

export interface ProcessOutputMaterialization {
	readonly outputRef: RuntimeContentRef;
	readonly traceContent?: TraceContentDescriptor;
	readonly artifactRef?: TraceArtifactRef;
}

export interface ProcessOutputMaterializationRecord {
	readonly mode: ProcessRecordingMode;
	readonly sourceDigest: RuntimeDigest;
	readonly materialization: ProcessOutputMaterialization;
	readonly recordDigest: RuntimeDigest;
}

export interface ProcessOutputStorePort {
	readAll(): Promise<
		| { readonly ok: true; readonly text: string; readonly head: { readonly sequence: number; readonly byteOffset: number }; readonly seal?: { readonly digest: RuntimeDigest; readonly size: number } }
		| { readonly ok: false; readonly code: string }
	>;
	readMaterialization?(): Promise<ProcessOutputMaterializationRecord | undefined>;
	recordMaterialization?(record: ProcessOutputMaterializationRecord): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
}

export type ProcessOutputMaterializationResult =
	| { readonly ok: true; readonly materialization: ProcessOutputMaterialization; readonly record: ProcessOutputMaterializationRecord }
	| { readonly ok: false; readonly code: "output_read_failed" | "artifact_materialization_failed" | "artifact_store_unavailable" | "materialization_record_failed" };

export class ManagedProcessOutputMaterializer {
	private readonly mode: ProcessRecordingMode;
	private readonly artifactStore: ProcessOutputArtifactStore | undefined;
	private readonly redactionPolicyDigest: string;

	public constructor(options: {
		readonly mode: ProcessRecordingMode;
		readonly artifactStore?: ProcessOutputArtifactStore;
		readonly redactionPolicyDigest?: string;
	}) {
		this.mode = options.mode;
		this.artifactStore = options.artifactStore;
		this.redactionPolicyDigest = options.redactionPolicyDigest ?? "policy_trace_v1";
	}

	public async materialize(store: ProcessOutputStorePort): Promise<ProcessOutputMaterializationResult> {
		const output = await store.readAll();
		if (!output.ok) return { ok: false, code: "output_read_failed" };
		const digest = output.seal?.digest ?? runtimeDigest(output.text);
		const size = Buffer.byteLength(output.text, "utf8");
		try {
			const prior = await store.readMaterialization?.();
			if (prior?.mode === this.mode && prior.sourceDigest.digest === digest.digest) {
				if (!await this.verifyPriorMaterialization(prior, output.text)) {
					return { ok: false, code: "artifact_materialization_failed" };
				}
				return { ok: true, materialization: prior.materialization, record: prior };
			}
		} catch {
			return { ok: false, code: "output_read_failed" };
		}
		const outputRef: RuntimeContentRef = {
			subjectKind: "content",
			digest,
			mediaType: "text/plain; charset=utf-8",
			size,
		};
		if (this.mode === "off") return this.persist(store, digest, { outputRef });
		if (this.mode === "events") {
			return this.persist(store, digest, {
				outputRef,
				traceContent: { storage: "digest_only", digest: digest.digest, mediaType: "text/plain; charset=utf-8", size },
			});
		}
		if (!this.artifactStore) return { ok: false, code: "artifact_store_unavailable" };
		try {
			const artifactRef = await this.artifactStore.put({
				bytes: new TextEncoder().encode(output.text),
				mediaType: "text/plain; charset=utf-8",
				redactionPolicyDigest: this.redactionPolicyDigest,
				sourceDigest: digest.digest,
			});
			return this.persist(store, digest, {
				outputRef: { ...outputRef, subjectKind: "artifact", digest: runtimeDigest(artifactRef.digest) },
				artifactRef,
				traceContent: artifactRef,
			});
		} catch {
			return { ok: false, code: "artifact_materialization_failed" };
		}
	}

	private async verifyPriorMaterialization(
		record: ProcessOutputMaterializationRecord,
		text: string,
	): Promise<boolean> {
		const artifactRef = record.materialization.artifactRef;
		if (record.mode !== "events_and_artifacts") return artifactRef === undefined;
		if (artifactRef === undefined || this.artifactStore?.read === undefined || this.artifactStore.metadata === undefined) return false;
		try {
			const [bytes, metadata] = await Promise.all([
				this.artifactStore.read(artifactRef),
				this.artifactStore.metadata(artifactRef),
			]);
			const expected = new TextEncoder().encode(text);
			const digest = createHash("sha256").update(bytes).digest("hex");
			return bytes.byteLength === expected.byteLength &&
				digest === artifactRef.digest &&
				bytes.every((value, index) => value === expected[index]) &&
				metadata.artifactId === artifactRef.artifactId &&
				metadata.digest === artifactRef.digest &&
				metadata.storedDigest === artifactRef.digest &&
				metadata.mediaType === artifactRef.mediaType &&
				metadata.size === artifactRef.size;
		} catch {
			return false;
		}
	}

	private async persist(store: ProcessOutputStorePort, sourceDigest: RuntimeDigest, materialization: ProcessOutputMaterialization): Promise<ProcessOutputMaterializationResult> {
		const record: ProcessOutputMaterializationRecord = {
			mode: this.mode,
			sourceDigest,
			materialization,
			recordDigest: runtimeDigest({ mode: this.mode, sourceDigest, materialization }),
		};
		if (store.recordMaterialization) {
			try {
				const recorded = await store.recordMaterialization(record);
				if (!recorded.ok) return { ok: false, code: "materialization_record_failed" };
			} catch {
				return { ok: false, code: "materialization_record_failed" };
			}
		}
		return { ok: true, materialization, record };
	}
}

export function processOutputDigestRef(digest: RuntimeDigest, size: number): RuntimeContentRef {
	return { subjectKind: "content", digest, mediaType: "text/plain; charset=utf-8", size };
}
