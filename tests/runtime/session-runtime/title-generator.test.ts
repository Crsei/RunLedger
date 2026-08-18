import { describe, expect, it } from "vitest";
import {
	normalizeGeneratedSessionTitle,
	isLowSignalTitleInput,
} from "../../../src/runtime/session-runtime/title-generator.ts";
import { normalizeSessionTitle } from "../../../src/runtime/session-owner/title.ts";

describe("session title normalization", () => {
	it("uses the first visible title marker and removes unsafe wrappers", () => {
		expect(normalizeGeneratedSessionTitle("<title>  Fix \u001b[31mlogin\u001b[0m button  </title>\nextra prose")).toBe("Fix login button");
	});

	it("returns no title for explicit empty markers and thinking-only output", () => {
		expect(normalizeGeneratedSessionTitle("<title/>" as string)).toBeNull();
		expect(normalizeGeneratedSessionTitle("<think>internal</think><title/>" as string)).toBeNull();
		expect(normalizeGeneratedSessionTitle("<title>  none  </title>" as string)).toBeNull();
	});

	it("unwraps a JSON-shaped title without accepting an overlong result", () => {
		expect(normalizeGeneratedSessionTitle('```json\n{"title":"Repair API error handling"}\n```')).toBe("Repair API error handling");
		expect(normalizeGeneratedSessionTitle(`<title>${"x".repeat(161)}</title>`)).toBeNull();
	});

	it("rejects a title that becomes empty after wrapper normalization", () => {
		expect(normalizeSessionTitle('"')).toBeNull();
		expect(normalizeGeneratedSessionTitle('<title>"</title>')).toBeNull();
	});
});

describe("low-signal title input", () => {
	it("skips empty greetings and acknowledgements", () => {
		expect(isLowSignalTitleInput("   ")).toBe(true);
		expect(isLowSignalTitleInput("hello")).toBe(true);
		expect(isLowSignalTitleInput("ok")).toBe(true);
		expect(isLowSignalTitleInput("Fix the login button on mobile")).toBe(false);
	});
});
