import type { RuntimeContentRef, RuntimeDigest, Sha256Digest } from "../protocol/foundation.ts";
import type { ToolResultOverflowStore } from "../types.ts";
import type { FileArtifactStore } from "./artifact-store.ts";

/**
 * Adapts the canonical ArtifactStore to the agent-loop overflow port.
 * The store is created by Host composition only for events_and_artifacts;
 * this adapter never exposes a filesystem locator to the model.
 */
export function createArtifactToolResultOverflowStore(
	store: Pick<FileArtifactStore, "put">,
	redactionPolicyDigest = "policy_trace_v1",
): ToolResultOverflowStore {
	return {
		put: async (input): Promise<{ readonly ref: RuntimeContentRef }> => {
			const artifact = await store.put({
				bytes: input.bytes,
				mediaType: input.mediaType,
				redactionPolicyDigest,
				sourceDigest: input.sourceDigest.digest,
			});
			const digest: RuntimeDigest = {
				algorithm: "sha256",
				digest: artifact.digest as Sha256Digest,
			};
			return {
				ref: {
					subjectKind: "artifact",
					digest,
					mediaType: artifact.mediaType,
					size: artifact.size,
				},
			};
		},
	};
}
