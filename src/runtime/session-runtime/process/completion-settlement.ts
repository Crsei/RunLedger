/**
 * S3 拆分:process terminal truth 与 authorization/attempt 结算。
 *
 * 每个 executionId 至多一次 authorization complete 与 attempt settle;
 * settle 顺序由调用方(onProcessTerminal/query wait/stop path)保证,
 * 本模块只做幂等结算与映射持有。
 */

import { runtimeDigest } from "../../protocol/foundation.ts";
import type { AttemptId } from "../../protocol/ids.ts";
import type { SessionProcessCompositionOptions } from "./composition.ts";

export class ProcessCompletionSettlement {
	private readonly options: SessionProcessCompositionOptions;
	private readonly authorizationCompletions = new Map<string, () => Promise<unknown>>();
	private readonly processAttempts = new Map<string, AttemptId>();

	public constructor(options: SessionProcessCompositionOptions) {
		this.options = options;
	}

	public registerAuthorization(executionId: string, complete: () => Promise<unknown>): void {
		this.authorizationCompletions.set(executionId, complete);
	}

	public registerAttempt(executionId: string, attemptId: AttemptId): void {
		this.processAttempts.set(executionId, attemptId);
	}

	public async complete(executionId: string): Promise<void> {
		const complete = this.authorizationCompletions.get(executionId);
		if (complete === undefined) return;
		this.authorizationCompletions.delete(executionId);
		await complete();
	}

	public async settle(executionId: string, outcome: "committed" | "rejected"): Promise<void> {
		const attemptId = this.processAttempts.get(executionId);
		if (attemptId === undefined) return;
		const port = this.options.attemptPort?.();
		if (port === undefined) throw new Error("Session process attempt port is unavailable");
		const settled = port.settleAttempt(attemptId, outcome, runtimeDigest({ executionId, outcome }));
		if (!settled.ok) throw new Error(`Session process attempt settlement failed: ${settled.code}`);
		this.processAttempts.delete(executionId);
	}
}
