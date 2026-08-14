import { describe, expect, it } from "vitest";
import { localLspSpawner } from "../../src/lsp/transport.ts";
import { FakeTransport } from "./fake-transport.ts";

describe("localLspSpawner", () => {
	it("返回的 spawn 委托 Bun.spawn(真实 spawn 由 P7 smoke 覆盖)", () => {
		const spawner = localLspSpawner();
		expect(typeof spawner.spawn).toBe("function");
	});
});

describe("FakeTransport", () => {
	it("stdin 写出即记录帧文本,供测试断言出站协议", () => {
		const transport = new FakeTransport();
		void transport.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
		expect(transport.sent).toEqual(['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}']);
	});

	it("emitNotification 经 stdout 流送达,帧头 Content-Length 正确", async () => {
		const transport = new FakeTransport();
		transport.emitNotification("textDocument/publishDiagnostics", { uri: "file:///a.ts", diagnostics: [] });
		const reader = transport.stdout.getReader();
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);
		expect(text).toContain("Content-Length: ");
		expect(text).toContain("textDocument/publishDiagnostics");
	});
});
