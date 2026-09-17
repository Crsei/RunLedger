/**
 * 扩展动作 actor port 的直接单测（P5 交付的最后一个缺口）。
 *
 * 生产组合注入晚绑定的 controller 面；这里用受控替身直接驱动 port，覆盖：
 * 三个有真实命令面的动作、四个带原因的显式拒绝、以及"持有者尚未绑定"的路径。
 */

import { describe, expect, it } from "vitest";
import { createExtensionActionActorPort } from "../../../src/runtime/session-runtime/extension-composition.ts";
import type { SessionExtensionActionHost } from "../../../src/runtime/session-runtime/extension-composition.ts";

interface Recorder {
	readonly calls: string[];
	readonly host: SessionExtensionActionHost;
	readonly audits: Array<{ readonly eventType: string; readonly payload: Record<string, unknown> }>;
}

function recorder(overrides: Partial<SessionExtensionActionHost> = {}): Recorder {
	const calls: string[] = [];
	const host: SessionExtensionActionHost = {
		prompt: async (text, behavior, origin) => { calls.push(`prompt:${text}:${behavior}:${origin}`); },
		setThinkingLevel: async (level) => { calls.push(`thinking:${level}`); return level; },
		getAvailableModels: async (provider) => {
			calls.push(`models:${provider ?? "*"}`);
			return [{ id: "gpt", provider: "openai" }, { id: "claude", provider: "anthropic" }];
		},
		selectModel: async (model) => { calls.push(`select:${JSON.stringify(model)}`); },
		...overrides,
	};
	return { calls, host, audits: [] };
}

function port(rec: Recorder | undefined, bound = true) {
	const audits: Array<{ readonly eventType: string; readonly payload: Record<string, unknown> }> = [];
	const actor = createExtensionActionActorPort({
		host: () => (bound ? rec?.host : undefined),
		audit: async (eventType, payload) => { audits.push({ eventType, payload }); },
	});
	return { actor, audits };
}

describe("extension action actor port", () => {
	it("queues messages with origin runtime so an extension cannot impersonate the user", async () => {
		const rec = recorder();
		const { actor } = port(rec);
		await expect(actor.sendMessage({ text: "hello", origin: "extension" })).resolves.toEqual({ ok: true, value: { queued: "follow-up", origin: "runtime" } });
		expect(rec.calls).toEqual(["prompt:hello:followUp:runtime"]);
	});

	it("selects an exactly matching model and refuses an unknown pair", async () => {
		const rec = recorder();
		const { actor } = port(rec);
		await expect(actor.setModel({ providerId: "openai", modelId: "gpt" })).resolves.toEqual({ ok: true, value: { providerId: "openai", modelId: "gpt" } });
		expect(rec.calls).toContain('select:{"id":"gpt","provider":"openai"}');

		// 型号存在但 provider 不匹配 → 不模糊匹配、不选任何东西。
		const mismatch = await actor.setModel({ providerId: "anthropic", modelId: "gpt" });
		expect(mismatch.ok).toBe(false);
		if (!mismatch.ok) expect(mismatch.code).toBe("model_unavailable");
		const unknown = await actor.setModel({ providerId: "ghost", modelId: "ghost" });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.code).toBe("model_unavailable");
		expect(rec.calls.filter((call) => call.startsWith("select:"))).toHaveLength(1);
	});

	it("applies the thinking level and reports what actually took effect", async () => {
		const rec = recorder({ setThinkingLevel: async () => "high" });
		const { actor } = port(rec);
		await expect(actor.setThinkingLevel({ level: "high" })).resolves.toEqual({ ok: true, value: { level: "high" } });

		// controller 报告被夹到别的档位时，回执反映的是**实际**生效值。
		const clamped = recorder({ setThinkingLevel: async () => "off" });
		await expect(port(clamped).actor.setThinkingLevel({ level: "max" })).resolves.toEqual({ ok: true, value: { level: "off" } });
	});

	it("keeps intents as projections and records their text as a digest only", async () => {
		const { actor, audits } = port(recorder());
		await expect(actor.emitIntent({ intent: { kind: "status", level: "info", key: "phase", text: "running" } }))
			.resolves.toEqual({ ok: true, value: { projected: "audit-only" } });
		expect(audits[0]?.eventType).toBe("extension.intent");
		expect(audits[0]?.payload.textDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(JSON.stringify(audits[0])).not.toContain("running");
	});

	it("refuses the four unwired actions with a specific reason each", async () => {
		const { actor, audits } = port(recorder());
		const expectations: ReadonlyArray<readonly [string, () => Promise<{ readonly ok: boolean } & Record<string, unknown>>, RegExp]> = [
			["setActiveTools", () => actor.setActiveTools({ names: ["tool_a"] }), /active-tool setter/u],
			["setSessionName", () => actor.setSessionName({ name: "x" }), /title mutation/u],
			["exec", () => actor.exec({ command: "ls" }), /governed managed process/u],
			["appendEntry", () => actor.appendEntry({ entry: { note: "x" } }), /ledger surface/u],
		];
		for (const [name, call, reason] of expectations) {
			const result = await call();
			expect(result.ok, name).toBe(false);
			if (!result.ok) {
				expect(result.code, name).toBe("session_command_unavailable");
				expect(String(result.message), name).toMatch(reason);
			}
		}
		// appendEntry 仍然留下审计，但只记键名。
		const appendAudit = audits.find((entry) => entry.eventType === "extension.action.append_entry");
		expect(appendAudit?.payload.keys).toEqual(["note"]);
		expect(JSON.stringify(appendAudit)).not.toContain("\"note\":");
	});

	it("reports unavailable for the wired actions until the holder is bound", async () => {
		const { actor } = port(recorder(), false);
		for (const call of [() => actor.sendMessage({ text: "x", origin: "extension" }), () => actor.setModel({ providerId: "a", modelId: "b" }), () => actor.setThinkingLevel({ level: "off" })]) {
			const result = await call();
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("session_command_unavailable");
		}
	});
});
