import {
	resolveRecordingConfig,
	type ProjectSettings,
} from "../storage/settings-manager.ts";
import type { RunledgerLayout } from "../runtime/contracts/public.ts";
import {
	createLocalTraceRecorderFactory,
	type TraceRecorderFactory,
} from "../runtime/trace/composition.ts";

/** 标准 CLI 只接受启动时解析的用户级 recording authority。 */
export function composeCliTraceRecorderFactory(
	layout: RunledgerLayout,
	settings: ProjectSettings,
): TraceRecorderFactory {
	return createLocalTraceRecorderFactory({
		layout,
		config: resolveRecordingConfig(settings),
	});
}
