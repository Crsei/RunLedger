/** config-source 单测 —— JSON/YAML 双格式候选定位与文本解析。 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConfigParseError,
	configCandidatePaths,
	parseConfigText,
	readConfigDocument,
	resolveConfigSource,
} from "../../src/storage/config-source.ts";

function tmpCwd(): string {
	return mkdtempSync(join(tmpdir(), "rl-config-source-"));
}

/** 同一语义的 JSON 与 YAML 文档：用于等价性断言。 */
const EQUIVALENT_JSON = JSON.stringify({
	model: "claude-opus-4-6",
	provider: "anthropic",
	thinkingLevel: "high",
	recap: { enabled: true, idleSeconds: 240 },
	security: { network: { mode: "allowlist", allowedHosts: ["example.com"] } },
	enabledModels: ["a", "b"],
});

const EQUIVALENT_YAML = [
	"# 同一语义的 YAML 写法（含注释，JSON 无法表达）",
	"model: claude-opus-4-6",
	"provider: anthropic",
	"thinkingLevel: high",
	"",
	"recap:",
	"  enabled: true",
	"  idleSeconds: 240",
	"",
	"security:",
	"  network:",
	"    mode: allowlist",
	"    allowedHosts:",
	"      - example.com",
	"",
	"enabledModels: [a, b]",
].join("\n");

describe("configCandidatePaths", () => {
	it("按 YAML 优先顺序列出候选", () => {
		expect(configCandidatePaths("/home/u/settings.json")).toEqual([
			{ path: "/home/u/settings.yaml", format: "yaml" },
			{ path: "/home/u/settings.yml", format: "yaml" },
			{ path: "/home/u/settings.json", format: "json" },
		]);
	});

	it("支持点号开头的文件名（.lsp.json）", () => {
		expect(configCandidatePaths("/proj/.lsp.json").map((candidate) => candidate.path)).toEqual([
			"/proj/.lsp.yaml",
			"/proj/.lsp.yml",
			"/proj/.lsp.json",
		]);
	});

	it("基名不是 .json 时直接报错而不是猜候选", () => {
		expect(() => configCandidatePaths("/home/u/settings.yaml")).toThrow(/must end with \.json/u);
	});
});

describe("parseConfigText 等价性", () => {
	it("同一语义的 JSON 与 YAML 解析出逐字段相同的值", () => {
		expect(parseConfigText(EQUIVALENT_YAML, "yaml")).toEqual(parseConfigText(EQUIVALENT_JSON, "json"));
	});

	// 仓库没有属性测试库（未引入 fast-check），因此用表驱动覆盖各值形态：
	// 标量 / 空值 / 空容器 / 嵌套 / 流式与块式序列 / unicode / 转义。
	const EQUIVALENT_PAIRS: readonly (readonly [string, string, string])[] = [
		["标量混合", '{"s":"x","n":1,"f":1.5,"t":true,"z":false}', "s: x\nn: 1\nf: 1.5\nt: true\nz: false"],
		["空值", '{"a":null}', "a: null"],
		["空对象与空数组", '{"o":{},"l":[]}', "o: {}\nl: []"],
		["深嵌套", '{"a":{"b":{"c":[{"d":1}]}}}', "a:\n  b:\n    c:\n      - d: 1"],
		["块式序列", '{"l":["a","b"]}', "l:\n  - a\n  - b"],
		["流式序列", '{"l":["a","b"]}', "l: [a, b]"],
		["unicode", '{"k":"中文 🚀"}', 'k: "中文 🚀"'],
		["转义与引号", '{"k":"a\\"b\\\\c"}', 'k: "a\\"b\\\\c"'],
		["顶层数组", "[1,2,3]", "[1, 2, 3]"],
		["含空格的键", '{"a b":"c"}', '"a b": c'],
		["负号与科学计数", '{"n":-2,"e":1000}', "n: -2\ne: 1e3"],
	];

	for (const [label, json, yaml] of EQUIVALENT_PAIRS) {
		it(`等价性：${label}`, () => {
			expect(parseConfigText(yaml, "yaml")).toEqual(parseConfigText(json, "json"));
		});
	}

	it("UTF-8 BOM 在两种格式下都被剥离", () => {
		expect(parseConfigText("\uFEFF" + EQUIVALENT_JSON, "json")).toEqual(parseConfigText(EQUIVALENT_JSON, "json"));
		expect(parseConfigText("\uFEFF" + EQUIVALENT_YAML, "yaml")).toEqual(parseConfigText(EQUIVALENT_YAML, "yaml"));
	});

	it("CRLF 与 LF 解析结果一致", () => {
		const crlfJson = EQUIVALENT_JSON.split("\n").join("\r\n");
		const crlfYaml = EQUIVALENT_YAML.split("\n").join("\r\n");
		expect(parseConfigText(crlfJson, "json")).toEqual(parseConfigText(EQUIVALENT_JSON, "json"));
		expect(parseConfigText(crlfYaml, "yaml")).toEqual(parseConfigText(EQUIVALENT_YAML, "yaml"));
	});

	it("YAML 1.2 core 不做隐式类型转换", () => {
		const parsed = parseConfigText(
			["yes: yes", "on: on", "off: off", "when: 2020-01-01", "nada: null", "tilde: ~"].join("\n"),
			"yaml",
		);
		// yes/no/on/off 与时间戳保持字符串，只有 null/~ 是空值。
		expect(parsed).toEqual({ yes: "yes", on: "on", off: "off", when: "2020-01-01", nada: null, tilde: null });
	});
});

