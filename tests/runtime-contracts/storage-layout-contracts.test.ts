import { describe, expect, it } from "vitest";
import {
	RUNLEDGER_DIRECTORY_MODE,
	RUNLEDGER_FILE_MODE,
	artifactRelativeLocator,
	buildRunledgerLayout,
	hostEndpointRelativeLocator,
	hostStateRelativeLocator,
	isContainedRuntimePath,
	isRuntimeLocator,
	processStateRelativeLocator,
	resolveRunledgerHomeContract,
	sessionRelativeLocator,
	traceEventRelativeLocator,
	workspaceStorageKey,
} from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

describe("RunLedger single-home storage contract", () => {
	it("uses a verified absolute override without falling back on failure", () => {
		expect(resolveRunledgerHomeContract({
			override: {
				rawValue: "/srv/runledger",
				state: "directory",
				canonicalPath: "/srv/runledger",
			},
			userHome: "/home/alice",
			pathFlavor: "posix",
		})).toEqual({ ok: true, runledgerHome: "/srv/runledger", source: "override", createDefault: false });

		expect(resolveRunledgerHomeContract({
			override: { rawValue: "/missing", state: "missing" },
			userHome: "/home/alice",
			pathFlavor: "posix",
		})).toEqual({ ok: false, code: "override_missing" });
		expect(resolveRunledgerHomeContract({
			override: { rawValue: "relative", state: "directory", canonicalPath: "/tmp/relative" },
			userHome: "/home/alice",
			pathFlavor: "posix",
		})).toEqual({ ok: false, code: "override_not_absolute" });
	});

	it("derives the default home and fixed topology with strict permission floors", () => {
		const resolution = resolveRunledgerHomeContract({ userHome: "/home/alice", pathFlavor: "posix" });
		expect(resolution).toEqual({
			ok: true,
			runledgerHome: "/home/alice/.runledger",
			source: "default",
			createDefault: true,
		});
		if (!resolution.ok) throw new Error("fixture resolution failed");

		const layout = buildRunledgerLayout(resolution.runledgerHome, "posix");
		expect(layout.settings).toBe("/home/alice/.runledger/settings.json");
		expect(layout.auth).toBe("/home/alice/.runledger/auth.json");
		expect(layout.sessions).toBe("/home/alice/.runledger/sessions");
		expect(layout.archivedSessions).toBe("/home/alice/.runledger/archived_sessions");
		expect(layout.events).toBe("/home/alice/.runledger/events");
		expect(layout.artifacts).toBe("/home/alice/.runledger/artifacts");
		expect(layout.ipc).toBe("/home/alice/.runledger/ipc");
		expect(layout.tmp).toBe("/home/alice/.runledger/tmp");
		expect(layout.database).toBe("/home/alice/.runledger/state.db");
		expect(layout.worktrees).toBe("/home/alice/.runledger/worktrees");
		expect(layout.migrationBackups).toBe("/home/alice/.runledger/migration-backup");
		expect(RUNLEDGER_DIRECTORY_MODE).toBe(0o700);
		expect(RUNLEDGER_FILE_MODE).toBe(0o600);
	});

	it("creates path-safe workspace, session, and artifact locators", () => {
		const workspace = {
			authorityId: createRuntimeId("authority", "fixture"),
			tenantId: createRuntimeId("tenant", "fixture"),
			workspaceId: createRuntimeId("workspace", "fixture"),
			repositoryId: createRuntimeId("repository", "fixture"),
		};
		const key = workspaceStorageKey(workspace);
		expect(key).toMatch(/^ws-[a-f0-9]{64}$/);
		expect(workspaceStorageKey({ ...workspace, workspaceId: createRuntimeId("workspace", "other") })).not.toBe(key);
		expect(sessionRelativeLocator(createRuntimeId("session", "fixture"), "2026-08-01T12:34:56.000Z", false)).toBe(
			"sessions/2026/08/01/session_fixture.jsonl",
		);
		expect(sessionRelativeLocator(createRuntimeId("session", "fixture"), "2026-08-01T12:34:56.000Z", true)).toBe(
			"archived_sessions/2026/08/01/session_fixture.jsonl",
		);
		expect(artifactRelativeLocator("d".repeat(64))).toBe(`artifacts/sha256/dd/${"d".repeat(64)}`);
		expect(traceEventRelativeLocator(createRuntimeId("trace", "fixture"), "2026-08-01T12:34:56.000Z")).toBe(
			"events/2026/08/01/trace_fixture.jsonl",
		);
	});

	it("rejects escapes and absolute paths in durable locators", () => {
		expect(isContainedRuntimePath("/home/alice/.runledger", "/home/alice/.runledger/sessions/a.jsonl", "posix")).toBe(true);
		expect(isContainedRuntimePath("/home/alice/.runledger", "/home/alice/.runledger-copy/a", "posix")).toBe(false);
		expect(isContainedRuntimePath("/home/alice/.runledger", "/home/alice/.runledger/../secret", "posix")).toBe(false);
		expect(isContainedRuntimePath("C:\\Users\\Alice\\.runledger", "C:\\Users\\Alice\\.runledger\\sessions\\a.jsonl", "win32")).toBe(true);
		expect(isContainedRuntimePath("C:\\Users\\Alice\\.runledger", "D:\\escape", "win32")).toBe(false);

		const locator = {
			objectKind: "session",
			objectId: createRuntimeId("session", "fixture"),
			relativeLocator: "sessions/2026/08/01/session_fixture.jsonl",
			utcShard: "2026/08/01",
		};
		expect(isRuntimeLocator(locator)).toBe(true);
		expect(isRuntimeLocator({ ...locator, relativeLocator: "../secret" })).toBe(false);
		expect(isRuntimeLocator({ ...locator, relativeLocator: "/tmp/secret" })).toBe(false);
		expect(isRuntimeLocator({ ...locator, runledgerHome: "/home/alice/.runledger" })).toBe(false);
	});

	it("derives host and process state only from safe workspace and branded IDs", () => {
		const workspaceKey = "ws-" + "a".repeat(64);
		const executionId = createRuntimeId("execution", "layout");
		const attemptId = createRuntimeId("attempt", "layout");
		expect(hostEndpointRelativeLocator(workspaceKey)).toBe(`ipc/hosts/${workspaceKey}/endpoint.json`);
		expect(hostStateRelativeLocator(workspaceKey)).toBe(`state/hosts/${workspaceKey}`);
		expect(processStateRelativeLocator(workspaceKey, executionId, attemptId)).toBe(
			`state/processes/${workspaceKey}/${executionId}/${attemptId}.json`,
		);
		expect(() => hostEndpointRelativeLocator("../escape")).toThrow();
		expect(() => processStateRelativeLocator(workspaceKey, createRuntimeId("session", "wrong"), attemptId)).toThrow();
	});
});
