import type { ModelRequestObservation, ModelRequestObserver } from "./model-request-observer.ts";
import type { PromptInspection } from "./types.ts";
import { runtimeDigest } from "./protocol/foundation.ts";

export const REQUEST_DUMP_VIEWS = ["request", "system", "assembled", "base"] as const;
export type RequestDumpView = typeof REQUEST_DUMP_VIEWS[number];

export interface RequestDumpMetadata {
	readonly view: RequestDumpView;
	readonly layer: "provider-input" | "assembled-context" | "base-prompt";
	readonly mediaType: "application/json" | "text/plain";
	readonly requestId?: string;
	readonly runId?: string;
	readonly turn?: number;
	readonly requestKind?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly api?: string;
	readonly thinkingLevel?: string;
	readonly capturedAtMs: number;
	readonly state: "assembled" | "prepared" | "response-received" | "completed" | "error" | "aborted" | "base";
	readonly responseStatus?: number;
	readonly systemPath?: string;
	readonly latestAttemptId?: string;
	readonly latestAttemptState?: string;
}

export interface RequestDump {
	readonly content: string;
	readonly metadata: RequestDumpMetadata;
}

export type RequestDumpResult = { readonly ok: true; readonly dump: RequestDump } | { readonly ok: false; readonly code: string };

interface RequestSnapshot {
	readonly metadata: Omit<RequestDumpMetadata, "view" | "layer" | "mediaType">;
	readonly assembledJson: string;
	readonly inspection: PromptInspection;
	readonly payloadJson?: string;
}

/** Session 内存观测：主请求与旁路请求分开，原始内容不写入 ledger/trace。 */
export class ModelRequestSnapshots {
	private latest: RequestSnapshot | undefined;
	private prepared: RequestSnapshot | undefined;

