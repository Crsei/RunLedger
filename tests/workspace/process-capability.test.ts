/** 纯 process capability descriptor 测试：三平台 Shell/termination/cleanup 契约（P3，不 spawn）。 */

import { describe, expect, it } from "vitest";
import { processCapabilityFor } from "../../src/workspace/process-capability.ts";

describe("Linux capability (P1 evidence verified)", () => {
	const capability = processCapabilityFor("linux");

	it("declares bash/sh/zsh with -lc / -c launch args", () => {
		expect(capability.shells.map((s) => s.id)).toEqual(["bash", "sh", "zsh"]);
		expect(capability.shells.find((s) => s.id === "bash")?.launchArgs).toEqual(["-lc"]);
		expect(capability.shells.find((s) => s.id === "sh")?.launchArgs).toEqual(["-c"]);
	});

	it("marks process_group termination and one-shot cleanup as verified", () => {
		expect(capability.termination).toEqual({ strategy: "process_group", evidence: "verified" });
		expect(capability.cleanup).toEqual({ maxAttempts: 1, backoffMs: 0, evidence: "verified" });
	});

	it("selects the default shell from the env shell hint", () => {
		expect(processCapabilityFor("linux", { shell: "/usr/bin/zsh" }).defaultShellId).toBe("zsh");
		expect(processCapabilityFor("linux", { shell: "/bin/bash" }).defaultShellId).toBe("bash");
		expect(processCapabilityFor("linux").defaultShellId).toBe("sh");
	});
});

describe("macOS capability (real runner evidence pending)", () => {
	const capability = processCapabilityFor("macos");

	it("declares zsh default with unverified process semantics", () => {
		expect(capability.defaultShellId).toBe("zsh");
		expect(capability.shells[0]).toMatchObject({ id: "zsh", executableCandidates: ["zsh", "/bin/zsh"] });
		expect(capability.termination.evidence).toBe("unverified");
		expect(capability.cleanup.evidence).toBe("unverified");
	});

	it("keeps platform claims honest: no verified markers before real runners", () => {
		expect(capability.termination).not.toEqual({ strategy: "process_group", evidence: "verified" });
	});
});

describe("Windows capability (real runner evidence pending)", () => {
	const capability = processCapabilityFor("windows", { comspec: "C:\\Windows\\System32\\cmd.exe", pathext: ".EXE;.CMD;.BAT" });

	it("declares pwsh/cmd/git-bash and PATHEXT-driven resolution", () => {
		expect(capability.shells.map((s) => s.id)).toEqual(["pwsh", "cmd", "git-bash"]);
		expect(capability.pathExt).toEqual([".EXE", ".CMD", ".BAT"]);
		expect(capability.shells.find((s) => s.id === "pwsh")?.launchArgs).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
		expect(capability.shells.find((s) => s.id === "git-bash")?.pathTranslation).toBe("msys");
	});

	it("selects pwsh when comspec hints PowerShell, cmd otherwise", () => {
		expect(processCapabilityFor("windows", { comspec: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }).defaultShellId).toBe("pwsh");
		expect(processCapabilityFor("windows").defaultShellId).toBe("cmd");
	});

	it("declares process-tree termination with explicit taskkill argv, unverified", () => {
		expect(capability.termination).toEqual({ strategy: "process_tree", treeKillArgs: ["taskkill", "/T", "/F", "/PID"], evidence: "unverified" });
		expect(capability.cleanup).toEqual({ maxAttempts: 3, backoffMs: 200, evidence: "unverified" });
	});
});
