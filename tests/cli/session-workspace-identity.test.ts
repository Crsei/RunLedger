import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionId } from "../../src/cli/main.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { SessionStore, type SessionCatalogRecord } from "../../src/storage/session-store/session-store.ts";
import { rmSyncRetry } from "../helpers/cleanup.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSyncRetry(directory);
});

function openStore(root: string): SessionStore {
	const database = openSessionDatabase(join(root, "state.db"));
	installSessionStoreSchema(database);
	return new SessionStore(database);
}

function args(argv: readonly string[]) {
	const parsed = parseArgs(argv);
	expect(parsed.error).toBeUndefined();
	return parsed.args;
}

describe("CLI session workspace identity", () => {
	it("persists a canonical source workspace locator on create", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-session-workspace-"));
		temporaryDirectories.push(root);
		const workspace = join(root, "workspace-a");
		mkdirSync(workspace);
		const store = openStore(root);

		const sessionId = await resolveSessionId(store, args([]), workspace);
		const record = store.getSession(sessionId) as SessionCatalogRecord & { readonly sourceWorkspaceLocator?: string };

		expect(record.workspaceId).not.toBe("workspace_default");
		expect(record.repositoryId).not.toBe("repository_default");
		expect(JSON.parse(record.sourceWorkspaceLocator ?? "null")).toMatchObject({
			version: 1,
			workspaceKey: expect.stringMatching(/^[a-f0-9]{64}$/),
			rootLocator: { path: workspace },
			repositoryLocator: { path: workspace },
		});
		store.database().close();
	});

	it("fails closed when resume selects a Session from another workspace", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-session-workspace-"));
		temporaryDirectories.push(root);
		const workspaceA = join(root, "workspace-a");
		const workspaceB = join(root, "workspace-b");
		mkdirSync(workspaceA);
		mkdirSync(workspaceB);
		const store = openStore(root);
		await resolveSessionId(store, args([]), workspaceA);

		await expect(resolveSessionId(store, args(["--resume"]), workspaceB)).rejects.toThrow("workspace binding");
		store.database().close();
	});

	it("fails closed when explicit open targets a Session from another workspace", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-session-workspace-"));
		temporaryDirectories.push(root);
		const workspaceA = join(root, "workspace-a");
		const workspaceB = join(root, "workspace-b");
		mkdirSync(workspaceA);
		mkdirSync(workspaceB);
		const store = openStore(root);
		const sessionId = await resolveSessionId(store, args([]), workspaceA);

		await expect(resolveSessionId(store, args(["--session-id", sessionId]), workspaceB)).rejects.toThrow("workspace binding");
		store.database().close();
	});
});
