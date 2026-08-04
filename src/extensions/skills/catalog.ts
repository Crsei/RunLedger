/** Skill 的 exact/qualified resolver 与渐进披露 catalog。 */

import type { SkillDescriptor, SkillResolveResult, SkillTrigger } from "./types.ts";

function parseInvocation(value: string, explicitTrigger?: SkillTrigger): { readonly name: string; readonly argument?: string; readonly trigger: SkillTrigger } | undefined {
	const trimmed = value.trim();
	if (explicitTrigger) return trimmed ? { name: trimmed, trigger: explicitTrigger } : undefined;
	if (trimmed.startsWith("$")) {
		const [name, ...rest] = trimmed.slice(1).split(/\s+/u);
		return name ? { name, trigger: "dollar", ...(rest.length ? { argument: rest.join(" ") } : {}) } : undefined;
	}
	if (trimmed.startsWith("/skill ")) {
		const [name, ...rest] = trimmed.slice(7).trim().split(/\s+/u);
		return name ? { name, trigger: "slash-skill", ...(rest.length ? { argument: rest.join(" ") } : {}) } : undefined;
	}
	if (trimmed.startsWith("/")) {
		const [name, ...rest] = trimmed.slice(1).split(/\s+/u);
		return name ? { name, trigger: "slash-alias", ...(rest.length ? { argument: rest.join(" ") } : {}) } : undefined;
	}
	return trimmed ? { name: trimmed, trigger: "model-tool" } : undefined;
}

export class SkillCatalog {
	readonly #skills: readonly SkillDescriptor[];
	readonly #exact: ReadonlyMap<string, SkillDescriptor>;
	readonly #names: ReadonlyMap<string, readonly SkillDescriptor[]>;

	public constructor(skills: readonly SkillDescriptor[]) {
		this.#skills = [...skills].sort((left, right) => left.descriptor.identity.qualifiedId < right.descriptor.identity.qualifiedId ? -1 : left.descriptor.identity.qualifiedId > right.descriptor.identity.qualifiedId ? 1 : 0);
		this.#exact = new Map(this.#skills.map((skill) => [skill.descriptor.identity.qualifiedId, skill]));
		const names = new Map<string, SkillDescriptor[]>();
		for (const skill of this.#skills) names.set(skill.frontmatter.name, [...(names.get(skill.frontmatter.name) ?? []), skill]);
		this.#names = names;
	}

	public list(): readonly SkillDescriptor[] {
		return this.#skills;
	}

	public resolve(value: string, trigger?: SkillTrigger): SkillResolveResult {
		const parsed = parseInvocation(value, trigger);
		if (!parsed) return { ok: false, code: "invalid", message: "skill invocation is empty" };
		const exact = this.#exact.get(parsed.name);
		const candidates = exact ? [exact] : this.#names.get(parsed.name) ?? [];
		if (candidates.length === 0) return { ok: false, code: "not_found", message: `skill not found: ${parsed.name}` };
		if (candidates.length > 1) return { ok: false, code: "ambiguous", message: `skill name is ambiguous: ${parsed.name}`, candidates: candidates.map((skill) => skill.descriptor.identity.qualifiedId) };
		const skill = candidates[0];
		if (!skill) return { ok: false, code: "not_found", message: `skill not found: ${parsed.name}` };
		if (!skill.descriptor.enabled || skill.descriptor.activation !== "ready") return { ok: false, code: "blocked", message: `skill is not active: ${skill.descriptor.identity.qualifiedId}` };
		if (parsed.trigger === "model-tool" && skill.frontmatter.disableModelInvocation) return { ok: false, code: "blocked", message: `skill does not allow model invocation: ${skill.descriptor.identity.qualifiedId}` };
		return { ok: true, skill, trigger: parsed.trigger, ...(parsed.argument ? { argument: parsed.argument } : {}) };
	}
}
