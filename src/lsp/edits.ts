/**
 * WorkspaceEdit 应用 —— 从 pi coding-agent `src/lsp/edits.ts` 适配。
 * 所有落盘经注入 LspWriteOperations;URI→路径转换、偏移换算与应用顺序在本模块完成一次。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sendNotification } from "./client.ts";
import type {
	CreateFile, DeleteFile, DocumentChange, LspClient, LspWriteOperations, RenameFile,
	TextEdit, TextDocumentEdit, WorkspaceEdit,
} from "./types.ts";
import { offsetAt, uriToFilePath } from "./utils.ts";

export function localLspWriteOperations(): LspWriteOperations {
	return {
		readFile: async (filePath) => fs.readFile(filePath, "utf8"),
		writeFile: async (filePath, content) => {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content, "utf8");
		},
		createDirectory: async (directory) => { await fs.mkdir(directory, { recursive: true }); },
		renameFile: async (oldPath, newPath) => {
			await fs.mkdir(path.dirname(newPath), { recursive: true });
			await fs.rename(oldPath, newPath);
		},
		deleteFile: async (filePath) => { await fs.rm(filePath, { force: true }); },
	};
}

function applyTextEdits(content: string, edits: TextEdit[]): string {
	// 倒序按偏移应用,避免前序编辑改变后续偏移。
	const sorted = [...edits].sort((left, right) => offsetAt(content, right.range.start) - offsetAt(content, left.range.start));
	let text = content;
	for (const edit of sorted) {
		const start = offsetAt(text, edit.range.start);
		const end = offsetAt(text, edit.range.end);
		text = text.slice(0, start) + edit.newText + text.slice(end);
	}
	return text;
}

function formatChange(change: DocumentChange): string {
	if (!isResourceChange(change)) return `edit ${change.textDocument.uri}`;
	switch (change.kind) {
		case "create": return `create ${change.uri}`;
		case "rename": return `rename ${change.oldUri} -> ${change.newUri}`;
		case "delete": return `delete ${change.uri}`;
	}
}

function isResourceChange(change: DocumentChange): change is CreateFile | RenameFile | DeleteFile {
	return "kind" in change;
}

export async function applyWorkspaceEdit(
	client: LspClient,
	edit: WorkspaceEdit,
	ops: LspWriteOperations,
	signal?: AbortSignal,
): Promise<string[]> {
	const applied: string[] = [];
	const changes = edit.documentChanges ?? [];
	for (const change of changes) {
		if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		if ("kind" in change) await applyResourceOperation(change, ops);
		else await applyTextDocumentEdit(change, ops);
		applied.push(formatChange(change));
	}
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		const filePath = uriToFilePath(uri);
		const content = await ops.readFile(filePath);
		await ops.writeFile(filePath, applyTextEdits(content, edits));
		applied.push(`edit ${uri}`);
	}
	const renamed = changes.filter((change): change is RenameFile => "kind" in change && change.kind === "rename");
	if (renamed.length > 0) {
		await sendNotification(client, "workspace/didRenameFiles", {
			files: renamed.map((change) => ({ oldUri: change.oldUri, newUri: change.newUri })),
		}, signal).catch(() => undefined);
	}
	return applied;
}

async function applyResourceOperation(change: CreateFile | RenameFile | DeleteFile, ops: LspWriteOperations): Promise<void> {
	if (change.kind === "create") {
		const filePath = uriToFilePath(change.uri);
		try {
			await ops.readFile(filePath);
			return;
		} catch {
			// 不存在则创建。
		}
		await ops.createDirectory(path.dirname(filePath));
		await ops.writeFile(filePath, "");
	} else if (change.kind === "rename") {
		await ops.renameFile(uriToFilePath(change.oldUri), uriToFilePath(change.newUri));
	} else {
		await ops.deleteFile(uriToFilePath(change.uri));
	}
}

async function applyTextDocumentEdit(change: TextDocumentEdit, ops: LspWriteOperations): Promise<void> {
	const filePath = uriToFilePath(change.textDocument.uri);
	const content = await ops.readFile(filePath);
	await ops.writeFile(filePath, applyTextEdits(content, change.edits));
}
