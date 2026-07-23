/** 从 canonical v3 message events 重建 provider 可继续消费的会话历史。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { RuntimeEventV3 } from "../protocol/v3/events.ts";
import { decodeCanonicalAgentMessage } from "../../storage/session-codec.ts";
import type { SessionRuntimeConfig } from "../../storage/session-codec.ts";
import type { AgentMessage } from "../types.ts";
import type { SessionResult } from "./types.ts";
import { decodeLegacyMigrationConfiguration } from "./legacy-migration-manifest.ts";

function decodeMessage(
	sequence: number,
	role: AgentMessage["role"],
	messageJson: string,
	contentDigest: string,
): SessionResult<AgentMessage> {
	if (canonicalDigest(messageJson) !== contentDigest) {
		return {
			ok: false,
			error: {
				code: "hash_mismatch",
				message: "conversation message digest does not match its canonical event payload",
				retryable: false,
				details: { sequence },
			},
		};
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(messageJson) as unknown;
	} catch {
		return {
			ok: false,
			error: {
				code: "invalid_event",
				message: "conversation message payload is not valid JSON",
				retryable: false,
				details: { sequence },
			},
		};
	}
	const message = decodeCanonicalAgentMessage(decoded);
	if (!message || message.role !== role) {
		return {
			ok: false,
			error: {
				code: "invalid_event",
				message: "conversation message role or shape is invalid",
				retryable: false,
				details: { sequence },
			},
		};
	}
	return { ok: true, value: message };
}

export function replayConversationEvents(events: readonly RuntimeEventV3[]): SessionResult<readonly AgentMessage[]> {
	if (
		events[0]?.type === "session.migration_started" &&
		!events.some((event) => event.type === "session.migration_committed")
	) {
		return {
			ok: false,
			error: {
				code: "stopped",
				message: "legacy migration is not durably committed",
				retryable: false,
			},
		};
	}
	const messages: AgentMessage[] = [];
	for (const event of events) {
		if (event.type === "session.legacy_message_imported") {
			if (event.payload.disposition === "omitted") continue;
			const decoded = decodeMessage(
				event.sequence,
				event.payload.messageKind,
				event.payload.messageJson,
				event.payload.contentDigest,
			);
			if (!decoded.ok) return decoded;
			messages.push(decoded.value);
			continue;
		}
		if (event.type === "conversation.message_recorded") {
			const decoded = decodeMessage(
				event.sequence,
				event.payload.role,
				event.payload.messageJson,
				event.payload.contentDigest,
			);
			if (!decoded.ok) return decoded;
			messages.push(decoded.value);
		}
	}
	return { ok: true, value: messages };
}

/** legacy v2 的 provider/model/thinking 配置从 migration genesis 可重复恢复。 */
export function replayRuntimeConfigurationEvents(
	events: readonly RuntimeEventV3[],
): SessionResult<Readonly<SessionRuntimeConfig>> {
	const genesis = events[0];
	if (!genesis || genesis.type !== "session.migration_started") return { ok: true, value: {} };
	if (!events.some((event) => event.type === "session.migration_committed")) {
		return {
			ok: false,
			error: {
				code: "stopped",
				message: "legacy migration is not durably committed",
				retryable: false,
			},
		};
	}
	const configuration = decodeLegacyMigrationConfiguration(
		genesis.payload.configurationJson,
		genesis.payload.configurationDigest,
	);
	if (!configuration) {
		return {
			ok: false,
			error: {
				code: "invalid_event",
				message: "legacy migration runtime configuration is invalid",
				retryable: false,
			},
		};
	}
	return { ok: true, value: configuration };
}
