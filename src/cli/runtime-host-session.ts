/** Host-side SessionManager/Agent composition. */

import type { ProjectSettings } from "../storage/settings-manager.ts";
import { SessionManager } from "../storage/session-manager.ts";
import { replaySession } from "../storage/session-codec.ts";
import type { RunledgerLayout } from "../runtime/contracts/public.ts";
import type { Models } from "../models.ts";
import type { TraceRecorderFactory } from "../runtime/trace/composition.ts";
import { InteractiveSessionController } from "../runtime/interactive-session-controller.ts";
import { createStdlibTools } from "../runtime/tools/index.ts";
import type { HostSessionOpenRequest, HostSessionRuntime } from "./runtime-host-service.ts";
import type { ProductionManagedProcessPort } from "./runtime-host-process.ts";
import type { ProductionHostSecurity } from "./runtime-host-security.ts";

export interface ProductionHostSessionFactoryOptions {
	readonly layout: RunledgerLayout;
	readonly defaultCwd: string;
	readonly systemPrompt: string;
	readonly models: Models;
	readonly settings: ProjectSettings;
	readonly traceRecorderFactory?: TraceRecorderFactory;
	readonly processPort?: ProductionManagedProcessPort;
	readonly security?: ProductionHostSecurity;
}

export function createProductionHostSessionFactory(options: ProductionHostSessionFactoryOptions): (input: HostSessionOpenRequest) => Promise<HostSessionRuntime> {
	return async (input) => {
		const cwd = input.cwd ?? options.defaultCwd;
		const manager = await selectSessionManager(options.layout, cwd, input);
		try {
			await manager.acquireLock();
			const replay = await replaySession(manager.ledger());
			const managedProcess = options.processPort?.toolClient(manager.sessionId(), 1, "host-agent");
			const executionEnv = options.security?.createExecutionEnv({
				sessionId: manager.sessionId(),
				principalId: "principal_host-agent",
				cwd,
			});
			const tools = createStdlibTools(cwd, {
				...(managedProcess === undefined ? {} : { managedProcess }),
				...(executionEnv === undefined ? {} : { executionEnv }),
			});
			const controller = await InteractiveSessionController.create({
				cwd,
				layout: options.layout,
				systemPrompt: options.systemPrompt,
				models: options.models,
				settings: options.settings,
				replay,
				ledger: manager.ledger(),
				tools: tools.toContext(),
				overrides: {
					provider: input.provider,
					model: input.model,
					thinkingLevel: input.thinkingLevel,
				},
				traceRecorderFactory: options.traceRecorderFactory,
				executionEnv,
			});
			const removeCompletion = options.processPort?.attachCompletionAgent(
				manager.sessionId(),
				controller,
				(listener) => controller.subscribe((event) => {
					if (event.type === "agent_end") listener();
				}),
			);
			return {
				controller,
				close: async () => {
					removeCompletion?.();
					await manager.closeAll();
				},
			};
		} catch (error) {
			await manager.closeAll().catch(() => undefined);
			throw error;
		}
	};
}

async function selectSessionManager(
	layout: RunledgerLayout,
	cwd: string,
	input: HostSessionOpenRequest,
): Promise<SessionManager> {
	switch (input.mode) {
		case "create":
			return SessionManager.create({ layout, cwd, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), metadata: { cwd } });
		case "open": {
			if (input.sessionPath) return SessionManager.open(layout, input.sessionPath);
			if (!input.sessionId) throw new Error("session id required");
			const session = (await SessionManager.listAll(layout)).find((candidate) => candidate.id === input.sessionId);
			if (!session) throw new Error("session id not found");
			return SessionManager.open(layout, session.filePath);
		}
		case "continue_recent":
			return SessionManager.continueRecent(layout, cwd);
		case "resume": {
			const sessions = await SessionManager.list(layout, cwd);
			if (sessions.length === 0) return SessionManager.create({ layout, cwd, metadata: { cwd } });
			return SessionManager.open(layout, sessions[0]!.filePath);
		}
		case "fork":
			if (!input.sessionPath) throw new Error("fork source is required");
			return SessionManager.forkFrom(layout, input.sessionPath, cwd);
	}
}
