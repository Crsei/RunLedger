import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../src/runtime/contracts/public.ts";
import { builtinSecurityProfile } from "../../src/security/config/presets.ts";
import { CIRCUIT_BREAKER_RULE, PermissionEngine } from "../../src/security/permission/engine.ts";
import { analyzeShellCommand } from "../../src/security/permission/shell-analyzer.ts";
import { securityRejectionSummary } from "../../src/security/rejection-summary.ts";
import type { SecuritySnapshot } from "../../src/security/types.ts";

function snapshot(): SecuritySnapshot {
	return {
		profile: builtinSecurityProfile("danger-full-access")!,
		filesystem: { readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [], protectedPaths: ["/repo/.git"] },
		policyControlPaths: ["/home/test/.runledger/settings.json", "/etc/runledger/security.json"],
		homeDirectories: ["/home/test"],
		rules: [], sources: ["builtin"], workspaceRoot: "/repo", tempRoot: "/tmp/runledger",
		policyDigest: runtimeDigest("full-access-policy-test"), createdAt: "2026-09-07T00:00:00.000Z",
	};
}

function evaluate(command: string, policy = snapshot()) {
	return new PermissionEngine().evaluate([{ kind: "shell", command, cwd: "/repo", analysis: analyzeShellCommand(command).analysis }], policy);
}

describe("Full Access with independent safety boundaries", () => {
	it.each([
		'wc -l tests/manual/development-cases/*.py tests/manual/development-cases/*.json 2>/dev/null; echo "---"; head -50 tests/manual/development-cases/prompts.json',
		'git status --short | while read -r p; do if [ -d "$p" ]; then find "$p" -type f; fi; done',
		"npm test", "python3 script.py", "bash -lc 'npm run check'", "rm -rf ./build", "rm -rf .",
		"git push", "chmod +x scripts/check.sh", "echo 'rm -rf /'", "fdisk -l /dev/sda",
		"cat /home/test/.runledger/settings.json", "echo /home/test/.runledger/settings.json",
		"rg permission /home/test/.runledger/settings.json", "find /home/test -type f", "git -C / status",
	])("allows ordinary commands without relying on the legacy allowlist: %s", (command) => {
		expect(evaluate(command).decision).toBe("allow");
	});

	// 这里只做纯判定，任何测试都不能将这些命令交给真实进程入口。
	it.each([
		"rm -rf /", "rm -fr -- //", "rm --recursive /tmp/..", "rm -rf /*",
		'rm -rf "$HOME"', 'rm -rf "${HOME}/"', "rm -rf ~", "rm -rf ~/", "rm -rf /home/test",
		"sudo -u root rm -rf /", "command rm -rf /", "exec /bin/rm -rf /",
		"bash -lc 'rm -rf /'", "echo $(rm -rf /)", 'echo "$(rm -rf /)"', "echo `reboot`",
		"eval 'rm -rf /'", "nohup rm -rf /", "busybox rm -rf /", "xargs -n 1 rm -rf /", "find / -delete", "sudo systemctl reboot", 'rm -rf "$HOME/."',
		"(rm -rf /)", "if true; then rm -rf /; fi",
		"mkfs.ext4 /dev/sda", "wipefs /dev/sda", "fdisk /dev/sda", "sfdisk --delete /dev/sda",
		"shutdown -h now", "reboot", "poweroff",
	])("requires explicit confirmation despite Full Access / never: %s", (command) => {
		const result = evaluate(command);
		expect(result.decision).toBe("ask");
		expect(result.requestDecisions[0]?.matchedRuleIds).toContain(CIRCUIT_BREAKER_RULE);
	});

	it.each(["user", "managed"] as const)("keeps %s deny stronger than ordinary access and circuit confirmation", (source) => {
		const policy = { ...snapshot(), rules: [{ id: "explicit-deny", kind: "shell" as const, action: "deny" as const, pattern: "*", source }] };
		expect(evaluate("npm test", policy).decision).toBe("deny");
		expect(evaluate("rm -rf /", policy).decision).toBe("deny");
	});

	it("does not let an allow rule dismiss the circuit breaker", () => {
		const policy = { ...snapshot(), rules: [{ id: "allow", kind: "shell" as const, action: "allow" as const, pattern: "*", source: "user" as const }] };
		expect(evaluate("reboot", policy).decision).toBe("ask");
	});

	it("retains ordinary never semantics outside Full Access and administrator-required AST classification", () => {
		const policy = snapshot();
		expect(evaluate("python3 script.py", { ...policy, profile: { ...policy.profile, name: "custom" } }).decision).toBe("deny");
		expect(evaluate("python3 script.py", { ...policy, bashAnalyzer: { mode: "ast", source: "managed", configDigest: "0".repeat(64) } }).decision).toBe("deny");
	});

	it.each([
		"echo '{}' > /home/test/.runledger/settings.json",
		"sed -i 's/deny/allow/g' /home/test/.runledger/settings.json",
		"mv /tmp/proposed /home/test/.runledger/settings.json",
		"rm /etc/runledger/security.json",
		'echo "{}" > "$HOME/.runledger/settings.json"',
		"cp /tmp/proposed ~/.runledger/settings.json",
		"python3 -c 'open(\"/home/test/.runledger/settings.json\",\"w\").write(\"{}\")'",
		"reboot; echo '{}' > /home/test/.runledger/settings.json",
		"rm -rf /; echo '{}' > /home/test/.runledger/settings.json",
	])("rejects identifiable shell changes to its own security policy: %s", (command) => {
		expect(evaluate(command)).toMatchObject({ decision: "deny", requestDecisions: [{ matchedRuleIds: ["builtin-policy-control"] }] });
	});

	it("allows policy reads but rejects direct writes and parent replacement even under an allow rule", () => {
		const policy = snapshot();
		const engine = new PermissionEngine();
		expect(engine.evaluate([{ kind: "filesystem", operation: "read", path: "/home/test/.runledger/settings.json" }], policy).decision).toBe("allow");
		for (const path of ["/home/test/.runledger/settings.json", "/home/test/.runledger"]) {
			expect(engine.evaluate([{ kind: "filesystem", operation: "write", path }], { ...policy, rules: [{ id: "allow", kind: "filesystem", action: "allow", pattern: "*", source: "user" }] }).decision).toBe("deny");
		}
	});

	it("does not expose arbitrary underlying errors in the rejection summary", () => {
		expect(securityRejectionSummary({ code: "policy_denied", message: "private secret in an approval response", retryable: false })).not.toContain("private secret");
		expect(securityRejectionSummary({ code: "policy_denied", message: "approval policy never converted ask to deny: shell syntax could not be safely classified", retryable: false })).toContain("Shell syntax could not be safely classified");
	});
});
