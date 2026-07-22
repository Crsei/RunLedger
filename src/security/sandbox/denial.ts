/** 平台 denial 文本只用于结构化分类，不进入事件原文。 */

const DENIAL_PATTERNS = [
	/bwrap:.*permission denied/iu,
	/operation not permitted/iu,
	/sandbox(?:-exec)?:.*deny/iu,
	/seatbelt.*denied/iu,
	/access is denied/iu,
];

export function isSandboxDenial(stderr: string, exitCode: number): boolean {
	return exitCode !== 0 && DENIAL_PATTERNS.some((pattern) => pattern.test(stderr));
}

export function sandboxDenialReason(stderr: string): "filesystem" | "network" | "process" | "unknown" {
	if (/network|socket|connect/iu.test(stderr)) return "network";
	if (/file|path|read|write|permission/iu.test(stderr)) return "filesystem";
	if (/process|exec|spawn/iu.test(stderr)) return "process";
	return "unknown";
}
