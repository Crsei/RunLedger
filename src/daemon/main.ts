/** 无网络监听的 daemon 启动核心；CLI/bin 接线由后续串行集成窗口完成。 */

import type { ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import {
	createHeadlessDaemonComposition,
	type HeadlessDaemonComposition,
	type HeadlessDaemonCompositionOptions,
} from "./composition-root.ts";
import {
	DaemonRecoveryAdapter,
	type DaemonRecoveryReport,
	type DaemonRuntimeRecoveryPort,
} from "./recovery-adapter.ts";

export interface StartHeadlessDaemonOptions extends HeadlessDaemonCompositionOptions {
	recovery: DaemonRuntimeRecoveryPort;
}

export interface StartedHeadlessDaemon {
	composition: HeadlessDaemonComposition;
	recovery: DaemonRecoveryReport;
}

export async function startHeadlessDaemonCore(
	options: StartHeadlessDaemonOptions,
): Promise<ControlPlaneResult<StartedHeadlessDaemon>> {
	const composition = createHeadlessDaemonComposition(options);
	const recovered = await new DaemonRecoveryAdapter(options.recovery, composition.idempotency).recover();
	if (!recovered.ok) {
		await composition.shutdown.begin(30_000);
		return recovered;
	}
	return { ok: true, value: { composition, recovery: recovered.value } };
}