describe("parseConfigText 失败路径", () => {
	it("空文档在两种格式下都按解析失败处理", () => {
		expect(() => parseConfigText("", "json")).toThrow(ConfigParseError);
		expect(() => parseConfigText("", "yaml")).toThrow(ConfigParseError);
		expect(() => parseConfigText("   \n\t\n", "json")).toThrow(/empty document/u);
		expect(() => parseConfigText("\uFEFF  ", "yaml")).toThrow(/empty document/u);
	});

	it("语法错误抛出带 format 的 ConfigParseError", () => {
		const jsonError = catchError(() => parseConfigText('{"a": 1', "json"));
		expect(jsonError).toBeInstanceOf(ConfigParseError);
		expect((jsonError as ConfigParseError).format).toBe("json");
		const yamlError = catchError(() => parseConfigText("a: [1, 2", "yaml"));
		expect(yamlError).toBeInstanceOf(ConfigParseError);
		expect((yamlError as ConfigParseError).format).toBe("yaml");
	});

	it("重复键与多文档报错，不静默取最后一个", () => {
		expect(() => parseConfigText("a: 1\na: 2\n", "yaml")).toThrow(ConfigParseError);
		expect(() => parseConfigText("a: 1\n---\nb: 2\n", "yaml")).toThrow(ConfigParseError);
	});

	it("未知 tag 与 JS tag 都报错，不执行也不静默忽略", () => {
		expect(() => parseConfigText("a: !foo bar\n", "yaml")).toThrow(ConfigParseError);
		expect(() => parseConfigText("a: !!js/function > function(){}\n", "yaml")).toThrow(ConfigParseError);
	});

	it("alias 展开超过上限时报错而不是耗尽资源", () => {
		let bomb = "l0: &l0 [x, x, x, x, x, x, x, x, x]";
		for (let level = 1; level < 6; level += 1) {
			const refs = Array.from({ length: 9 }, () => `*l${level - 1}`).join(", ");
			bomb += `\nl${level}: &l${level} [${refs}]`;
		}
		expect(() => parseConfigText(bomb, "yaml")).toThrow(ConfigParseError);
	});

	it("__proto__ 只成为自身属性，不污染原型链", () => {
		const parsed = parseConfigText("__proto__:\n  polluted: true\nsafe: 1\n", "yaml") as Record<string, unknown>;
		expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(parsed.safe).toBe(1);
	});
});

describe("parseConfigText 合法 YAML 语法", () => {
	it("anchor/alias 展开为同一值", () => {
		expect(parseConfigText("a: &shared 7\nb: *shared\n", "yaml")).toEqual({ a: 7, b: 7 });
	});

	it("合并键在同一文件内生效（结果仍要过同一 sanitizer）", () => {
		const parsed = parseConfigText(
			["base: &b", "  x: 1", "  y: 2", "child:", "  <<: *b", "  y: 9"].join("\n"),
			"yaml",
		);
		expect(parsed).toEqual({ base: { x: 1, y: 2 }, child: { x: 1, y: 9 } });
	});

	it("顶层不是映射时原样返回，交给调用方的 sanitizer 判定", () => {
		expect(parseConfigText("just a scalar", "yaml")).toBe("just a scalar");
		expect(parseConfigText("[1, 2]", "yaml")).toEqual([1, 2]);
		expect(parseConfigText("[1, 2]", "json")).toEqual([1, 2]);
	});
});

