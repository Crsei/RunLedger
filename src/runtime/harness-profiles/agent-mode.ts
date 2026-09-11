import { builtinHarnessProfiles } from "./builtins.ts";
import { harnessProfileDescriptorDigest } from "./resolver.ts";
/** 用户模式名称只在此映射到 frozen builtin ref。 */
import { minimalHarnessProfileRef, planHarnessProfileRef, resolveHarnessProfile, shellOnlyHarnessProfileRef, standardHarnessProfileRef } from "./resolver.ts";
import type { HarnessProfileRef } from "./types.ts";

export type AgentMode = "default" | "minimal" | "plan";
export interface AgentModePresentation {
	readonly mode: AgentMode;
	readonly tools: string;
	readonly ref: HarnessProfileRef;
}
export function isAgentMode(value: unknown): value is AgentMode {
	return value === "default" || value === "minimal" || value === "plan";
}
export function resolveAgentMode(value: unknown): { readonly ok: true; readonly ref: HarnessProfileRef } | { readonly ok: false; readonly code: string } {
	if (value === "default") return { ok: true, ref: standardHarnessProfileRef(2) };
	if (value === "minimal") return { ok: true, ref: shellOnlyHarnessProfileRef() };
	if (value === "plan") return { ok: true, ref: planHarnessProfileRef() };
	return { ok: false, code: "unsupported_agent_mode" };
}
export function agentModePresentation(ref: HarnessProfileRef): AgentModePresentation | undefined {
	if (!resolveHarnessProfile(ref).ok) return undefined;
	if (ref.id === "standard") return { mode: "default", tools: "standard", ref };
	if (ref.id === "minimal") return { mode: "minimal", tools: ref.version === minimalHarnessProfileRef().version ? "bash + edit" : "shell", ref };
	return { mode: "plan", tools: "readonly + plan", ref };
}

export function agentModeIdentityPresentation(identity: { readonly id: string; readonly version: number }): AgentModePresentation | undefined {
	const descriptor = builtinHarnessProfiles().find((entry) => entry.id === identity.id && entry.version === identity.version);
	return descriptor === undefined ? undefined : agentModePresentation({ id: descriptor.id, version: descriptor.version, descriptorDigest: harnessProfileDescriptorDigest(descriptor) });
}
export const AGENT_MODES: readonly AgentMode[] = Object.freeze(["default", "minimal", "plan"]);

/** 摘要以生产 composition 的实际工具表为依据，缺失时不推测已注册工具。 */
export function agentModeToolsSummary(presentation: AgentModePresentation, toolNames: readonly string[] | undefined): string {
	if (toolNames === undefined) return "unavailable";
	const resolved = resolveHarnessProfile(presentation.ref);
	if (!resolved.ok) return "unavailable";
	if (resolved.descriptor.tools.mode === "allowlist" && (toolNames.length !== resolved.descriptor.tools.allowlist.length
		|| toolNames.some((name, index) => name !== resolved.descriptor.tools.allowlist[index]))) return "unavailable";
	return presentation.tools;
}
