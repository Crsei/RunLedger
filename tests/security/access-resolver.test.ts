import { describe, expect, it } from "vitest";
import { resolveToolAccessRequests } from "../../src/security/permission/access-resolver.ts";

describe("central tool access resolver", () => {
	it("maps filesystem tools to one normalized request", () => {
		expect(resolveToolAccessRequests("write", { path: "src/index.ts", content: "x" }, "/repo")).toEqual({
			ok: true,
			value: [{ kind: "filesystem", operation: "write", path: "src/index.ts" }],
		});
	});

	it("preserves conservative shell analysis for bash", () => {
		expect(resolveToolAccessRequests("bash", { command: "ls && rm file" }, "/repo")).toEqual({
			ok: true,
			value: [{ kind: "shell", command: "ls && rm file", cwd: "/repo", analysis: "known" }],
		});
		expect(resolveToolAccessRequests("bash", { command: "echo $(rm file)" }, "/repo")).toMatchObject({
		ok: true,
		value: [{ analysis: "unknown" }],
	});
	});

	it("keeps unknown tools as approval-bearing tool requests", () => {
		expect(resolveToolAccessRequests("mcp_unknown", {}, "/repo")).toEqual({
			ok: true,
			value: [{ kind: "tool", toolName: "mcp_unknown" }],
		});
	});
});