	readonly observe: ModelRequestObserver = (event) => {
		if (event.kind === "assembled") {
			if (event.requestKind !== "interactive") return;
			const context = {
				...(event.context.systemPrompt === undefined ? {} : { systemPrompt: event.context.systemPrompt }),
				messages: event.context.messages,
				tools: event.context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) ?? [],
			};
			const assembledJson = JSON.stringify(context);
			const tools = JSON.parse(JSON.stringify(context.tools)) as typeof context.tools;
			freezeJson(tools);
			const capturedAtMs = Date.now();
			this.latest = {
				metadata: { requestId: event.requestId, runId: event.runId, turn: event.turn, requestKind: event.requestKind,
					provider: event.model.provider, model: event.model.id, api: event.model.api,
					thinkingLevel: event.thinkingLevel, capturedAtMs, state: "assembled" },
				assembledJson,
				inspection: Object.freeze({ systemPrompt: context.systemPrompt ?? "", tools, source: "assembled", turn: event.turn,
					capturedAtMs, selection: Object.freeze({ provider: event.model.provider, model: event.model.id, thinkingLevel: event.thinkingLevel }),
					assembledPromptDigest: Object.freeze(runtimeDigest(context.systemPrompt ?? "")) }),
			};
			return;
		}
		this.update(event);
	};

	get promptInspection(): PromptInspection | undefined {
		return this.latest?.inspection;
	}

	dump(view: RequestDumpView, base: PromptInspection): RequestDumpResult {
		if (view === "base") return { ok: true, dump: { content: base.systemPrompt,
			metadata: { view, layer: "base-prompt", mediaType: "text/plain", capturedAtMs: Date.now(), state: "base" } } };
		const snapshot = view === "assembled" ? this.latest : this.prepared;
		if (snapshot === undefined) return { ok: false, code: view === "assembled" ? "assembled_request_unavailable" : "provider_request_unavailable" };
		const metadata: RequestDumpMetadata = {
			...snapshot.metadata, view, layer: view === "assembled" ? "assembled-context" : "provider-input", mediaType: "application/json",
			...(this.latest === undefined ? {} : { latestAttemptId: this.latest.metadata.requestId, latestAttemptState: this.latest.metadata.state }),
		};
		if (view === "assembled") return { ok: true, dump: { content: snapshot.assembledJson, metadata } };
		if (snapshot.payloadJson === undefined) return { ok: false, code: "provider_request_unavailable" };
		if (view === "request") return { ok: true, dump: { content: snapshot.payloadJson, metadata } };
		const system = extractSystem(snapshot.payloadJson, snapshot.metadata.api);
		if (system === undefined) return { ok: false, code: "provider_system_unavailable" };
		return { ok: true, dump: { content: system.content, metadata: { ...metadata, mediaType: system.mediaType, systemPath: system.path } } };
	}

	private update(event: Exclude<ModelRequestObservation, { kind: "assembled" }>): void {
		const previous = this.latest?.metadata.requestId === event.requestId ? this.latest
			: this.prepared?.metadata.requestId === event.requestId ? this.prepared : undefined;
		if (previous === undefined) return;
		if (event.kind === "prepared") JSON.parse(event.payloadJson);
		const next: RequestSnapshot = event.kind === "prepared"
			? { ...previous, payloadJson: event.payloadJson, metadata: { ...previous.metadata, provider: event.model.provider,
				model: event.model.id, api: event.model.api, state: "prepared", capturedAtMs: Date.now() } }
			: event.kind === "response"
				? { ...previous, metadata: { ...previous.metadata, state: "response-received", responseStatus: event.status } }
				: { ...previous, metadata: { ...previous.metadata, state: event.stopReason === "error" || event.stopReason === "aborted" ? event.stopReason : "completed" } };
		if (this.latest?.metadata.requestId === event.requestId) this.latest = next;
		if (event.kind === "prepared" || this.prepared?.metadata.requestId === event.requestId) this.prepared = next;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 按实际字段读取，不从 assembled prompt 重建 provider 内容。 */
function extractSystem(json: string, api: string | undefined): { content: string; mediaType: "text/plain" | "application/json"; path: string } | undefined {
	const payload: unknown = JSON.parse(json);
	if (!record(payload)) return undefined;
	const encode = (path: string, value: unknown) => value === undefined ? undefined : {
		content: typeof value === "string" ? value : JSON.stringify(value),
		mediaType: typeof value === "string" ? "text/plain" as const : "application/json" as const, path,
	};
	if (api === "anthropic-messages" || api === "bedrock-converse-stream") return encode("system", payload.system);
	if (api === "google-generative-ai" || api === "google-vertex") {
		return record(payload.config) ? encode("config.systemInstruction", payload.config.systemInstruction) : undefined;
	}
	if (api === "pi-messages") return record(payload.context) ? encode("context.systemPrompt", payload.context.systemPrompt) : undefined;
	const selected: Record<string, unknown> = {};
	if (payload.instructions !== undefined) selected.instructions = payload.instructions;
	const paths: string[] = payload.instructions === undefined ? [] : ["instructions"];
	for (const key of ["messages", "input"]) {
		const messages = payload[key];
		if (!Array.isArray(messages)) continue;
		const systemMessages: Record<string, unknown>[] = [];
		messages.forEach((message: unknown, index) => {
			if (record(message) && (message.role === "system" || message.role === "developer")) {
				systemMessages.push(message);
				paths.push(`${key}[${index}].content`);
			}
		});
		if (systemMessages.length > 0) selected[key] = systemMessages;
	}
	const keys = Object.keys(selected);
	if (keys.length === 0) return undefined;
	if (keys.length > 1) return encode(paths.join(", "), selected);
	const key = keys[0]!;
	if (key === "instructions") return encode(key, selected[key]);
	const messages = selected[key] as Record<string, unknown>[];
	// 多条系统消息保留原生 role/content，避免把 developer 和 system 扁平化。
	return encode(paths.join(", "), messages.length === 1 ? messages[0]!.content : messages);
}

/** 仅处理本模块从 JSON 解析出的无环数据。 */
function freezeJson(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
}
