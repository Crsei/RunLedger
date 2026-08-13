/** 有界、稳定且不注入 Skill 正文的 catalog renderer。 */

import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type { SkillDescriptor } from "./types.ts";

function clip(value: string, max: number): string {
	if (max <= 0) return "";
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function renderSkillCatalog(
	skills: readonly SkillDescriptor[],
	options: { readonly maxChars?: number; readonly modelContextChars?: number } = {},
): string {
	const contextBudget = Math.floor((options.modelContextChars ?? Number.MAX_SAFE_INTEGER) * 0.02);
	const maxChars = Math.max(0, Math.min(options.maxChars ?? DEFAULT_EXTENSION_LIMITS.maxCatalogChars, contextBudget));
	if (maxChars === 0) return "";
	const active = [...skills]
		.filter((skill) => skill.descriptor.enabled && skill.frontmatter.disableModelInvocation !== true)
		.sort((left, right) => left.descriptor.identity.qualifiedId < right.descriptor.identity.qualifiedId ? -1 : left.descriptor.identity.qualifiedId > right.descriptor.identity.qualifiedId ? 1 : 0);
	const header = "Skills: pass exactly name or qualifiedId to Skill; never combine values.\n";
	if (header.length >= maxChars) return clip(header, maxChars);
	const minimumRows = active.map((skill) => `- name=${skill.frontmatter.name};qualifiedId=${skill.descriptor.identity.qualifiedId}\n`);
	const minimumLength = minimumRows.reduce((sum, row) => sum + row.length, header.length);
	const descriptionBudget = Math.max(0, maxChars - minimumLength);
	const perSkill = active.length > 0 ? Math.floor(descriptionBudget / active.length) : 0;
	let output = header;
	for (let index = 0; index < active.length; index += 1) {
		const skill = active[index];
		if (!skill) continue;
		const suffix = perSkill > 2 ? `;${clip(skill.frontmatter.description.replace(/\s+/gu, " "), perSkill - 1)}` : "";
		const row = `- name=${skill.frontmatter.name};qualifiedId=${skill.descriptor.identity.qualifiedId}${suffix}\n`;
		if (output.length + row.length > maxChars) {
			const remaining = maxChars - output.length;
			if (remaining > 0) output += clip(row, remaining);
			break;
		}
		output += row;
	}
	return output;
}

export function skillCatalogPromptFragment(skills: readonly SkillDescriptor[], modelContextChars: number): string {
	return renderSkillCatalog(skills, { modelContextChars, maxChars: DEFAULT_EXTENSION_LIMITS.maxCatalogChars });
}
