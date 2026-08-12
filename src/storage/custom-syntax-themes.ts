import { promises as fs } from "node:fs";
import { join, parse } from "node:path";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";

const MAX_CUSTOM_THEME_BYTES = 512 * 1024;
const SAFE_THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface CustomSyntaxTheme {
	readonly name: string;
	readonly bytes: Uint8Array;
}

export interface CustomSyntaxThemeError {
	readonly name: string;
	readonly code: "custom_theme_invalid_name" | "custom_theme_not_regular" | "custom_theme_oversize" | "custom_theme_read_failed";
}

export interface CustomSyntaxThemeLoadResult {
	readonly themes: readonly CustomSyntaxTheme[];
	readonly errors: readonly CustomSyntaxThemeError[];
}

/** Storage 是唯一读路径方；返回值只含 safe basename 与 bounded copied bytes。 */
export async function loadCustomSyntaxThemes(layout: RunledgerLayout): Promise<CustomSyntaxThemeLoadResult> {
	const directory = join(layout.home, "themes");
	let entries;
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch {
		return { themes: [], errors: [] };
	}
	const themes: CustomSyntaxTheme[] = [];
	const errors: CustomSyntaxThemeError[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".tmTheme")) continue;
		const name = entry.name.slice(0, -".tmTheme".length);
		if (!SAFE_THEME_NAME.test(name) || name.includes("..") || parse(name).base !== name) {
			errors.push({ name: "invalid", code: "custom_theme_invalid_name" });
			continue;
		}
		if (!entry.isFile()) {
			errors.push({ name, code: "custom_theme_not_regular" });
			continue;
		}
		const path = join(directory, entry.name);
		try {
			const stat = await fs.lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink()) {
				errors.push({ name, code: "custom_theme_not_regular" });
				continue;
			}
			if (stat.size > MAX_CUSTOM_THEME_BYTES) {
				errors.push({ name, code: "custom_theme_oversize" });
				continue;
			}
			const bytes = await fs.readFile(path);
			if (bytes.byteLength > MAX_CUSTOM_THEME_BYTES) {
				errors.push({ name, code: "custom_theme_oversize" });
				continue;
			}
			themes.push({ name, bytes: Uint8Array.from(bytes) });
		} catch {
			errors.push({ name, code: "custom_theme_read_failed" });
		}
	}
	themes.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
	return { themes, errors };
}
