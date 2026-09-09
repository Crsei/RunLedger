/**
 * S2 拆分:gateway effect 结算、结果解包与 bash classification audit 关联。
 *
 * `settleGatewayEffect` 保证 beginAttempt/settleAttempt 顺序:effect 成功或
 * 失败都必须 complete() 结算 attempt;`linkBashClassificationAudit` 为
 * best-effort linkage(缺失 evidence 由授权侧 fail closed,此处不改授权结果)。
 */

import type { ExecutionGatewayContext } from "../execution-gateway.ts";
import type { ProcessFinalLeafDecision } from "../integration/runtime-gateway-adapter.ts";
import type { BashClassificationAuditPort } from "../permission/bash-ast/types.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { SecurityResult } from "../types.ts";
import { isPolicyChanged } from "../policy-revision.ts";

export async function settleGatewayEffect<T>(context: ExecutionGatewayContext, effect: () => Promise<T>): Promise<T> {
	try {
		unwrapSecurityResult(await context.validateAuthorization());
		const value = await effect();
		unwrapSecurityResult(await context.complete());
		return value;
	} catch (error) {
		// 版本检查拒绝意味着 effect 尚未 dispatch；保留同版本重试所需的单次票据。
		if (isPolicyChanged(error)) throw error;
		unwrapSecurityResult(await context.complete());
		throw error;
	}
}

export async function linkBashClassificationAudit(
	audit: BashClassificationAuditPort | undefined,
	sessionId: string,
	requestDigest: RuntimeDigest,
	decision: ProcessFinalLeafDecision,
): Promise<void> {
	if (audit?.link === undefined) return;
	try {
		await audit.link({
			protocolVersion: 1,
			sessionId,
			requestDigest: requestDigest.digest,
			constraintSnapshotDigest: decision.constraintSnapshotDigest.digest,
			...(decision.sandboxReceipt === undefined
				? {}
				: { sandboxReceiptDigest: decision.sandboxReceipt.receiptDigest.digest }),
		});
	} catch {
		// 分类 linkage 审计为 best-effort，不改变已经收窄的授权结果。
	}
}

export function unwrapSecurityResult<T>(result: SecurityResult<T>): T {
	if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
	return result.value;
}

export function unwrapSandboxResult<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}
