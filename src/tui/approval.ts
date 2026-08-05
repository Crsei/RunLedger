export interface ApprovalReverseRequestView {
	readonly toolName: string;
	readonly summary: string;
	readonly cwd?: string;
	readonly expiresAt?: string;
}

export type ApprovalDecision = "allow-once" | "deny" | "cancel";

export function parseApprovalReverseRequest(body: Record<string, unknown>): ApprovalReverseRequestView | undefined {
	if (body.requestType !== "permission") return undefined;
	if (!isBoundedString(body.toolName, 128) || !isBoundedString(body.summary, 512)) return undefined;
	if (body.cwd !== undefined && !isBoundedString(body.cwd, 1_024)) return undefined;
	if (body.expiresAt !== undefined && !isBoundedString(body.expiresAt, 64)) return undefined;
	return {
		toolName: body.toolName,
		summary: body.summary,
		...(body.cwd === undefined ? {} : { cwd: body.cwd }),
		...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
	};
}

export function approvalDecisionBody(decision: ApprovalDecision): Record<string, unknown> {
	return { ok: true, decision };
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
