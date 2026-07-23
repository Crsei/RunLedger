import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const daemonMocks = vi.hoisted(() => ({
	startLocalV3Daemon: vi.fn(),
}));

vi.mock("../../src/daemon/local-v3-daemon.ts", () => ({
	startLocalV3Daemon: daemonMocks.startLocalV3Daemon,
}));

import {
	DAEMON_USAGE,
	daemonMain,
	parseDaemonArgs,
} from "../../src/daemon/stdio-cli.ts";

const roots: string[] = [];

beforeEach(() => {
	daemonMocks.startLocalV3Daemon.mockReset();
	daemonMocks.startLocalV3Daemon.mockResolvedValue({
		ok: false,
		error: { code: "adapter_unavailable", message: "fixture stop", retryable: false },
		effect: "none",
	});
});

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function daemonProject(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-daemon-cli-"));
	roots.push(root);
	await mkdir(join(root, ".runledger"), { recursive: true });
	await writeFile(join(root, ".runledger", "settings.json"), JSON.stringify({
		runtimeFeatures: {
			sessionV3: true,
			workspaceContracts: true,
			securityContracts: true,
			workspaceGuard: true,
			capabilityGateway: true,
			sandboxEnforcement: true,
			artifactCas: true,
			resourceContracts: true,
			planContextMemoryContracts: true,
			orchestrator: true,
			verification: true,
			daemon: true,
		},
	}), "utf8");
	return root;
}

describe("runledger-daemon state-root CLI", () => {
	it("documents and parses an explicit deployment state root", () => {
		expect(DAEMON_USAGE).toContain("--state-root <path>");
		expect(parseDaemonArgs(["--state-root", "/srv/runledger/state"])).toMatchObject({
			args: { stateRoot: "/srv/runledger/state" },
		});
		expect(parseDaemonArgs(["--state-root"])).toEqual({ error: "--state-root requires a path" });
	});

	it("passes the explicit root to the local daemon startup boundary", async () => {
		const cwd = await daemonProject();
		const stateRoot = join(cwd, "deployment-state");
		const code = await daemonMain(
			["--cwd", cwd, "--state-root", stateRoot],
			{ input: new PassThrough(), output: new PassThrough(), error: new PassThrough() },
		);

		expect(code).toBe(1);
		expect(daemonMocks.startLocalV3Daemon).toHaveBeenCalledOnce();
		expect(daemonMocks.startLocalV3Daemon.mock.calls[0]?.[0]).toMatchObject({
			cwd,
			startupExternalReceiptStateRoot: stateRoot,
		});
	});
});
