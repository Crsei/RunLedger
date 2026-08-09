/**
 * 聚合既有领域 port 的 TUI 端口表。
 *
 * 只聚合，不复制领域协议；port 缺失 = capability unavailable（不发 effect，
 * 直接展示明确原因）。observer/driver capability 由端口实现方区分，
 * 本层不做能力推断。
 */

import type { PortAvailability } from "./common.ts";
import type { TuiCapabilitySnapshot } from "./state.ts";
import type { ProviderWorkflowPort } from "../providers/types.ts";
import type { AuthWorkflowPort } from "../auth/types.ts";
import type { ModelWorkflowPort } from "../models/types.ts";
import type { ThinkingWorkflowPort } from "../thinking/types.ts";
import type { PromptWorkflowPort } from "../prompts/types.ts";
import type { KeymapWorkflowPort } from "../keymap/types.ts";
import type { DurableQueueWorkflowPort } from "../queue/types.ts";
import type { ApprovalWorkflowPort } from "../approval/types.ts";
import type { TaskGoalQueryPort } from "../task-goal/types.ts";
import type { PlanRenderQueryPort } from "../goal-plan/types.ts";
import type { AgentActivityQueryPort } from "../agents/types.ts";
import type { ExtensionResourcePort } from "../extensions/types.ts";
import type { RuntimeSnapshotQueryPort } from "../runtime-snapshot/types.ts";
import type { SecurityModeWorkflowPort } from "../security-mode/types.ts";
import type { ShutdownWorkflowPort } from "../shutdown/types.ts";
import type { WorkspaceGitPort } from "../workspace/types.ts";
import type { ProcessPassivePort } from "../process/types.ts";
import type { UpdateQueryPort } from "../update/types.ts";
import type { SessionWorkflowPort } from "../sessions/port.ts";

export interface TuiDomainPorts {
	readonly session?: SessionWorkflowPort;
	readonly provider?: ProviderWorkflowPort;
	readonly auth?: AuthWorkflowPort;
	readonly model?: ModelWorkflowPort;
	readonly thinking?: ThinkingWorkflowPort;
	readonly prompt?: PromptWorkflowPort;
	readonly keymap?: KeymapWorkflowPort;
	readonly queue?: DurableQueueWorkflowPort;
	readonly approval?: ApprovalWorkflowPort;
	readonly taskGoal?: TaskGoalQueryPort;
	readonly plan?: PlanRenderQueryPort;
	readonly agents?: AgentActivityQueryPort;
	readonly extensions?: ExtensionResourcePort;
	readonly runtimeSnapshot?: RuntimeSnapshotQueryPort;
	readonly securityMode?: SecurityModeWorkflowPort;
	readonly shutdown?: ShutdownWorkflowPort;
	readonly workspaceGit?: WorkspaceGitPort;
	readonly process?: ProcessPassivePort;
	readonly update?: UpdateQueryPort;
}

export interface CapabilityInput {
	readonly sessionCatalog: boolean;
	readonly sessionMutation?: boolean;
	readonly process?: boolean;
}

/** 端口表 + 显式 session capability -> capability snapshot；缺端口 = unavailable。 */
export function capabilitiesFromPorts(ports: TuiDomainPorts, session: CapabilityInput): TuiCapabilitySnapshot {
	const availability = (port: unknown): PortAvailability =>
		port === undefined ? { state: "unavailable", reason: "port-not-wired" } : { state: "available" };
	const negotiatedAvailability = (negotiated: boolean | undefined, port: unknown): PortAvailability =>
		negotiated !== true
			? { state: "unavailable", reason: "operation-not-negotiated" }
			: availability(port);
	return {
		sessionCatalog: session.sessionCatalog && ports.session !== undefined ? { state: "available" } : { state: "unavailable", reason: "port-not-wired" },
		sessionMutation: session.sessionMutation && ports.session !== undefined ? { state: "available" } : { state: "unavailable", reason: "port-not-wired" },
		provider: availability(ports.provider),
		auth: availability(ports.auth),
		model: availability(ports.model),
		thinking: availability(ports.thinking),
		prompt: availability(ports.prompt),
		keymap: availability(ports.keymap),
		queue: availability(ports.queue),
		approval: availability(ports.approval),
		taskGoal: availability(ports.taskGoal),
		plan: availability(ports.plan),
		agents: availability(ports.agents),
		extensions: availability(ports.extensions),
		runtimeSnapshot: availability(ports.runtimeSnapshot),
		securityMode: availability(ports.securityMode),
		shutdown: availability(ports.shutdown),
		workspaceGit: availability(ports.workspaceGit),
		process: negotiatedAvailability(session.process, ports.process),
		update: availability(ports.update),
	};
}
