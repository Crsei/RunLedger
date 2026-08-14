import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectLanguageId, fileToUri, offsetAt, positionAt, resolveSymbolColumn, uriToFilePath } from "../../src/lsp/utils.ts";

describe("fileToUri / uriToFilePath", () => {
	it("往返一致", () => {
		const uri = fileToUri("/tmp/a b.ts");
		expect(uri.startsWith("file://")).toBe(true);
		expect(uriToFilePath(uri)).toBe("/tmp/a b.ts");
	});

	it("非 file 协议抛错", () => {
		expect(() => uriToFilePath("http://x/a.ts")).toThrow(/Unsupported URI protocol/);
	});

	it("跨平台解析 Windows drive 与 UNC file URI", () => {
		expect(uriToFilePath("file:///C:/Users/a%20b.ts")).toBe("C:\\Users\\a b.ts");
		expect(uriToFilePath("file://server/share/a.ts")).toBe("\\\\server\\share\\a.ts");
	});
});

describe("detectLanguageId", () => {
	it("常见扩展名", () => {
		expect(detectLanguageId("a.ts")).toBe("typescript");
		expect(detectLanguageId("a.tsx")).toBe("typescriptreact");
		expect(detectLanguageId("a.rs")).toBe("rust");
		expect(detectLanguageId("a.unknown")).toBe("plaintext");
	});
});

describe("resolveSymbolColumn", () => {
	const made: string[] = [];
	function file(content: string): string {
		const dir = mkdtempSync(path.join(tmpdir(), "lsp-utils-"));
		const filePath = path.join(dir, "a.ts");
		writeFileSync(filePath, content);
		made.push(dir);
		return filePath;
	}
	afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

	it("缺省 symbol 取首个非空白列", () => {
		expect(resolveSymbolColumn(file("  const a = 1;"), 1)).toEqual({ line: 0, character: 2 });
	});

	it("精确匹配", () => {
		expect(resolveSymbolColumn(file("const a = foo(1);"), 1, "foo")).toEqual({ line: 0, character: 10 });
	});

	it("忽略大小写回退", () => {
		expect(resolveSymbolColumn(file("const A = 1;"), 1, "a")).toEqual({ line: 0, character: 6 });
	});

	it("#N 选择器取第 N 次出现", () => {
		expect(resolveSymbolColumn(file("a(a, a);"), 1, "a#2")).toEqual({ line: 0, character: 2 });
	});

	it("找不到抛错", () => {
		expect(() => resolveSymbolColumn(file("const x = 1;"), 1, "nope")).toThrow(/not found/);
	});
});

describe("positionAt / offsetAt", () => {
	const text = "ab\ncd";
	it("互逆", () => {
		expect(positionAt(text, 3)).toEqual({ line: 1, character: 0 });
		expect(offsetAt(text, { line: 1, character: 0 })).toBe(3);
		expect(positionAt(text, offsetAt(text, { line: 1, character: 1 }))).toEqual({ line: 1, character: 1 });
	});
});
