/** Runtime 基础持久化值合同。 */

import type { RuntimeId } from "./ids.ts";

export type Sha256Digest = string & {
	readonly __sha256Digest: true;
};

export interface RuntimeDigest {
	readonly algorithm: "sha256";
	readonly digest: Sha256Digest;
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
