import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHookConfig } from "../../src/extensions/hooks/config.ts";
import { HookDispatcher } from "../../src/extensions/hooks/dispatcher.ts";
import { HookRunner } from "../../src/extensions/hooks/runner.ts";
import type { HookDescriptor, HookEnvelope } from "../../src/extensions/hooks/types.ts";
import { RuntimeHookAdapter } from "../../src/extensions/integration/runtime-hook-adapter.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionSourceRoot, ExtensionSpillPort } from "../../src/extensions/types.ts";
import { makeExtensionTempDir, NodeTestExtensionStorage, NodeTestHookExecutor, removeExtensionTempDir, TEST_SCOPE } from "./helpers.ts";

const storage = new NodeTestExtensionStorage();
const executor = new NodeTestHookExecutor();
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function temporary(label: string): Promise<string> {
	const path = await makeExtensionTempDir(label);
	temporaryDirectories.push(path);
	return path;
}

function sourceRoot(path: string): ExtensionSourceRoot {
	return { source: "project", sourceKey: "project:hooks", rootPath: path, priority: 200 };
}

function envelope(toolName = "Read", input: unknown = { path: "before.txt" }): HookEnvelope {
	return {
		schemaVersion: 1,
		event: "PreToolUse",
		eventId: "event-hook-test",
		timestamp: "2026-07-22T00:00:00.000Z",
		sessionId: "session-hook-test",
		cwd: "/workspace",
		snapshotId: "snapshot-hook-test",
		source: "project",
		payload: { toolName, input },
	};
}

async function fixture(): Promise<{ hooks: readonly HookDescriptor[]; trust: TrustStore; root: string }> {
	const parent = await temporary("hooks");
	const root = join(parent, ".runledger");
	const hooksDir = join(root, "hooks");
	await mkdir(hooksDir, { recursive: true });
	await writeFile(join(hooksDir, "handler.mjs"), `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const envelope = JSON.parse(input);
const id = process.env.RUNLEDGER_HOOK_ID ?? "";
if (id.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 500));
if (id.includes("invalid")) process.stdout.write("not-json");
else if (id.includes("fail")) { process.stderr.write("fixture failure"); process.exitCode = 7; }
else if (id.includes("deny")) process.stdout.write(JSON.stringify({ decision: "deny", reason: "fixture denied" }));
else if (id.includes("observe")) process.stdout.write(JSON.stringify({ decision: "allow", additionalContext: JSON.stringify(envelope.payload.input) }));
else process.stdout.write(JSON.stringify({ decision: "allow", updatedInput: { path: "after.txt" }, additionalContext: "updated" }));
`);
	const declaration = (id: string, event: "PreToolUse" | "PostToolUse", timeoutMs = 2_000, failureMode?: "open" | "closed") => ({
		id,
		matcher: "^(Read|Bash)$",
		...(failureMode ? { failureMode } : {}),
		handlers: [{ type: "command", command: "node", args: ["./handler.mjs"], timeoutMs, env: { RUNLEDGER_HOOK_ID: "forged", FIXTURE: "yes" } }],
	});
	await writeFile(join(hooksDir, "hooks.json"), JSON.stringify({
		schemaVersion: 1,
		hooks: {
			PreToolUse: [declaration("update", "PreToolUse", 2_000, "open"), declaration("observe", "PreToolUse"), declaration("deny", "PreToolUse"), declaration("invalid", "PreToolUse"), declaration("fail", "PreToolUse"), declaration("slow", "PreToolUse", 20)],
			PostToolUse: [declaration("post-invalid", "PostToolUse", 2_000, "open")],
		},
	}, null, 2));
	const trust = new TrustStore(join(parent, "trust.json"), storage);
	const initial = await loadHookConfig({ configPath: join(hooksDir, "hooks.json"), root: sourceRoot(root), scope: TEST_SCOPE, trustStore: trust, storage });
	for (const hook of initial.hooks) {
		await trust.grant({ identity: hook.descriptor.identity, canonicalPath: hook.descriptor.sourcePath, binding: hook.descriptor.manifest, principalId: TEST_SCOPE.principalId, scope: "project" });
	}
	const loaded = await loadHookConfig({ configPath: join(hooksDir, "hooks.json"), root: sourceRoot(root), scope: TEST_SCOPE, trustStore: trust, storage });
	return { hooks: loaded.hooks, trust, root };
}

function named(hooks: readonly HookDescriptor[], name: string): HookDescriptor {
	const hook = hooks.find((item) => item.descriptor.displayName === name);
	if (!hook) throw new Error(`missing hook fixture: ${name}`);
	return hook;
}

