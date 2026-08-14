/** Session Event Store-backed Bash AST classification audit。 */

import { createRuntimeId } from "../contracts/public.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type {
	BashClassificationAuditLinkRecord,
	BashClassificationAuditPort,
	BashClassificationAuditRecord,
} from "../../security/permission/bash-ast/types.ts";

export function createSessionBashClassificationAudit(options: {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
}): BashClassificationAuditPort {
	let tail = Promise.resolve();
	const append = (
		eventType: "security.bash_classified" | "security.bash_authorized",
		requestDigest: string,
		payload: BashClassificationAuditRecord | BashClassificationAuditLinkRecord,
	): Promise<void> => {
		const next = tail.then(() => {
			if (payload.sessionId !== options.fence.sessionId) {
				throw new Error("Bash classification audit session does not match the owner fence");
			}
			const suffix = eventType === "security.bash_classified" ? "classified" : "authorized";
			const eventId = createRuntimeId("event", `bash-${suffix}-${requestDigest}`);
			if (options.store.replaySessionEvents(options.fence.sessionId).some((event) => event.eventId === eventId)) return;
			const current = options.store.replaySessionEvents(options.fence.sessionId).at(-1);
			options.store.appendEvent(options.fence, {
				eventId,
				ownerGeneration: options.fence.generation,
				eventType,
				payloadJson: JSON.stringify(payload),
				createdAtMs: Date.now(),
				expectedPreviousEventHash: current?.currentEventHash ?? null,
			});
		});
		tail = next.catch(() => undefined);
		return next;
	};
	return {
		record: (record) => append("security.bash_classified", record.requestDigest, record),
		link: (record) => append("security.bash_authorized", record.requestDigest, record),
	};
}
