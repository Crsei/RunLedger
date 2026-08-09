/**
 * R7:SessionRuntime 领域装配(06 §7.1)。
 *
 * - 唯一允许组合 InteractiveSessionController 的模块前缀是
 *   src/runtime/session-runtime/(边界检查 direct-controller 规则);
 * - 一个 SessionRuntime 只装配一个 Session 的 Agent/model/tool/ledger;
 *   不构成 machine-wide registry;
 * - ledger 走 SqliteLedgerSink(owner-fenced durable event),replay 复用
 *   session-codec 的 replaySession,checkpoint 可删。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { SessionId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionDomainPort, SessionDomainSnapshot } from "./session-runtime.ts";
import { SqliteLedgerSink } from "./sqlite-ledger.ts";
import { gatedExecutionEnv, type LateBoundAttemptPort } from "./attempt-gateway.ts";
import { replaySession } from "../../storage/session-codec.ts";
import type { ExecutionEnv } from "../execution-env.ts";
import { createStdlibTools } from "../tools/index.ts";
import { InteractiveSessionController, type RuntimeSelectionOverrides } from "../interactive-session-controller.ts";
import type { AgentTool } from "../types.ts";
import type { Models } from "../../models.ts";
import type { RunledgerLayout } from "../contracts/storage-layout.ts";
import type { ProjectSettings } from "../../storage/settings-manager.ts";
import type { TraceRecorderFactory } from "../trace/composition.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createSessionSecurity,
	type SessionSecurityConfigSource,
} from "../../security/session-composition.ts";
import type { RestoreOutcome } from "./restore.ts";
import { restoreCheckpointReplay } from "./checkpoint.ts";
import { isCurrentLedgerEntry, type LedgerEntry } from "../ledger/types.ts";
import type { SessionApprovalPorts } from "./approval-reverse-request.ts";

export interface SessionDomainCompositionOptions {
	readonly cwd: string;
	readonly layout: RunledgerLayout;
	readonly settings: ProjectSettings;
	readonly models: Models;
	readonly overrides?: RuntimeSelectionOverrides;
	readonly traceRecorderFactory?: TraceRecorderFactory;
	/** Session Event Store + 当前 driver reverse-request 的 approval authority。 */
	readonly approvalPorts?: SessionApprovalPorts;
	/** CLI > managed > project > user 的 session-scoped Security 配置层。 */
	readonly securitySources?: readonly SessionSecurityConfigSource[];
	/** 可选:AGENTS 拼接(缺省读 <cwd>/AGENTS.md)。 */
	readonly systemPrompt?: string;
}

/** 在 SessionRuntime 内装配真实 InteractiveSessionController(单一 Session 域)。 */
export async function assembleSessionDomain(
	options: SessionDomainCompositionOptions,
	sessionId: SessionId,
	store: SessionStore,
	fence: OwnerFence,
	restored: Extract<RestoreOutcome, { readonly ok: true }>,
	attemptPort?: LateBoundAttemptPort,
): Promise<SessionDomainPort> {
	const ledger = new SqliteLedgerSink({ store, fence: () => fence });
	const replay = await replayDomain(ledger, restored);
	const catalog = store.getSession(sessionId);
	if (catalog === undefined) throw new Error(`session not found during domain composition: ${sessionId}`);
	if (attemptPort === undefined) throw new Error("session attempt gateway is required for production composition");
	const security = await createSessionSecurity({
		layout: options.layout,
		cwd: options.cwd,
		fence,
		workspaceId: catalog.workspaceId,
		repositoryId: catalog.repositoryId,
		...(options.securitySources === undefined ? {} : { securitySources: options.securitySources }),
		...(options.approvalPorts === undefined ? {} : { approvalPorts: options.approvalPorts }),
	});
	// recovery attempt fence 包裹 governed 最终叶；任何一层缺失都 fail closed。
	const executionEnv = gatedExecutionEnv(security.executionEnv, () => attemptPort.get(), sessionId);
	const traceRecorderFactory = options.traceRecorderFactory === undefined
		? undefined
		: {
			create: (input: Parameters<TraceRecorderFactory["create"]>[0]) => options.traceRecorderFactory!.create({
				...input,
				sessionId,
				ownerGeneration: fence.generation,
			}),
		};
	const controller = await InteractiveSessionController.create({
		cwd: options.cwd,
		layout: options.layout,
		systemPrompt: options.systemPrompt ?? buildSystemPrompt(options.cwd, options.layout.agents),
		models: options.models,
		settings: options.settings,
		replay,
		ledger,
		overrides: options.overrides,
		tools: productionSessionTools(options.cwd, executionEnv),
		executionEnv,
		authorizationPolicy: security.authorizationPolicy,
		traceRecorderFactory,
	});
	return {
		controller,
		protocolCapabilities: ["session.approval.reverse", "session.security.inspect"],
		securityInspection: () => ({
			ownerGeneration: fence.generation,
			profile: security.snapshot.profile.name,
			approvalPolicy: security.snapshot.profile.approvalPolicy,
			filesystemMode: security.snapshot.profile.filesystemMode,
			networkMode: security.snapshot.profile.network.mode,
			sandboxMode: security.snapshot.profile.sandbox,
			policyDigest: security.snapshot.policyDigest,
			sourceCount: security.snapshot.sources.length,
		}),
		snapshot: (): SessionDomainSnapshot => ({
			messages: controller.messages,
			warnings: controller.warnings,
			auditEntries: controller.auditEntries,
			selection: controller.currentSelection,
			toolCount: controller.toolCount,
			inFlight: controller.inFlight,
			providerStatuses: [],
		}),
	};
}

async function replayDomain(
	ledger: SqliteLedgerSink,
	restored: Extract<RestoreOutcome, { readonly ok: true }>,
) {
	if (restored.checkpoint !== undefined) {
		const tail = restored.replayEvents.flatMap((event): LedgerEntry[] => {
			if (!event.eventType.startsWith("ledger.")) return [];
			try {
				const entry = JSON.parse(event.payloadJson) as unknown;
				return isCurrentLedgerEntry(entry) ? [entry] : [];
			} catch {
				return [];
			}
		});
		const replay = restoreCheckpointReplay(restored.checkpoint.snapshot, tail);
		if (replay !== undefined) return replay;
	}
	return replaySession(ledger);
}

/** AGENTS 拼接:项目 AGENTS.md + 用户全局 AGENTS.md(与 legacy Host 同源逻辑)。 */
export function buildSystemPrompt(cwd: string, globalAgents: string): string {
	const instructions: string[] = [];
	for (const path of [join(cwd, "AGENTS.md"), globalAgents]) {
		try {
			const content = readFileSync(path, "utf8");
			if (content.length > 0) instructions.push(content);
		} catch {
			// AGENTS.md 不存在或不可读时只保留默认提示。
		}
	}
	return `You are RunLedger's interactive coding agent inside a TUI. Work in ${cwd}. ` +
		"Use governed Read/Write/Edit/Bash/process tools and keep replies concise." +
		(instructions.length > 0 ? `\n\n---\n\n${instructions.join("\n\n---\n\n")}` : "");
}

/** 生产工具集:stdlib(read/write/edit/bash/grep/find/ls/multi-edit/web-fetch/todo/task),排除 echo/Skill/NotebookEdit。 */
export function productionSessionTools(cwd: string, executionEnv: ExecutionEnv): AgentTool[] {
	const excluded = new Set(["Skill", "NotebookEdit", "echo"]);
	return createStdlibTools(cwd, {
		requireExecutionEnv: true,
		executionEnv,
	})
		.toContext()
		.filter((tool: AgentTool) => !excluded.has(tool.name));
}
