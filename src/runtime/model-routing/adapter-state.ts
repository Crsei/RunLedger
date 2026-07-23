import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type {
	AdapterStateDisposition,
	ModelAdapterStateCompatibility,
	ModelCapabilityProfile,
} from "./types.ts";

function disposition(
	sameProvider: boolean,
	portable: boolean,
	switchMode: ModelCapabilityProfile["midSessionSwitch"],
): AdapterStateDisposition {
	if (switchMode === "unsupported") return "deny";
	if (switchMode === "fork_required") return "fork_required";
	if (!sameProvider || !portable) return "drop";
	return "preserve";
}

/** 只输出状态处置 metadata，永不携带 provider-private reasoning/cache 正文。 */
export function compareAdapterState(
	source: ModelCapabilityProfile,
	target: ModelCapabilityProfile,
): ModelAdapterStateCompatibility {
	const sameProvider = source.providerId === target.providerId && source.apiProtocol === target.apiProtocol;
	const reasoningState = disposition(
		sameProvider,
		source.reasoningHistory === "portable" && target.reasoningHistory === "portable",
		target.midSessionSwitch,
	);
	const toolReplayState = disposition(
		sameProvider,
		source.toolCallReplay !== "unsupported" && target.toolCallReplay !== "unsupported",
		target.midSessionSwitch,
	);
	const cacheState: AdapterStateDisposition = sameProvider ? "preserve" : "drop";
	const body = {
		schemaVersion: 2 as const,
		authorityId: target.authorityId,
		tenantId: target.tenantId,
		sourceProfileId: source.profileId,
		targetProfileId: target.profileId,
		reasoningState,
		toolReplayState,
		cacheState,
	};
	return {
		...body,
		stateDescriptorDigest: canonicalDigest(body),
		compatible: ![reasoningState, toolReplayState, cacheState].some(
			(value) => value === "fork_required" || value === "deny",
		),
	};
}
