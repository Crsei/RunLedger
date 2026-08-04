/**
 * SKILL.md 的有界 frontmatter parser。
 *
 * 本轮不引入 YAML 依赖；只接受 Skill 合同需要的标量、列表和字符串映射，
 * 明确拒绝 alias/tag/重复 key，避免把通用 YAML 语义带入 discovery 边界。
 */

import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type { SkillFrontmatter } from "./types.ts";

export type ParsedSkillDocument =
	| { readonly ok: true; readonly frontmatter: SkillFrontmatter; readonly body: string; readonly diagnostics: readonly ExtensionDiagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly ExtensionDiagnostic[] };

const knownFields = new Set(["name", "description", "user-invocable", "disable-model-invocation", "allowed-tools", "metadata"]);
const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const metadataKeyPattern = /^[A-Za-z0-9_.-]{1,128}$/u;

function invalid(sourcePath: string, code: string, message: string): ParsedSkillDocument {
	return { ok: false, diagnostics: [extensionDiagnostic(code, "error", message, "skill", sourcePath)] };
}

function stripComment(value: string): string {
	let quote: "single" | "double" | undefined;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === "\\" && quote === "double") {
			index += 1;
			continue;
		}
		if (character === "\"" && quote !== "single") quote = quote === "double" ? undefined : "double";
		else if (character === "'" && quote !== "double") quote = quote === "single" ? undefined : "single";
		else if (character === "#" && !quote && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) return value.slice(0, index).trimEnd();
	}
	return value.trim();
}

function parseScalar(value: string): unknown {
	const trimmed = stripComment(value).trim();
	if (trimmed.startsWith("*") || trimmed.startsWith("&") || trimmed.startsWith("!") || trimmed.includes("\0")) throw new Error("YAML aliases and tags are not allowed");
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) return JSON.parse(trimmed) as string;
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/gu, "'");
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1).trim();
		if (inner.length === 0) return [];
		const values: string[] = [];
		let start = 0;
		let quote: "single" | "double" | undefined;
		for (let index = 0; index < inner.length; index += 1) {
			const character = inner[index];
			if (character === "\"" && quote !== "single") quote = quote === "double" ? undefined : "double";
			else if (character === "'" && quote !== "double") quote = quote === "single" ? undefined : "single";
			else if (character === "," && !quote) {
				values.push(inner.slice(start, index).trim());
				start = index + 1;
			}
		}
		values.push(inner.slice(start).trim());
		return values.map((item) => parseScalar(item));
	}
	return trimmed;
}

