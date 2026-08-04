import { describe, expect, it } from "vitest";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import {
	createLocalRuntimeHostScope,
	productionHostSocketPath,
	productionHostSpawnSpec,
} from "../../../src/cli/runtime-host-production.ts";

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
});
