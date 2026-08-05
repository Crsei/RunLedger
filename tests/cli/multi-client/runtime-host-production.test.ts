import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import {
	createLocalRuntimeHostScope,
	createProductionGitCommandPort,
	resolveLocalRuntimeHostScope,
	productionHostSocketPath,
	productionHostSpawnSpec,
} from "../../../src/cli/runtime-host-production.ts";
import { createContextAssemblySink, createProductionModelContextDomainPort } from "../../../src/cli/runtime-host.ts";
import { assembleAgentModelContext } from "../../../src/runtime/context/model-request-adapter.ts";
import type { RuntimeEventAppendInput } from "../../../src/storage/host/runtime-event-store.ts";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { JsonWorkspaceBindingStore, type PersistedWorkspaceBinding } from "../../../src/worktree/persisted-binding.ts";

describe("R3/R4 production Host composition", () => {
	it("derives one stable workspace scope and canonical socket path", () => {
		const layout = buildRunledgerLayout("/tmp/runledger-home", "posix");
		const first = createLocalRuntimeHostScope({ layout, cwd: "/workspace/project", settings: {} });
		const second = createLocalRuntimeHostScope({ layout, cwd: "/workspace/project", settings: {} });
		expect(second).toEqual(first);
		const firstSocketPath = productionHostSocketPath(layout, first.workspaceStorageKey);
		const secondSocketPath = productionHostSocketPath(layout, second.workspaceStorageKey);
		expect(firstSocketPath).toBe(secondSocketPath);
		expect(Buffer.byteLength(firstSocketPath, "utf8")).toBeLessThanOrEqual(100);
	});

	it("changes compatibility when the fixed Host settings change", () => {
		const layout = buildRunledgerLayout("/tmp/runledger-home", "posix");
		const first = createLocalRuntimeHostScope({ layout, cwd: "/workspace/project", settings: {} });
		const second = createLocalRuntimeHostScope({ layout, cwd: "/workspace/project", settings: { model: "changed" } });
		expect(second.compatibilityDigest.digest).not.toBe(first.compatibilityDigest.digest);
	});

	it("advertises the mediated Security/ExecutionGateway instead of builtin-none", () => {
		const layout = buildRunledgerLayout("/tmp/runledger-home", "posix");
		const scope = createLocalRuntimeHostScope({ layout, cwd: "/workspace/project", settings: {} });

		expect(scope.securityAdapterDigest).not.toEqual(runtimeDigest({
			permission: "none",
			approval: "none",
			sandbox: "none",
			gateway: "none",
			containment: "none",
		}));
	});

	it("spawns a detached resident Host with the complete scope bound in its environment", () => {
		const layout = buildRunledgerLayout("/tmp/runledger-home", "posix");
		const hostScope = createLocalRuntimeHostScope({ layout, cwd: "/workspace/project", settings: {} });
		const spec = productionHostSpawnSpec({
			layout,
			scope: hostScope,
			entryPath: "/opt/runledger/dist/cli/runtime-host.js",
		});
		expect(spec.command).toBe(process.execPath);
		expect(spec.args).toContain("/opt/runledger/dist/cli/runtime-host.js");
		expect(spec.env.RUNLEDGER_HOST_HOME).toBe(layout.home);
		expect(spec.env.RUNLEDGER_HOST_SCOPE).toBe(JSON.stringify(hostScope));
		expect(spec.detached).toBe(true);
		expect(spec.stdio).toEqual(["ignore", "ignore", "ignore"]);
	});

	it("passes an explicitly built peer helper only through the production Host spawn envelope", () => {
		const layout = buildRunledgerLayout("/tmp/runledger-home", "posix");
		const hostScope = createLocalRuntimeHostScope({ layout, cwd: "/workspace/project", settings: {} });
		const spec = productionHostSpawnSpec({
			layout,
			scope: hostScope,
			entryPath: "/opt/runledger/dist/cli/runtime-host.js",
			peerCredentialHelperPath: "/tmp/runledger-peer-helper",
		});
		expect(spec.env.RUNLEDGER_HOST_PEER_CREDENTIAL_HELPER).toBe("/tmp/runledger-peer-helper");
	});

	it("keeps the POSIX production socket locator within the Unix sockaddr bound", () => {
		const layout = buildRunledgerLayout(`/tmp/${"r".repeat(72)}/home`, "posix");
		const scope = createLocalRuntimeHostScope({ layout, cwd: "/workspace/project", settings: {} });
		const socketPath = productionHostSocketPath(layout, scope.workspaceStorageKey);

		expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(100);
	});

	it("discovers a persisted binding and derives the Host scope from its identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-scope-binding-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const sourceRepositoryPath = join(root, "source");
			const worktreePath = join(root, "worktree");
			const effectiveCwd = join(worktreePath, "packages", "app");
			const workspaceId = createRuntimeId("workspace", "scope-discovery-workspace");
			const worktreeId = createRuntimeId("workspace", "scope-discovery-worktree");
			const baseCommit = "a".repeat(40);
			const repositoryId = createRuntimeId("repository", runtimeDigest(sourceRepositoryPath).digest.slice(0, 48));
			const body = {
				version: 1 as const,
				binding: {
					workspaceId,
					repositoryId,
					bindingKind: "managed_worktree" as const,
					effectiveCwdDigest: runtimeDigest(effectiveCwd),
					baseCommit,
					worktreeRef: { subjectKind: "receipt" as const, digest: runtimeDigest({ worktreeId, worktreePath, baseCommit }) },
				},
				worktreeId,
				sourceRepositoryPath,
				sourceSubdir: ".",
				worktreePath,
				effectiveCwd,
				baseCommit,
				headCommit: baseCommit,
				lease: {
					workspaceId,
					ownerRuntimeId: createRuntimeId("runtime", "scope-discovery-owner"),
					leaseRevision: 4,
					fencingTokenDigest: runtimeDigest("scope-discovery-fence"),
					state: "active" as const,
					expiresAt: "2099-01-01T00:00:00.000Z",
				},
			};
			const binding: PersistedWorkspaceBinding = { ...body, bindingDigest: runtimeDigest(body) };
			const identityScope = createLocalRuntimeHostScope({ layout, cwd: effectiveCwd, settings: {}, workspaceBinding: binding });
			const store = new JsonWorkspaceBindingStore({ layout, workspaceStorageKey: identityScope.workspaceStorageKey });
			expect(await store.commit(binding)).toMatchObject({ ok: true });

			const resolved = await resolveLocalRuntimeHostScope({ layout, cwd: effectiveCwd, settings: {} });
			expect(resolved.binding).toEqual(binding);
			expect(resolved.scope.workspaceId).toBe(workspaceId);
			expect(resolved.scope.repositoryId).toBe(repositoryId);
			expect(resolved.scope.workspaceStorageKey).toBe(identityScope.workspaceStorageKey);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses an argv-only Git broker for production workspace identity probes", async () => {
		const result = await createProductionGitCommandPort().run({
			cwd: process.cwd(),
			arguments: ["rev-parse", "--show-toplevel"],
			timeoutMs: 5_000,
		});
		expect(result.exitCode).toBe(0);
		expect(result.signaled).toBe(false);
		expect(result.stdout.trim()).toContain("RunLedger");
	});

	it("composes Plan/Context/Compaction/Memory as a resident Host domain", () => {
		const layout = buildRunledgerLayout("/tmp/runledger-home", "posix");
		const scope = createLocalRuntimeHostScope({ layout, cwd: "/workspace/project", settings: {} });
		const domain = createProductionModelContextDomainPort({ layout, scope });
		expect(domain.name).toBe("model-context");
		expect(domain.mutationOperations?.has("plan.enter")).toBe(true);
		expect(domain.queryOperations?.has("memory.search")).toBe(true);
	});

	it("writes the assembled model projection through the canonical Host event writer", async () => {
		const sessionId = createRuntimeId("session", "host-context-event");
		const assembled = assembleAgentModelContext({
			model: mockModel,
			context: { systemPrompt: "policy", messages: [], tools: [] },
			turn: 1,
			sessionId,
		});
		let written: RuntimeEventAppendInput | undefined;
		const sink = createContextAssemblySink({
			authorityId: createRuntimeId("authority", "host-context-event"),
			tenantId: createRuntimeId("tenant", "host-context-event"),
			principalId: createRuntimeId("principal", "host-context-event"),
			writer: { append: async (input) => { written = input; return {} as never; } },
		});

		await sink({ sessionId, turn: 1, model: mockModel, receipt: assembled.receipt });
		expect(written).toMatchObject({ type: "context.assembled", sessionId, payload: {
			subject: { kind: "session", id: sessionId },
			effect: "committed",
			refs: [{ mediaType: "application/vnd.runledger.context-assembly+json" }],
		}});
		expect(written?.payload.metadataDigest).toBeDefined();
	});
});
