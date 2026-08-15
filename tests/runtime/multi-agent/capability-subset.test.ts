import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createModels, createProvider } from "../../../src/models.ts";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model } from "../../../src/types.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import type { AgentTool, ToolAuthorizationPolicy } from "../../../src/runtime/types.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { InteractiveSessionController } from "../../../src/runtime/interactive-session-controller.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { MemoryLedger } from "../../../src/runtime/ledger/memory-ledger.ts";
import {
	createSessionProductionToolSource,
	deriveGovernedChildCapabilitySubset,
} from "../../../src/runtime/agents/capability-subset.ts";
import { createChildModelRuntimeFactory } from "../../../src/runtime/agents/child-model-runtime.ts";

const emptyParameters = Type.Object({}, { additionalProperties: false });

function executionEnv(): ExecutionEnv {
	return {
		cwd: "/workspace",
		fs: {
			readFile: async () => Buffer.from(""),
			writeFile: async () => undefined,
			stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
			readdir: async () => [],
			mkdir: async () => undefined,
			rm: async () => undefined,
			rename: async () => undefined,
		},
		shell: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
	};
}

function readClaim() {
	return {
		name: "repository_read" as const,
		resourceKind: "filesystem" as const,
		resourceDigest: runtimeDigest({ resource: "workspace" }),
		constraintsDigest: runtimeDigest({ access: "read" }),
		scope: "invocation" as const,
	};
}

function tool(name: string, options: { readonly readOnly?: boolean; readonly claims?: AgentTool["capabilityClaims"] } = {}): AgentTool {
	return {
		name,
		label: name,
		description: `${name} fixture`,
		parameters: emptyParameters,
		...(options.readOnly === undefined ? {} : { isReadOnly: () => options.readOnly! }),
		...(options.claims === undefined ? {} : { capabilityClaims: options.claims }),
		execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
	};
}

function allowingPolicy(): ToolAuthorizationPolicy {
	return { authorize: () => ({ decision: "allow" }) };
}

function denyingPolicy(): ToolAuthorizationPolicy {
	return { authorize: () => ({ decision: "deny", reason: "fixture policy denied the child capability" }) };
}

function model(): Model<Api> {
	return {
		id: "fixture-model",
		name: "Fixture model",
		api: "mock",
		provider: "fixture-provider",
		baseUrl: "http://fixture.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 256,
	};
}

function stopStream(requestModel: Model<Api>, _context: Context): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "fixture" }],
		api: requestModel.api,
		provider: requestModel.provider,
		model: requestModel.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

