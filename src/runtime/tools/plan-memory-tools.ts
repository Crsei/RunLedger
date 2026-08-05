/**
 * Plan Mode / Memory agent tools —— 全部经 Host domain 通道执行。
 *
 * 这些工具不直接持有 store/reducer：只构造 Host domain 命令
 * （plan.write / memory.search / memory.get / memory.propose），
 * 由 Host 执行 durable intent/receipt 与 revision fence。
 * 客户端不装配第二 writer / controller。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";

export type HostDomainToolResponse =
	| { readonly ok: true; readonly body?: Record<string, unknown> }
	| { readonly ok: false; readonly code: string };

export interface HostDomainToolClient {
	readonly query: (operation: string, body?: Record<string, unknown>) => Promise<HostDomainToolResponse>;
	readonly command: (operation: string, body?: Record<string, unknown>) => Promise<HostDomainToolResponse>;
}

const shortBody = (value: unknown, max = 8_000): string => {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
};

function domainError(body: DomainResponse): string {
	return body.ok === false ? `rejected: ${body.code}` : "rejected by Host domain";
}

type DomainResponse =
	| { readonly ok: true; readonly body?: Record<string, unknown> }
	| { readonly ok: false; readonly code: string };

async function runDomain(
	kind: "query" | "command",
	client: HostDomainToolClient,
	operation: string,
	body: Record<string, unknown>,
): Promise<DomainResponse> {
	try {
		return await (kind === "query" ? client.query(operation, body) : client.command(operation, body));
	} catch (error) {
		return { ok: false, code: String(error) };
	}
}

// ===== plan_write =====

export const planWriteSchema = Type.Object({
	expectedRevision: Type.Integer({ description: "当前 plan state revision（从 plan.inspect 获取）" }),
	expectedPlanRevision: Type.Integer({ description: "当前 plan artifact revision" }),
	content: Type.String({ description: "计划的完整新正文（full body，不接受 path/patch 文件）" }),
});

export type PlanWriteInput = Static<typeof planWriteSchema>;

export interface PlanWriteDetails {
	readonly revision?: number;
	readonly planRevision?: number;
	readonly code?: string;
}

/** 唯一 plan writer：只接受 expected revision + full body，不接受 path。 */
export function createPlanWriteTool(client: HostDomainToolClient): AgentTool<typeof planWriteSchema, PlanWriteDetails> {
	return {
		name: "plan_write",
		label: "plan_write",
		description: "写入当前计划工件（Plan Mode active 时可用）。只接受 expected revision + 完整正文，不接受路径。",
		parameters: planWriteSchema,
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		async execute(_tc, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: PlanWriteDetails; terminate: false }> {
			const body = await runDomain("command", client, "plan.write", {
				expectedRevision: params.expectedRevision,
				expectedPlanRevision: params.expectedPlanRevision,
				content: params.content,
			});
			if (body.ok === false) {
				return { content: [{ type: "text", text: domainError(body) }], details: { code: body.code }, terminate: false };
			}
			const state = (body.body?.state ?? {}) as Record<string, unknown>;
			const plan = (state.plan ?? {}) as Record<string, unknown>;
			return {
				content: [{ type: "text", text: `plan written: revision=${String(state.revision ?? "?")} planRevision=${String(plan.revision ?? "?")}` }],
				details: {
					...(typeof state.revision === "number" ? { revision: state.revision } : {}),
					...(typeof plan.revision === "number" ? { planRevision: plan.revision } : {}),
				},
				terminate: false,
			};
		},
	};
}

// ===== memory_search =====

export const memorySearchSchema = Type.Object({
	query: Type.String({ description: "搜索词" }),
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("workspace"), Type.Literal("session")])),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
});

export type MemorySearchInput = Static<typeof memorySearchSchema>;

export interface MemorySearchDetails {
	readonly results?: number;
	readonly code?: string;
}

