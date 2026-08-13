import { describe, expect, it } from "vitest";
import {
	highlightResultToStyledText,
	validateHighlightResult,
	type HighlightResult,
} from "../../src/tui/highlight/contracts.ts";
import { inspectNativeSyntaxAddon } from "../../src/tui/highlight/native-loader.ts";
import { loadNativeSyntaxAddonFromPackage } from "../../src/tui/highlight/native-loader.ts";

const engineInfo = {
	addon: "runledger-syntax-highlighter",
	apiVersion: 1,
	engineBuildId: "syntax-highlighter@0.0.1:test:0123456789abcdef",
} as const;

function compactSuccess(): Uint8Array {
	const first = Buffer.from("let ", "utf8");
	const second = Buffer.from("值", "utf8");
	const buffer = Buffer.alloc(16 + 4 + 8 + first.length + 8 + second.length);
	buffer.write("RLSH", 0, "ascii");
	buffer.writeUInt8(1, 4);
	buffer.writeUInt8(1, 5);
	buffer.writeUInt32LE(1, 8);
	buffer.writeUInt32LE(2, 12);
	buffer.writeUInt32LE(2, 16);
	buffer.writeUInt32LE(first.length, 20);
	buffer.writeUInt32LE(1 | (1 << 2) | (5 << 8), 24);
	first.copy(buffer, 28);
	const secondOffset = 28 + first.length;
	buffer.writeUInt32LE(second.length, secondOffset);
	buffer.writeUInt32LE(2 | (1 << 8) | (2 << 16) | (3 << 24), secondOffset + 4);
	second.copy(buffer, secondOffset + 8);
	return buffer;
}

function validSuccess(): unknown {
	return {
		ok: true,
		lines: [
			{
				spans: [
					{ text: "let", foreground: { kind: "indexed", index: 5 }, bold: true },
					{ text: " value", foreground: { kind: "rgb", r: 1, g: 2, b: 3 }, bold: false },
				],
			},
			{ spans: [{ text: "next", foreground: { kind: "default" }, bold: false }] },
		],
		themeRevision: 7,
	};
}