describe("governed child capability subset and model seam", () => {
	it("projects only requested read capabilities from registered production tools", async () => {
		const env = executionEnv();
		const source = createSessionProductionToolSource({
			sessionId: createRuntimeId("session", "capability-subset"),
			cwd: env.cwd,
			executionEnv: env,
			authorizationPolicy: allowingPolicy(),
			tools: [
				tool("read", { readOnly: true, claims: [readClaim()] }),
				tool("grep", { readOnly: true, claims: [readClaim()] }),
				tool("find", { readOnly: true, claims: [readClaim()] }),
				tool("glob", { readOnly: true, claims: [readClaim()] }),
				tool("ls", { readOnly: true, claims: [readClaim()] }),
				tool("write", { readOnly: false }),
				tool("bash", { readOnly: false }),
			],
		});

		const result = await deriveGovernedChildCapabilitySubset(source, ["workspace.read", "workspace.search", "workspace.list"]);

		expect(result).toMatchObject({ ok: true, value: { capabilities: ["workspace.read", "workspace.search", "workspace.list"] } });
		if (!result.ok) return;
		expect(result.value.tools.map((candidate) => candidate.name)).toEqual(["read", "grep", "find", "glob", "ls"]);
		expect(result.value.tools.map((candidate) => candidate.name)).not.toContain("write");
		expect(result.value.tools.map((candidate) => candidate.name)).not.toContain("bash");
		expect(result.value.executionEnv).toBe(env);
	});

	it("fails closed for an unregistered source, missing read-only metadata, claims, or policy admission", async () => {
		const env = executionEnv();
		const registeredMissingMetadata = createSessionProductionToolSource({
			sessionId: createRuntimeId("session", "missing-metadata"),
			cwd: env.cwd,
			executionEnv: env,
			authorizationPolicy: allowingPolicy(),
			tools: [tool("read", { claims: [readClaim()] })],
		});
		const missingMetadata = await deriveGovernedChildCapabilitySubset(registeredMissingMetadata, ["workspace.read"]);
		expect(missingMetadata).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });

		const forgedSource: unknown = {
			origin: "session-production",
			sessionId: createRuntimeId("session", "forged"),
			cwd: env.cwd,
			executionEnv: env,
			authorizationPolicy: allowingPolicy(),
			tools: [tool("read", { readOnly: true, claims: [readClaim()] })],
		};
		expect(await deriveGovernedChildCapabilitySubset(forgedSource, ["workspace.read"])).toMatchObject({
			ok: false,
			error: { code: "runtime_unavailable" },
		});

		const missingClaims = createSessionProductionToolSource({
			sessionId: createRuntimeId("session", "missing-claims"),
			cwd: env.cwd,
			executionEnv: env,
			authorizationPolicy: allowingPolicy(),
			tools: [tool("read", { readOnly: true })],
		});
		expect(await deriveGovernedChildCapabilitySubset(missingClaims, ["workspace.read"])).toMatchObject({
			ok: false,
			error: { code: "runtime_unavailable" },
		});

		const denied = createSessionProductionToolSource({
			sessionId: createRuntimeId("session", "denied"),
			cwd: env.cwd,
			executionEnv: env,
			authorizationPolicy: denyingPolicy(),
			tools: [tool("read", { readOnly: true, claims: [readClaim()] })],
		});
		expect(await deriveGovernedChildCapabilitySubset(denied, ["workspace.read"])).toMatchObject({
			ok: false,
			error: { code: "runtime_unavailable" },
		});
	});

	it("prepares a descriptor without provider effects and reuses the parent model route", async () => {
		const selected = model();
		let providerCalls = 0;
		let routeCalls = 0;
		const models = createModels();
		models.setProvider(createProvider({
			id: selected.provider,
			name: "Fixture provider",
			auth: {
				apiKey: {
					name: "fixture",
					login: async () => ({ type: "api_key", key: "fixture" }),
					check: async () => ({ source: "fixture", type: "api_key" }),
					resolve: async () => ({ auth: { apiKey: "fixture" } }),
				},
			},
			models: [selected],
			api: {
				stream: (requestModel, context) => stopStream(requestModel, context),
				streamSimple: (requestModel, context) => {
					providerCalls += 1;
					return stopStream(requestModel, context);
				},
			},
		}));
		const factory = createChildModelRuntimeFactory({
			models,
			sessionId: createRuntimeId("session", "model-factory"),
			getSelection: () => ({ model: selected, thinkingLevel: "off" }),
			modelRequestRouter: {
				route: async (request) => {
					routeCalls += 1;
					return {
						requestId: request.requestId,
						outcome: "compatible",
						targetProviderId: selected.provider,
						targetModelId: selected.id,
						targetProfileId: request.targetProfileId,
						manifestDigest: request.contextDigest,
						reasonCode: "compatible",
						diagnostics: [],
						decisionDigest: request.contextDigest,
					};
				},
			},
		});

		const prepared = await factory.prepare({
			systemPrompt: "child system",
			tools: [tool("read", { readOnly: true, claims: [readClaim()] })],
		});
		expect(prepared).toMatchObject({ ok: true, value: { descriptor: { providerId: selected.provider, modelId: selected.id } } });
		expect(providerCalls).toBe(0);
		expect(routeCalls).toBe(0);
		if (!prepared.ok) return;
		const stream = await prepared.value.streamFn(selected, { systemPrompt: "child system", messages: [], tools: prepared.value.tools });
		await stream.result();
		expect(providerCalls).toBe(1);
		expect(routeCalls).toBe(1);

		const unavailable = await createChildModelRuntimeFactory({
			models,
			sessionId: createRuntimeId("session", "model-unavailable"),
			getSelection: () => ({ model: undefined, thinkingLevel: "off" }),
		}).prepare({ systemPrompt: "child", tools: [] });
		expect(unavailable).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
	});

	it("exposes the same session-owned child model factory from the parent controller", async () => {
		const selected = model();
		const models = createModels();
		models.setProvider(createProvider({
			id: selected.provider,
			name: "Fixture provider",
			auth: {
				apiKey: {
					name: "fixture",
					login: async () => ({ type: "api_key", key: "fixture" }),
					check: async () => ({ source: "fixture", type: "api_key" }),
					resolve: async () => ({ auth: { apiKey: "fixture" } }),
				},
			},
			models: [selected],
			api: { stream: stopStream, streamSimple: stopStream },
		}));
		const controller = await InteractiveSessionController.create({
			cwd: process.cwd(),
			layout: buildRunledgerLayout(process.cwd(), "posix"),
			systemPrompt: "parent",
			models,
			settings: { provider: selected.provider, model: selected.id },
			replay: { messages: [], config: {}, auditEntries: [], warnings: [] },
			ledger: new MemoryLedger(),
			tools: [],
		});
		const result = await controller.createChildModelRuntimeFactory().prepare({ systemPrompt: "child", tools: [] });
		expect(result).toMatchObject({ ok: true, value: { descriptor: { modelId: selected.id } } });
		controller.dispose();
	});

	it("wires the registered production source and child runtime into Session Domain composition", () => {
		const source = readFileSync(join(process.cwd(), "src/runtime/session-runtime/domain.ts"), "utf8");
		expect(source).toContain("createSessionProductionToolSource");
		expect(source).toContain("const childRuntime =");
		expect(source).toContain("\n\t\tchildRuntime,");
	});
});
