import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { describe, expect, it } from "vitest";
import { agentModePresentation, resolveAgentMode } from "../../../src/runtime/harness-profiles/agent-mode.ts";
import { minimalHarnessProfileRef, resolveHarnessProfile, standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";

describe("canonical agent modes", () => {
	it("maps default to durable standard and minimal to a new shell-only version", () => {
		expect(resolveAgentMode("default")).toEqual({ ok: true, ref: standardHarnessProfileRef() });
		const minimal = resolveAgentMode("minimal");
		expect(minimal).toMatchObject({ ok: true, ref: { id: "minimal", version: 2 } });
		if (!minimal.ok) return;
		const profile = resolveHarnessProfile(minimal.ref);
		expect(profile).toMatchObject({ ok: true, descriptor: { tools: { allowlist: ["bash"] }, multiAgent: false } });
		expect(agentModePresentation(minimal.ref)).toMatchObject({ mode: "minimal", tools: "shell" });
	});

	it("preserves legacy minimal display and rejects unsupported identities", () => {
		expect(agentModePresentation(minimalHarnessProfileRef())).toMatchObject({ mode: "minimal", tools: "bash + edit" });
		expect(resolveAgentMode("standard")).toMatchObject({ ok: false });
		expect(resolveAgentMode("review")).toMatchObject({ ok: false });
		expect(agentModePresentation({ ...standardHarnessProfileRef(), descriptorDigest: runtimeDigest("invalid") })).toBeUndefined();
	});
});