function splitKeyValue(line: string): { key: string; value: string } | undefined {
	const separator = line.indexOf(":");
	if (separator <= 0) return undefined;
	return { key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
}

function indentation(line: string): number {
	const prefix = line.match(/^ */u)?.[0] ?? "";
	return prefix.length;
}

export function parseSkillDocument(content: string, sourcePath: string): ParsedSkillDocument {
	if (Buffer.byteLength(content, "utf8") > DEFAULT_EXTENSION_LIMITS.maxSkillBodyBytes) return invalid(sourcePath, "skill.oversize", "SKILL.md exceeds byte bound");
	const normalized = content.replace(/\r\n/gu, "\n");
	if (!normalized.startsWith("---\n")) return invalid(sourcePath, "skill.frontmatter_missing", "SKILL.md must begin with YAML frontmatter");
	const end = normalized.indexOf("\n---\n", 4);
	if (end < 0) return invalid(sourcePath, "skill.frontmatter_unclosed", "SKILL.md frontmatter is not closed");
	const yaml = normalized.slice(4, end);
	const body = normalized.slice(end + 5);
	const lines = yaml.split("\n");
	const raw: Record<string, unknown> = {};
	let index = 0;
	try {
		while (index < lines.length) {
			const line = lines[index] ?? "";
			index += 1;
			if (line.trim() === "" || line.trim().startsWith("#")) continue;
			if (line.includes("\t")) throw new Error("tabs are not allowed in frontmatter");
			if (indentation(line) !== 0) throw new Error("frontmatter top-level indentation is invalid");
			const pair = splitKeyValue(line);
			if (!pair || pair.key.length === 0 || raw[pair.key] !== undefined) throw new Error("frontmatter key is invalid or duplicated");
			if (pair.value.length > 0) {
				raw[pair.key] = parseScalar(pair.value);
				continue;
			}
			const nested: string[] = [];
			while (index < lines.length && (lines[index] ?? "").trim() !== "" && indentation(lines[index] ?? "") > 0) nested.push(lines[index++] ?? "");
			if (pair.key === "allowed-tools") {
				const values: unknown[] = [];
				for (const nestedLine of nested) {
					const trimmed = nestedLine.trim();
					if (!trimmed.startsWith("-") || trimmed.slice(1).trim().length === 0) throw new Error("allowed-tools must be a list");
					values.push(parseScalar(trimmed.slice(1).trim()));
				}
				raw[pair.key] = values;
			} else if (pair.key === "metadata") {
				const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
				for (const nestedLine of nested) {
					const nestedPair = splitKeyValue(nestedLine.trim());
					if (!nestedPair || nestedPair.value.length === 0 || !metadataKeyPattern.test(nestedPair.key) || ["__proto__", "constructor", "prototype"].includes(nestedPair.key) || Object.hasOwn(metadata, nestedPair.key)) throw new Error("metadata keys must be bounded and unique");
					const value = parseScalar(nestedPair.value);
					if (typeof value !== "string") throw new Error("metadata values must be strings");
					metadata[nestedPair.key] = value;
				}
				raw[pair.key] = metadata;
			} else {
				raw[pair.key] = {};
			}
		}
	} catch (error) {
		const code = error instanceof Error && error.message.includes("alias") ? "skill.frontmatter_alias" : "skill.frontmatter_invalid";
		return invalid(sourcePath, code, error instanceof Error ? error.message : "SKILL.md frontmatter is invalid");
	}

	const diagnostics = Object.keys(raw)
		.filter((key) => !knownFields.has(key))
		.sort()
		.map((key) => extensionDiagnostic("skill.unknown_field", "warning", `unknown skill field: ${key}`, "skill", sourcePath));
	const name = raw.name;
	const description = raw.description;
	const userInvocable = raw["user-invocable"];
	const disableModelInvocation = raw["disable-model-invocation"];
	const allowedTools = raw["allowed-tools"];
	const metadata = raw.metadata;
	if (typeof name !== "string" || !namePattern.test(name) || typeof description !== "string" || description.length === 0 || description.length > DEFAULT_EXTENSION_LIMITS.maxDescriptionChars) {
		return { ok: false, diagnostics: [...diagnostics, extensionDiagnostic("skill.schema_invalid", "error", "SKILL.md frontmatter does not match the bounded skill schema", "skill", sourcePath)] };
	}
	if ((userInvocable !== undefined && typeof userInvocable !== "boolean") || (disableModelInvocation !== undefined && typeof disableModelInvocation !== "boolean")) {
		return { ok: false, diagnostics: [...diagnostics, extensionDiagnostic("skill.schema_invalid", "error", "Skill invocation flags must be booleans", "skill", sourcePath)] };
	}
	if (allowedTools !== undefined && (!Array.isArray(allowedTools) || allowedTools.length > 128 || !allowedTools.every((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 128) || new Set(allowedTools).size !== allowedTools.length)) {
		return { ok: false, diagnostics: [...diagnostics, extensionDiagnostic("skill.schema_invalid", "error", "allowed-tools must be a bounded unique string list", "skill", sourcePath)] };
	}
	if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) || Object.keys(metadata).length > 128 || !Object.entries(metadata).every(([key, value]) => metadataKeyPattern.test(key) && value.length <= 1_024))) {
		return { ok: false, diagnostics: [...diagnostics, extensionDiagnostic("skill.schema_invalid", "error", "metadata must be a bounded string map", "skill", sourcePath)] };
	}
	return {
		ok: true,
		frontmatter: {
			name,
			description,
			userInvocable: userInvocable !== false,
			disableModelInvocation: disableModelInvocation === true,
			...(Array.isArray(allowedTools) ? { allowedTools: Object.freeze([...allowedTools] as string[]) } : {}),
			metadata: Object.freeze({ ...(metadata as Record<string, string> | undefined) }),
		},
		body,
		diagnostics,
	};
}