export function createMemorySearchTool(client: HostDomainToolClient): AgentTool<typeof memorySearchSchema, MemorySearchDetails> {
	return {
		name: "memory_search",
		label: "memory_search",
		description: "在 approved memory records 中做有界 lexical 搜索（只读）。",
		parameters: memorySearchSchema,
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		async execute(_tc, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: MemorySearchDetails; terminate: false }> {
			const body = await runDomain("query", client, "memory.search", {
				scope: params.scope ?? "workspace",
				query: params.query,
				...(params.maxResults === undefined ? {} : { maxResults: params.maxResults }),
			});
			if (body.ok === false) {
				return { content: [{ type: "text", text: domainError(body) }], details: { code: body.code }, terminate: false };
			}
			const rows = Array.isArray(body.body?.results) ? body.body.results as Record<string, unknown>[] : [];
			const text = rows.length === 0
				? "No matching memory records."
				: rows.map((row) => `- [${String(row.memoryId ?? "?")}] ${String(row.title ?? "")}\n  ${String(row.snippet ?? "")}`).join("\n");
			return { content: [{ type: "text", text }], details: { results: rows.length }, terminate: false };
		},
	};
}

// ===== memory_get =====

export const memoryGetSchema = Type.Object({
	memoryId: Type.String({ description: "memory record id" }),
});

export type MemoryGetInput = Static<typeof memoryGetSchema>;

export interface MemoryGetDetails {
	readonly code?: string;
}

export function createMemoryGetTool(client: HostDomainToolClient): AgentTool<typeof memoryGetSchema, MemoryGetDetails> {
	return {
		name: "memory_get",
		label: "memory_get",
		description: "读取单条 approved memory record 的元数据（只读，不返回全文）。",
		parameters: memoryGetSchema,
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		async execute(_tc, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: MemoryGetDetails; terminate: false }> {
			const body = await runDomain("query", client, "memory.get", { memoryId: params.memoryId });
			if (body.ok === false) {
				return { content: [{ type: "text", text: domainError(body) }], details: { code: body.code }, terminate: false };
			}
			return { content: [{ type: "text", text: shortBody(body.body?.record ?? body.body ?? {}) }], details: {}, terminate: false };
		},
	};
}

// ===== memory_propose =====

export const memoryProposeSchema = Type.Object({
	title: Type.String({ maxLength: 256, description: "proposal 标题" }),
	content: Type.String({ description: "要记住的内容（批准前不注入 Context）" }),
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("workspace"), Type.Literal("session")])),
});

export type MemoryProposeInput = Static<typeof memoryProposeSchema>;

export interface MemoryProposeDetails {
	readonly proposalId?: string;
	readonly code?: string;
}

export function createMemoryProposeTool(client: HostDomainToolClient): AgentTool<typeof memoryProposeSchema, MemoryProposeDetails> {
	return {
		name: "memory_propose",
		label: "memory_propose",
		description: "提交一条 memory proposal（需要人工批准后才可注入 Context；只写入 canonical store）。",
		parameters: memoryProposeSchema,
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		async execute(_tc, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: MemoryProposeDetails; terminate: false }> {
			const sourceDigest = params.content;
			const body = await runDomain("command", client, "memory.propose", {
				scope: params.scope ?? "workspace",
				title: params.title,
				content: params.content,
				sourceKind: "agent",
				sourceRef: { subjectKind: "content", digest: sourceDigest, mediaType: "text/plain", size: Buffer.byteLength(params.content, "utf8") },
				sourceDigest,
			});
			if (body.ok === false) {
				return { content: [{ type: "text", text: domainError(body) }], details: { code: body.code }, terminate: false };
			}
			const proposal = (body.body?.proposal ?? {}) as Record<string, unknown>;
			return {
				content: [{ type: "text", text: `memory proposal ${String(proposal.proposalId ?? "?")} pending approval` }],
				details: { ...(typeof proposal.proposalId === "string" ? { proposalId: proposal.proposalId } : {}) },
				terminate: false,
			};
		},
	};
}

/** 一次注册 plan/memory 四个 bounded tools。 */
export function createPlanMemoryTools(client: HostDomainToolClient): readonly AgentTool[] {
	return [
		createPlanWriteTool(client),
		createMemorySearchTool(client),
		createMemoryGetTool(client),
		createMemoryProposeTool(client),
	];
}