describe("native syntax highlighter DTO boundary", () => {
	it("rejects a checksum mismatch before loading native code", () => {
		let loadCalls = 0;
		const availability = loadNativeSyntaxAddonFromPackage({
			packageName: "@runledger/syntax-highlighter-linux-x64-gnu",
			resolvePackageJson: () => "/fixture/package.json",
			readFile: (path) => path.endsWith("checksums.json")
				? Buffer.from(JSON.stringify({ algorithm: "sha256", files: { "runledger-syntax-highlighter.node": "0".repeat(64) } }))
				: Buffer.from("tampered-native"),
			loadModule: () => { loadCalls += 1; return {}; },
		});
		expect(availability).toEqual({ ok: false, reason: "native_integrity_error" });
		expect(loadCalls).toBe(0);
	});
	it("accepts the exact framework-neutral result and preserves indexed/default/RGB intent", () => {
		const result = validateHighlightResult(validSuccess());
		expect(result?.ok).toBe(true);
		const styled = highlightResultToStyledText(result as HighlightResult);
		expect(styled).toBeDefined();
		expect(styled?.chunks.map((chunk) => chunk.text).join("")).toBe("let value\nnext");
		expect(styled?.chunks[0]?.fg?.intent).toBe("indexed");
		expect(styled?.chunks[0]?.fg?.slot).toBe(5);
		expect(styled?.chunks[0]?.attributes).not.toBe(0);
		expect(styled?.chunks[1]?.fg?.intent).toBe("rgb");
		expect(styled?.chunks[1]?.fg?.toInts().slice(0, 3)).toEqual([1, 2, 3]);
		expect(styled?.chunks[3]?.fg?.intent).toBe("default");
	});

	it("rejects malformed, out-of-range, control-bearing, and extra-field DTOs", () => {
		const cases: unknown[] = [
			null,
			{ ok: true, lines: [], themeRevision: -1 },
			{ ok: true, lines: [], themeRevision: 1, extra: true },
			{ ok: true, lines: [{ spans: [{ text: "x", foreground: { kind: "indexed", index: 256 }, bold: false }] }], themeRevision: 1 },
			{ ok: true, lines: [{ spans: [{ text: "x", foreground: { kind: "rgb", r: 1, g: 2, b: 999 }, bold: false }] }], themeRevision: 1 },
			{ ok: true, lines: [{ spans: [{ text: "x\r", foreground: { kind: "default" }, bold: false }] }], themeRevision: 1 },
			{ ok: false, reason: "not_a_reason" },
			{ ok: false, reason: "empty", extra: true },
		];
		for (const candidate of cases) expect(validateHighlightResult(candidate)).toBeUndefined();
	});

	it("accepts typed fallback results", () => {
		expect(validateHighlightResult({ ok: false, reason: "oversize_lines" })).toEqual({ ok: false, reason: "oversize_lines" });
	});
});

	describe("native addon inspection", () => {
		it("requires engine identity, theme inventory, and compact async highlighter", async () => {
		const addon = {
			engineInfo: () => engineInfo,
			builtinThemes: () => ["ansi", "catppuccin-mocha"],
			highlightCompactAsync: async () => compactSuccess(),
			foregroundForScopes: () => ({ ok: true, foreground: { kind: "indexed", index: 2 } }),
			diffScopeBackgrounds: () => ({ ok: true }),
			registerCustomTheme: () => ({ ok: true }),
		};
		const availability = inspectNativeSyntaxAddon(addon);
		expect(availability.ok).toBe(true);
			if (!availability.ok) return;
			expect(availability.info.engineBuildId).toBe(engineInfo.engineBuildId);
			expect(await availability.addon.highlightAsync("let 值", "rust", "catppuccin-mocha")).toEqual({
				ok: true,
				lines: [{ spans: [
					{ text: "let ", foreground: { kind: "indexed", index: 5 }, bold: true },
					{ text: "值", foreground: { kind: "rgb", r: 1, g: 2, b: 3 }, bold: false },
				] }],
				themeRevision: 0,
			});
		expect(availability.addon.foregroundForScopes("catppuccin-mocha", ["string"])).toEqual({ kind: "indexed", index: 2 });
		expect(availability.addon.registerCustomTheme("fixture", new Uint8Array([1]))).toEqual({ ok: true });
		});

		it("fails closed when engine build identity is absent or unbounded", () => {
		const completeAddon = {
			builtinThemes: () => ["ansi"],
			highlightCompactAsync: async () => new Uint8Array(),
			foregroundForScopes: () => ({ ok: true }),
				diffScopeBackgrounds: () => ({ ok: true }),
				registerCustomTheme: () => ({ ok: true }),
			};
			for (const info of [
				{ addon: "runledger-syntax-highlighter", apiVersion: 1 },
				{ ...engineInfo, engineBuildId: "x".repeat(129) },
				{ ...engineInfo, engineBuildId: "contains whitespace" },
			]) {
				expect(inspectNativeSyntaxAddon({ ...completeAddon, engineInfo: () => info })).toEqual({
					ok: false,
					reason: "native_unavailable",
				});
			}
		});

	it("fails closed for invalid modules without invoking highlight work", () => {
		for (const candidate of [null, {}, { engineInfo: () => engineInfo }, { ...engineInfo, highlightCompactAsync: () => undefined }]) {
			expect(inspectNativeSyntaxAddon(candidate)).toEqual({ ok: false, reason: "native_unavailable" });
		}
	});

	it("rejects truncated, count-mismatched, and trailing compact payloads", async () => {
		for (const bytes of [
			compactSuccess().subarray(0, 20),
			Uint8Array.from(compactSuccess(), (byte, index) => index === 12 ? 3 : byte),
			Uint8Array.from([...compactSuccess(), 0]),
		]) {
			const availability = inspectNativeSyntaxAddon({
				engineInfo: () => engineInfo,
				builtinThemes: () => ["ansi"],
				highlightCompactAsync: async () => bytes,
				foregroundForScopes: () => ({ ok: true }),
				diffScopeBackgrounds: () => ({ ok: true }),
				registerCustomTheme: () => ({ ok: true }),
			});
			expect(availability.ok).toBe(true);
			if (!availability.ok) continue;
			expect(await availability.addon.highlightAsync("let 值", "rust", "ansi")).toEqual({
				ok: false,
				reason: "highlight_error",
			});
		}
	});
});
