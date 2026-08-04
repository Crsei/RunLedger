/** 把平台 stderr 归类为结构化 sandbox denial；不保存或转发原始 stderr。 */

import { makeFailure } from "./common.ts";
import type { SandboxError } from "./types.ts";

const DENIAL_PATTERNS = [
	/bwrap[^\n]{0,256}(?:permission denied|operation not permitted|denied)/iu,
	/sandbox-exec[^\n]{0,256}(?:permission denied|operation not permitted|deny|denied)/iu,
	/seatbelt[^\n]{0,256}(?:permission denied|operation not permitted|deny|denied)/iu,
	/(?:permission denied|operation not permitted|access is denied)/iu,
];

export type SandboxDenialKind = "filesystem" | "network" | "process" | "unknown";

export interface SandboxDenial extends SandboxError {
	readonly code: "sandbox_denied";
	readonly kind: SandboxDenialKind;
	readonly exitCode: number;
}

export function isSandboxDenial(stderr: string, exitCode: number): boolean {
	return exitCode !== 0 && DENIAL_PATTERNS.some((pattern) => pattern.test(stderr.slice(0, 16_384)));
}

export function sandboxDenialReason(stderr: string): SandboxDenialKind {
	if (/(?:network|socket|connect|unshare-net)/iu.test(stderr)) return "network";
	if (/(?:file|path|read|write|permission|access)/iu.test(stderr)) return "filesystem";
	if (/(?:process|exec|spawn|fork)/iu.test(stderr)) return "process";
	return "unknown";
}

export function classifySandboxDenial(stderr: string, exitCode: number): SandboxDenial | undefined {
	if (!isSandboxDenial(stderr, exitCode)) return undefined;
	const kind = sandboxDenialReason(stderr);
	const error = makeFailure("sandbox_denied", `sandbox denied the child operation (${kind})`).error;
	return { ...error, code: "sandbox_denied", kind, exitCode };
}