describe("Hook parser, runner and Runtime adapter", () => {
	it("compiles matchers, protects reserved environment, and prevents project hooks from weakening blocking failure mode", async () => {
		const { hooks } = await fixture();
		const update = named(hooks, "update");
		expect(update.failureMode).toBe("closed");
		expect(update.matcherRegex?.test("Read")).toBe(true);
		expect(update.handlers[0]?.env).toEqual({ FIXTURE: "yes" });
		expect(update.descriptor.capabilities[0]?.boundary.kind).toBe("process");
	});

	it("executes allow, deny, invalid JSON, nonzero, timeout and abort outcomes through an authorized executor", async () => {
		const { hooks } = await fixture();
		const runner = new HookRunner({ executor });
		const allowed = await runner.run(named(hooks, "update"), named(hooks, "update").handlers[0]!, envelope());
		expect(allowed).toMatchObject({ status: "allowed", decision: "allow", updatedInput: { path: "after.txt" }, additionalContext: "updated" });
		const denied = await runner.run(named(hooks, "deny"), named(hooks, "deny").handlers[0]!, envelope("Bash"));
		expect(denied).toMatchObject({ status: "denied", decision: "deny", reason: "fixture denied" });
		const invalid = await runner.run(named(hooks, "invalid"), named(hooks, "invalid").handlers[0]!, envelope());
		expect(invalid).toMatchObject({ status: "failed", decision: "deny" });
		const failed = await runner.run(named(hooks, "fail"), named(hooks, "fail").handlers[0]!, envelope());
		expect(failed).toMatchObject({ status: "failed", decision: "deny", exitCode: 7 });
		const timedOut = await runner.run(named(hooks, "slow"), named(hooks, "slow").handlers[0]!, envelope());
		expect(timedOut).toMatchObject({ status: "timed_out", decision: "deny" });
		const controller = new AbortController();
		const aborting = runner.run(named(hooks, "slow"), { ...named(hooks, "slow").handlers[0]!, timeoutMs: 2_000 }, envelope(), controller.signal);
		controller.abort("test");
		expect(await aborting).toMatchObject({ status: "aborted", decision: "deny" });
	});

	it("spills bounded input and fails closed when spill or executor is unavailable", async () => {
		const { hooks } = await fixture();
		const update = named(hooks, "update");
		const oversized = envelope("Read", { text: "x".repeat(300_000) });
		expect(await new HookRunner({ executor }).run(update, update.handlers[0]!, oversized)).toMatchObject({ status: "failed", decision: "deny" });
		const spills: string[] = [];
		const spill: ExtensionSpillPort = {
			write: async (kind, bytes) => {
				spills.push(kind);
				return { relativePath: `spill/${kind}`, digest: String(bytes.byteLength), bytes: bytes.byteLength };
			},
		};
		const spilled = await new HookRunner({ executor, spill }).run(update, update.handlers[0]!, oversized);
		expect(spilled.status).toBe("allowed");
		expect(spilled.inputSpill?.bytes).toBeGreaterThan(256 * 1024);
		expect(spills).toContain("hook-input");
		expect(await new HookRunner({}).run(update, update.handlers[0]!, envelope())).toMatchObject({ status: "failed", decision: "deny" });
	});

	it("applies updated input serially and revalidates plus reauthorizes before execution", async () => {
		const { hooks } = await fixture();
		const dispatcher = new HookDispatcher([named(hooks, "update"), named(hooks, "observe")], new HookRunner({ executor }));
		const calls: string[] = [];
		const adapter = new RuntimeHookAdapter(dispatcher, {
			validateAndCanonicalize: async (input) => {
				calls.push("validate");
				return { ok: true as const, value: input };
			},
			reauthorize: async () => {
				calls.push("authorize");
				return { ok: true as const };
			},
		});
		const result = await adapter.dispatch(envelope());
		expect(result).toMatchObject({ ok: true, input: { path: "after.txt" } });
		if (result.ok) expect(result.additionalContext).toContain('{"path":"after.txt"}');
		expect(calls).toEqual(["validate", "authorize"]);
		const deniedAdapter = new RuntimeHookAdapter(dispatcher, {
			validateAndCanonicalize: async () => ({ ok: false as const, reason: "schema" }),
			reauthorize: async () => ({ ok: true as const }),
		});
		expect(await deniedAdapter.dispatch(envelope())).toMatchObject({ ok: false, reason: expect.stringContaining("schema validation") });
	});
});
