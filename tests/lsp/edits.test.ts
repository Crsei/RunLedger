import { describe, expect, it } from "vitest";
import { applyWorkspaceEdit, localLspWriteOperations } from "../../src/lsp/edits.ts";
import type { LspClient, LspWriteOperations, WorkspaceEdit } from "../../src/lsp/types.ts";
import { FakeTransport } from "./fake-transport.ts";

function makeClient(): LspClient {
	const transport = new FakeTransport();
	return {
		name: "fake:.",
		scope: "standalone",
	cwd: "/tmp",
	config: { command: "fake", fileTypes: [], rootMarkers: [] },
	readFile: async () => "",
	proc: transport,
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => undefined,
	};
}

function recordingOps(): LspWriteOperations & { log: string[] } {
	const log: string[] = [];
	return {
		log,
		readFile: async (filePath) => (log.push(`read ${filePath}`), "const a = 1;\n"),
		writeFile: async (filePath, content) => { log.push(`write ${filePath} ${JSON.stringify(content)}`); },
		createDirectory: async (directory) => { log.push(`mkdir ${directory}`); },
		renameFile: async (oldPath, newPath) => { log.push(`rename ${oldPath} ${newPath}`); },
		deleteFile: async (filePath) => { log.push(`rm ${filePath}`); },
	};
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

describe("applyWorkspaceEdit", () => {
	it("TextDocumentEdit 应用文本编辑并写回", async () => {
		const client = makeClient();
		const ops = recordingOps();
		const edit: WorkspaceEdit = { documentChanges: [{ textDocument: { uri: "file:///a.ts", version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: "const b = 1;\n" }] }] };
		const applied = await applyWorkspaceEdit(client, edit, ops);
		expect(applied).toEqual(["edit file:///a.ts"]);
		expect(ops.log).toContain(`write /a.ts ${JSON.stringify("const b = 1;\n")}`);
	});

	it("多个编辑按偏移倒序应用", async () => {
		const client = makeClient();
		const ops = recordingOps();
		const edit: WorkspaceEdit = { changes: { "file:///a.ts": [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" },
			{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, newText: "y" },
		] } };
		await applyWorkspaceEdit(client, edit, ops);
		const write = ops.log.find((entry) => entry.startsWith("write"));
		expect(write).toBeDefined();
		expect(write).toContain(JSON.stringify("xconyst a = 1;\n"));
	});

	it("rename 资源操作落盘并发 didRenameFiles 通知", async () => {
		const client = makeClient();
		const ops = recordingOps();
		const edit: WorkspaceEdit = { documentChanges: [{ kind: "rename", oldUri: "file:///a.ts", newUri: "file:///b.ts" }] };
		await applyWorkspaceEdit(client, edit, ops);
		expect(ops.log).toContain("rename /a.ts /b.ts");
		const sent = (client.proc as FakeTransport).sent.some((frame) => frame.includes("workspace/didRenameFiles"));
		expect(sent).toBe(true);
	});

	it("create 已存在文件时不重复写入", async () => {
		const client = makeClient();
		const ops = recordingOps();
		const edit: WorkspaceEdit = { documentChanges: [{ kind: "create", uri: "file:///a.ts" }] };
		await applyWorkspaceEdit(client, edit, ops);
		expect(ops.log.filter((entry) => entry.startsWith("write")).length).toBe(0);
	});
});

describe("localLspWriteOperations", () => {
	it("接口完整", () => {
		const ops = localLspWriteOperations();
		for (const key of ["readFile", "writeFile", "createDirectory", "renameFile", "deleteFile"] as const) {
			expect(typeof ops[key]).toBe("function");
		}
	});
});