describe("resolveConfigSource", () => {
	let cwd: string | undefined;

	afterEach(() => {
		if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
		cwd = undefined;
	});

	it("都不存在时返回 absent", async () => {
		cwd = tmpCwd();
		expect(await resolveConfigSource(join(cwd, "settings.json"))).toEqual({ status: "absent" });
	});

	it("YAML 优先于 JSON，并把被遮蔽的 JSON 报出来", async () => {
		cwd = tmpCwd();
		const json = join(cwd, "settings.json");
		writeFileSync(json, "{}", "utf8");
		writeFileSync(join(cwd, "settings.yaml"), "model: from-yaml\n", "utf8");
		expect(await resolveConfigSource(json)).toEqual({
			status: "resolved",
			path: join(cwd, "settings.yaml"),
			format: "yaml",
			shadowed: [json],
		});
	});

	it("只有 .yml 时同样生效，并遮蔽 .json", async () => {
		cwd = tmpCwd();
		const json = join(cwd, "settings.json");
		writeFileSync(json, "{}", "utf8");
		writeFileSync(join(cwd, "settings.yml"), "model: from-yml\n", "utf8");
		expect(await resolveConfigSource(json)).toEqual({
			status: "resolved",
			path: join(cwd, "settings.yml"),
			format: "yaml",
			shadowed: [json],
		});
	});

	it("只有 JSON 时没有遮蔽项", async () => {
		cwd = tmpCwd();
		const json = join(cwd, "settings.json");
		writeFileSync(json, "{}", "utf8");
		expect(await resolveConfigSource(json)).toEqual({
			status: "resolved",
			path: json,
			format: "json",
			shadowed: [],
		});
	});

	it(".yaml 与 .yml 同时存在时报同格式冲突", async () => {
		cwd = tmpCwd();
		writeFileSync(join(cwd, "settings.yaml"), "a: 1\n", "utf8");
		writeFileSync(join(cwd, "settings.yml"), "a: 2\n", "utf8");
		const resolution = await resolveConfigSource(join(cwd, "settings.json"));
		expect(resolution.status).toBe("ambiguous");
		expect(resolution.status === "ambiguous" ? resolution.paths : []).toEqual([
			join(cwd, "settings.yaml"),
			join(cwd, "settings.yml"),
		]);
	});

	it("同名目录不算候选文件", async () => {
		cwd = tmpCwd();
		mkdirSync(join(cwd, "settings.yaml"));
		expect(await resolveConfigSource(join(cwd, "settings.json"))).toEqual({ status: "absent" });
	});
});

describe("readConfigDocument", () => {
	let cwd: string | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
		cwd = undefined;
	});

	it("YAML 生效时返回解析值并输出遮蔽诊断", async () => {
		cwd = tmpCwd();
		const json = join(cwd, "settings.json");
		writeFileSync(json, JSON.stringify({ model: "from-json" }), "utf8");
		writeFileSync(join(cwd, "settings.yaml"), "model: from-yaml\n", "utf8");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = await readConfigDocument(json);
		expect(result.status).toBe("ok");
		expect(result.status === "ok" ? result.value : undefined).toEqual({ model: "from-yaml" });
		expect(result.status === "ok" ? result.format : undefined).toBe("yaml");
		expect(result.status === "ok" ? result.shadowed : []).toEqual([json]);
		// D2 的硬性约束：被遮蔽的 JSON 必须显式告知，不能静默忽略。
		const written = stderr.mock.calls.map((call) => String(call[0])).join("");
		expect(written).toContain("config_shadowed");
		expect(written).toContain(json);
	});

	it("单一文件生效时不输出遮蔽诊断", async () => {
		cwd = tmpCwd();
		writeFileSync(join(cwd, "settings.json"), JSON.stringify({ model: "only" }), "utf8");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = await readConfigDocument(join(cwd, "settings.json"));
		expect(result.status).toBe("ok");
		expect(result.status === "ok" ? result.value : undefined).toEqual({ model: "only" });
		expect(stderr.mock.calls).toHaveLength(0);
	});

	it("坏 YAML 返回 invalid 而不是抛错，且不回退 JSON", async () => {
		cwd = tmpCwd();
		const json = join(cwd, "settings.json");
		writeFileSync(json, JSON.stringify({ model: "from-json" }), "utf8");
		writeFileSync(join(cwd, "settings.yaml"), "model: [unclosed\n", "utf8");
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = await readConfigDocument(json);
		// 关键：YAML 写错不能悄悄按旧 JSON 生效。
		expect(result.status).toBe("invalid");
		expect(result.status === "invalid" ? result.path : undefined).toBe(join(cwd, "settings.yaml"));
	});

	it("空 YAML 文件同样按 invalid 处理", async () => {
		cwd = tmpCwd();
		writeFileSync(join(cwd, "settings.yaml"), "\n\n", "utf8");
		const result = await readConfigDocument(join(cwd, "settings.json"));
		expect(result.status).toBe("invalid");
	});

	it("冲突与缺失原样向上传递", async () => {
		cwd = tmpCwd();
		expect(await readConfigDocument(join(cwd, "settings.json"))).toEqual({ status: "absent" });
		writeFileSync(join(cwd, "settings.yaml"), "a: 1\n", "utf8");
		writeFileSync(join(cwd, "settings.yml"), "a: 2\n", "utf8");
		expect((await readConfigDocument(join(cwd, "settings.json"))).status).toBe("ambiguous");
	});
});

function catchError(fn: () => unknown): unknown {
	try {
		fn();
		return undefined;
	} catch (error) {
		return error;
	}
}
