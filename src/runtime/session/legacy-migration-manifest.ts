/** Legacy migration manifest/record digest 的唯一 canonical 定义。 */

import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import type { LedgerEntryType } from "../ledger/types.ts";

export const LEGACY_MIGRATION_SCHEMA = "runtime-session-migration/v1";

export interface LegacyMigrationConfiguration {
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** started event 中的 runtime config 必须是 canonical、exact 且与 digest 绑定。 */
export function decodeLegacyMigrationConfiguration(
	configurationJson: string,
	configurationDigest: string,
): LegacyMigrationConfiguration | undefined {
	if (typeof configurationJson !== "string" || typeof configurationDigest !== "string") return undefined;
	if (canonicalDigest(configurationJson) !== configurationDigest) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(configurationJson) as unknown;
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	if (Object.keys(parsed).some((field) => field !== "provider" && field !== "model" && field !== "thinkingLevel")) {
		return undefined;
	}
	if (parsed.provider !== undefined && typeof parsed.provider !== "string") return undefined;
	if (parsed.model !== undefined && typeof parsed.model !== "string") return undefined;
	if (
		parsed.thinkingLevel !== undefined &&
		(typeof parsed.thinkingLevel !== "string" || !THINKING_LEVELS.has(parsed.thinkingLevel))
	) return undefined;
	if (canonicalJson(parsed) !== configurationJson) return undefined;
	return {
		...(typeof parsed.provider === "string" ? { provider: parsed.provider } : {}),
		...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
		...(typeof parsed.thinkingLevel === "string"
			? { thinkingLevel: parsed.thinkingLevel as LegacyMigrationConfiguration["thinkingLevel"] }
			: {}),
	};
}

export interface LegacyMigrationManifestBody {
	readonly mode: "migrate" | "fork-to-v3";
	readonly sourceVersion: 1 | 2;
	readonly sourceDigest: string;
	readonly sourceSize: number;
	readonly headerDigest: string;
	readonly sourceSessionId: string;
	readonly importerVersion: string;
	readonly importSchema: string;
	/** v2 runtime config 的 canonical JSON；v1 固定为 `{}`。 */
	readonly configurationJson: string;
	readonly configurationDigest: string;
	/** 整个 migration 的字段恢复/丢失摘要；逐记录明细仍在 import event 中。 */
	readonly recoveredFields: readonly string[];
	readonly lostFields: readonly string[];
	readonly expectedRecordCount: number;
	readonly expectedRecordSetDigest: string;
}

export type LegacyMigrationImportDescriptor =
	| {
			readonly sourceVersion: 1 | 2;
			readonly sourceIndex: number;
			readonly sourceEntryId: string;
			readonly sourceRecordDigest: string;
			readonly entryType: "message";
			readonly messageKind: "user" | "assistant" | "toolResult";
			readonly disposition: "recovered";
			readonly messageJson: string;
			readonly contentDigest: string;
			readonly recoveredFields: readonly string[];
			readonly lostFields: readonly string[];
	  }
	| {
			readonly sourceVersion: 1 | 2;
			readonly sourceIndex: number;
			readonly sourceEntryId: string;
			readonly sourceRecordDigest: string;
			readonly entryType: LedgerEntryType;
			readonly messageKind: "user" | "assistant" | "toolResult" | "non_message";
			readonly disposition: "omitted";
			readonly contentDigest: string;
			readonly recoveredFields: readonly string[];
			readonly lostFields: readonly string[];
	  };

export function legacyMigrationManifestFromStarted(
	payload: RuntimeEventPayloadMap["session.migration_started"],
): LegacyMigrationManifestBody {
	return {
		mode: payload.mode,
		sourceVersion: payload.sourceVersion,
		sourceDigest: payload.sourceDigest,
		sourceSize: payload.sourceSize,
		headerDigest: payload.headerDigest,
		sourceSessionId: payload.sourceSessionId,
		importerVersion: payload.importerVersion,
		importSchema: payload.importSchema,
		configurationJson: payload.configurationJson,
		configurationDigest: payload.configurationDigest,
		recoveredFields: [...payload.recoveredFields],
		lostFields: [...payload.lostFields],
		expectedRecordCount: payload.expectedRecordCount,
		expectedRecordSetDigest: payload.expectedRecordSetDigest,
	};
}

export function legacyMigrationManifestDigest(
	manifest: LegacyMigrationManifestBody,
): string {
	return canonicalDigest(manifest);
}

export function legacyMigrationImportDescriptorFromPayload(
	payload: RuntimeEventPayloadMap["session.legacy_message_imported"],
): LegacyMigrationImportDescriptor {
	if (payload.disposition === "recovered") {
		return {
			sourceVersion: payload.sourceVersion,
			sourceIndex: payload.sourceIndex,
			sourceEntryId: payload.sourceEntryId,
			sourceRecordDigest: payload.sourceRecordDigest,
			entryType: "message",
			messageKind: payload.messageKind,
			disposition: "recovered",
			messageJson: payload.messageJson,
			contentDigest: payload.contentDigest,
			recoveredFields: [...payload.recoveredFields],
			lostFields: [...payload.lostFields],
		};
	}
	return {
		sourceVersion: payload.sourceVersion,
		sourceIndex: payload.sourceIndex,
		sourceEntryId: payload.sourceEntryId,
		sourceRecordDigest: payload.sourceRecordDigest,
		entryType: payload.entryType,
		messageKind: payload.messageKind,
		disposition: "omitted",
		contentDigest: payload.contentDigest,
		recoveredFields: [...payload.recoveredFields],
		lostFields: [...payload.lostFields],
	};
}

export function legacyMigrationImportRecordDigest(
	descriptor: LegacyMigrationImportDescriptor,
): string {
	return canonicalDigest(descriptor);
}

/**
 * 先摘要每个完整 record descriptor，再摘要有序 digest 列表。
 * 这样 projection 无需复制 messageJson，也不会漏掉字段恢复/丢失声明。
 */
export function legacyMigrationRecordSetDigest(
	descriptors: readonly LegacyMigrationImportDescriptor[],
): string {
	return canonicalDigest(descriptors.map(legacyMigrationImportRecordDigest));
}
