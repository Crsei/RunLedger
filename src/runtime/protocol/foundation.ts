/** Runtime 基础持久化值合同。 */

import type { RuntimeId } from "./ids.ts";
import { canonicalDigest } from "./canonical-json.ts";

export type Sha256Digest = string & {
	readonly __sha256Digest: true;
};

export interface RuntimeDigest {
	readonly algorithm: "sha256";
	readonly digest: Sha256Digest;
}

/** 把 canonical JSON 的字符串摘要提升为带算法标记的 Runtime digest。 */
export function runtimeDigest(value: unknown): RuntimeDigest {
	return {
		algorithm: "sha256",
		digest: canonicalDigest(value) as Sha256Digest,
	};
}

export type RuntimeContentSubjectKind =
	| "artifact"
	| "content"
	| "details"
	| "attestation"
	| "receipt"
	| "manifest"
	| "snapshot"
	| "projection";

export interface RuntimeContentRef {
	readonly subjectKind: RuntimeContentSubjectKind;
	readonly digest: RuntimeDigest;
	readonly mediaType?: string;
	readonly size?: number;
}

export interface RuntimeRevisionRef {
	readonly subjectId: RuntimeId;
	readonly revision: number;
}

export interface RuntimeStreamHead {
	readonly streamId: RuntimeId;
	readonly sequence: number;
	readonly eventHash: RuntimeDigest;
}
