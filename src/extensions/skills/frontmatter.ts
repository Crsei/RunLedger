/** SKILL.md YAML frontmatter 的有界解析器。 */

import { parseDocument } from "yaml";
import { schemaAccepts, SkillFrontmatterSchema } from "../schemas.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type { SkillFrontmatter } from "./types.ts";

export type ParsedSkillDocument =
	| { ok: true; frontmatter: SkillFrontmatter; body: string; diagnostics: readonly ExtensionDiagnostic[] }
	| { ok: false; diagnostics: readonly ExtensionDiagnostic[] };

const knownFields = new Set(["name", "description", "user-invocable", "disable-model-invocation", "allowed-tools", "metadata"]);

export function parseSkillDocument(content: string, sourcePath: string): ParsedSkillDocument {
	if (Buffer.byteLength(content) > DEFAULT_EXTENSION_LIMITS.maxSkillBodyBytes) {
		return { ok: false, diagnostics: [extensionDiagnostic("skill.oversize", "error", "SKILL.md exceeds byte bound", "skill", sourcePath)] };
	}
	const normalized = content.replace(/\r\n/gu, "\n");
	if (!normalized.startsWith("---\n")) {
		return { ok: false, diagnostics: [extensionDiagnostic("skill.frontmatter_missing", "error", "SKILL.md must begin with YAML frontmatter", "skill", sourcePath)] };
	}
	const end = normalized.indexOf("\n---\n", 4);
	if (end < 0) {
		return { ok: false, diagnostics: [extensionDiagnostic("skill.frontmatter_unclosed", "error", "SKILL.md frontmatter is not closed", "skill", sourcePath)] };
	}
	const yaml = normalized.slice(4, end);
	const body = normalized.slice(end + 5);
	const document = parseDocument(yaml, { schema: "core", uniqueKeys: true });
	if (document.errors.length > 0) {
		return { ok: false, diagnostics: [extensionDiagnostic("skill.frontmatter_invalid", "error", "SKILL.md frontmatter is invalid YAML", "skill", sourcePath)] };
	}
	let value: unknown;
	try {
		value = document.toJS({ maxAliasCount: 0 }) as unknown;
	} catch {
		return { ok: false, diagnostics: [extensionDiagnostic("skill.frontmatter_alias", "error", "SKILL.md YAML aliases are not allowed", "skill", sourcePath)] };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, diagnostics: [extensionDiagnostic("skill.frontmatter_invalid", "error", "SKILL.md frontmatter must be a mapping", "skill", sourcePath)] };
	}
	const raw = value as Record<string, unknown>;
	const diagnostics = Object.keys(raw)
		.filter((key) => !knownFields.has(key))
		.sort()
		.map((key) => extensionDiagnostic("skill.unknown_field", "warning", `unknown skill field: ${key}`, "skill", sourcePath));
	const exactValue = Object.fromEntries(Object.entries(raw).filter(([key]) => knownFields.has(key)));
	if (!schemaAccepts(SkillFrontmatterSchema, exactValue)) {
		return { ok: false, diagnostics: [...diagnostics, extensionDiagnostic("skill.schema_invalid", "error", "SKILL.md frontmatter does not match schema v1", "skill", sourcePath)] };
	}
	return {
		ok: true,
		frontmatter: {
			name: exactValue.name as string,
			description: exactValue.description as string,
			userInvocable: exactValue["user-invocable"] !== false,
			disableModelInvocation: exactValue["disable-model-invocation"] === true,
			...(Array.isArray(exactValue["allowed-tools"]) ? { allowedTools: exactValue["allowed-tools"] as string[] } : {}),
			metadata: (exactValue.metadata ?? {}) as Record<string, string>,
		},
		body,
		diagnostics,
	};
}
