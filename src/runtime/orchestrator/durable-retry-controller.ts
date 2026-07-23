/** Retry policy 与 durable control journal 的 production controller。 */

import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import type { CommandId } from "../protocol/v3/ids.ts";
import type { DurableControlJournal } from "./control-journal.ts";
import {
	decideRetry,
	type RetryContext,
	type RetryDecision,
	type RetryFailure,
} from "./retry-policy.ts";
import type { OrchestratorResult } from "./types.ts";

export interface DurableRetryControllerOptions {
	control: DurableControlJournal;
}

export class DurableRetryController {
	readonly #control: DurableControlJournal;

	public constructor(options: DurableRetryControllerOptions) {
		this.#control = options.control;
	}

	public async decide(
		operationId: CommandId,
		failure: RetryFailure,
		context: RetryContext,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<RetryDecision>> {
		const decision = decideRetry(failure, context);
		const recorded = await this.#control.recordRetryDecision(
			operationId,
			failure,
			context,
			decision,
			idempotencyKey,
		);
		return recorded.ok ? { ok: true, value: decision } : recorded;
	}
}
