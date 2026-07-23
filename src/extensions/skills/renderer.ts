/** 有界、稳定且不注入 Skill 正文的 catalog renderer。 */

import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type { SkillDescriptor } from "./types.ts";

function clip(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function renderSkillCatalog(
	skills: readonly SkillDescriptor[],
	options: { maxChars?: number; modelContextChars?: number } = {},
): string {
	const maxChars = Math.max(0, Math.min(options.maxChars ?? DEFAULT_EXTENSION_LIMITS.maxCatalogChars, Math.floor((options.modelContextChars ?? Number.MAX_SAFE_INTEGER) * 0.02)));
	if (maxChars === 0) return "";
	const active = [...skills]
		.filter((skill) => skill.descriptor.enabled)
		.sort((left, right) => left.descriptor.identity.qualifiedId.localeCompare(right.descriptor.identity.qualifiedId));
	const header = "Available skills (load exact qualified identity on demand; bodies are not included):\n";
	if (header.length >= maxChars) return clip(header, maxChars);
	const minimumRows = active.map((skill) => `- ${skill.frontmatter.name} (${skill.descriptor.identity.qualifiedId})\n`);
	const minimumBytes = minimumRows.reduce((sum, row) => sum + row.length, header.length);
	const descriptionBudget = Math.max(0, maxChars - minimumBytes);
	const perSkill = active.length > 0 ? Math.floor(descriptionBudget / active.length) : 0;
	let output = header;
	for (let index = 0; index < active.length; index += 1) {
		const skill = active[index];
		if (!skill) continue;
		const suffix = perSkill > 3 ? `: ${clip(skill.frontmatter.description.replace(/\s+/gu, " "), perSkill - 2)}` : "";
		const row = `- ${skill.frontmatter.name} (${skill.descriptor.identity.qualifiedId})${suffix}\n`;
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
