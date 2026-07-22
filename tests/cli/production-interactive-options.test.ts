import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "../../src/models.ts";
import {
	ProductionInteractiveAdaptersUnavailableError,
	REQUIRED_PRODUCTION_INTERACTIVE_ADAPTERS,
	createCliProductionInteractiveOptions,
	productionInteractiveWorkspaceStateRoot,
	productionInteractiveControllerBindings,
	type ProductionInteractiveAdapterOptions,
	type ProductionInteractiveOptionsProvider,
} from "../../src/cli/production-interactive-options.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../src/runtime/runtime-features.ts";
import type { AgentTool } from "../../src/runtime/types.ts";
import type { ProductionInteractiveRuntime } from "../../src/storage/production-interactive-runtime.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";

const roots: string[] = [];
const managers: V3SessionManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sessionFixture() {
	const cwd = await mkdtemp(join(tmpdir(), "runledger-cli-production-"));
	roots.push(cwd);
	const manager = await V3SessionManager.create({
		cwd,
		sessionDir: join(cwd, "sessions"),
		features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
	});
	managers.push(manager);
	return { cwd, manager, models: createModels() };
}

function provider(
	providerId: string,
	create: ProductionInteractiveOptionsProvider["create"],
	workspaceStateRoot = "/runledger-production-state",
): ProductionInteractiveOptionsProvider {
	return {
		implementation: "production",
		providerId,
		evidenceDigest: canonicalDigest({ providerId, contract: "production-interactive-options" }),
		workspaceStateRoot,
		create,
	};
}

function providerWithStateRoot(
	providerId: string,
	workspaceStateRoot: string,
	create: ProductionInteractiveOptionsProvider["create"],
): ProductionInteractiveOptionsProvider {
	return provider(providerId, create, workspaceStateRoot);
}

describe("CLI production interactive options", () => {
	it("fails closed with the complete missing-adapter inventory", async () => {
		const fixture = await sessionFixture();
		const pending = createCliProductionInteractiveOptions(fixture);
		await expect(pending).rejects.toBeInstanceOf(ProductionInteractiveAdaptersUnavailableError);
		await expect(pending).rejects.toMatchObject({
			code: "production_interactive_adapters_unavailable",
			missingAdapters: REQUIRED_PRODUCTION_INTERACTIVE_ADAPTERS,
		});
		expect(fixture.manager.isClosed()).toBe(false);
	});

	it("rejects test or in-memory provider identities before invoking them", async () => {
		const fixture = await sessionFixture();
		let invoked = false;
		const invalid = provider("runledger-memory-test-provider", () => {
			invoked = true;
			return {} as ProductionInteractiveAdapterOptions;
		});
		await expect(createCliProductionInteractiveOptions(fixture, invalid)).rejects.toBeInstanceOf(
			ProductionInteractiveAdaptersUnavailableError,
		);
		expect(invoked).toBe(false);
	});

	it("pins manager and models to the active CLI session before downstream probes", async () => {
		const fixture = await sessionFixture();
		const workspaceStateRoot = join(fixture.cwd, "state");
		const adapters = {
			tools: [],
			workspace: { stateRoot: workspaceStateRoot },
		} as unknown as ProductionInteractiveAdapterOptions;
		const resolved = await createCliProductionInteractiveOptions(
			fixture,
			provider("runledger-local-production", () => adapters, workspaceStateRoot),
		);
		expect(resolved.manager).toBe(fixture.manager);
		expect(resolved.models).toBe(fixture.models);
	});

	it("rejects a provider whose created workspace adapter drifts from its admitted state root", async () => {
		const fixture = await sessionFixture();
		const admittedRoot = join(fixture.cwd, "admitted-state");
		const drifted = {
			tools: [],
			workspace: { stateRoot: join(fixture.cwd, "different-state") },
		} as unknown as ProductionInteractiveAdapterOptions;
		await expect(createCliProductionInteractiveOptions(
			fixture,
			providerWithStateRoot("runledger-local-production", admittedRoot, () => drifted),
		)).rejects.toThrow("workspace state root");
	});

	it("pins the provider root value across admission and create", async () => {
		const fixture = await sessionFixture();
		const admittedRoot = join(fixture.cwd, "admitted-state");
		let exposedRoot = admittedRoot;
		let invoked = false;
		const mutableProvider = providerWithStateRoot("runledger-local-production", admittedRoot, () => {
			invoked = true;
			return { tools: [] } as unknown as ProductionInteractiveAdapterOptions;
		});
		Object.defineProperty(mutableProvider, "workspaceStateRoot", {
			configurable: true,
			get: () => exposedRoot,
		});
		const pinnedRoot = productionInteractiveWorkspaceStateRoot(mutableProvider);
		exposedRoot = join(fixture.cwd, "drifted-state");

		await expect(createCliProductionInteractiveOptions(
			fixture,
			mutableProvider,
			pinnedRoot,
		)).rejects.toThrow("changed after admission");
		expect(invoked).toBe(false);
	});

	it("projects every governed controller binding by identity, including extension reload tools", () => {
		const baseTools = [{ name: "base" }] as AgentTool[];
		const reloadedTools = [{ name: "reloaded" }] as AgentTool[];
		const beforeToolCall = async () => undefined;
		const afterToolCall = async () => undefined;
		const prepareModelRequest = async () => undefined;
		const toolExecutionGateway = {};
		const sessionEvents = {};
		const toolResultArtifactSink = {};
		const extensionRuntime = {};
		const runtime = {
			cwd: "/production/worktree",
			sessionId: "session_fixture",
			tools: baseTools,
			beforeToolCall,
			afterToolCall,
			prepareModelRequest,
			toolExecutionGateway,
			sessionEvents,
			toolResultArtifactSink,
			extensionRuntime,
			toolRegistry: { toContext: () => reloadedTools },
		} as unknown as ProductionInteractiveRuntime;

		const bindings = productionInteractiveControllerBindings(runtime);
		expect(bindings).toMatchObject({ cwd: runtime.cwd, sessionId: runtime.sessionId });
		expect(bindings.tools).toBe(baseTools);
		expect(bindings.beforeToolCall).toBe(beforeToolCall);
		expect(bindings.afterToolCall).toBe(afterToolCall);
		expect(bindings.prepareModelRequest).toBe(prepareModelRequest);
		expect(bindings.toolExecutionGateway).toBe(toolExecutionGateway);
		expect(bindings.sessionEvents).toBe(sessionEvents);
		expect(bindings.toolResultArtifactSink).toBe(toolResultArtifactSink);
		expect(bindings.extensionLifecycle).toBe(extensionRuntime);
		expect(bindings.toolProvider?.()).toBe(reloadedTools);
	});
});
