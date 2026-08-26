import type { ObservationUnavailableReason } from "./types.ts";

export const LOCAL_TELEMETRY_TRANSPORTS = [
	"llm_http",
	"llm_sse",
	"llm_websocket",
	"mcp_http",
	"governed_http",
	"gateway",
	"process_io",
] as const;

export type LocalTelemetryTransport = (typeof LOCAL_TELEMETRY_TRANSPORTS)[number];

export interface LocalTelemetryTransportDeclaration {
	readonly transport: LocalTelemetryTransport;
	readonly owner: string;
	readonly boundary: "fetch" | "websocket" | "network" | "process_io";
}

export interface LocalTelemetryInstrumentationEvidence {
	readonly transport: LocalTelemetryTransport;
	readonly file: string;
	readonly marker: string;
}

/** M1 production inventory；新增 channel literal 必须同时更新此表与静态门禁。 */
export const LOCAL_TELEMETRY_TRANSPORT_INVENTORY: readonly LocalTelemetryTransportDeclaration[] = [
	{ transport: "llm_http", owner: "provider-fetch-router", boundary: "fetch" },
	{ transport: "llm_sse", owner: "provider-fetch-router", boundary: "fetch" },
	{ transport: "llm_websocket", owner: "openai-codex-responses", boundary: "websocket" },
	{ transport: "mcp_http", owner: "mcp-sdk-fetch-adapter", boundary: "network" },
	{ transport: "governed_http", owner: "web-fetch-network-boundary", boundary: "network" },
	{ transport: "gateway", owner: "auth-gateway-dispatch", boundary: "fetch" },
	{ transport: "process_io", owner: "managed-process-output-boundary", boundary: "process_io" },
];

/** measured 只表示生产边界有直接 meter；gateway 尚未接入本地 Session Trace。 */
export const PRODUCTION_LOCAL_TELEMETRY_COVERAGE: readonly TransportCoverage[] = [
	{ transport: "llm_http", state: "measured" },
	{ transport: "llm_sse", state: "measured" },
	{ transport: "llm_websocket", state: "measured" },
	{ transport: "mcp_http", state: "measured" },
	{ transport: "governed_http", state: "measured" },
	{ transport: "gateway", state: "unavailable", reason: "transport_not_instrumented" },
	{ transport: "process_io", state: "measured" },
];

/** 静态门禁读取这些生产 marker，防止只登记 transport 而完全没有 meter。 */
export const LOCAL_TELEMETRY_INSTRUMENTATION_EVIDENCE: readonly LocalTelemetryInstrumentationEvidence[] = [
	{ transport: "llm_http", file: "src/utils/provider-fetch-context.ts", marker: "meteredProviderFetch(" },
	{ transport: "llm_sse", file: "src/utils/provider-fetch-context.ts", marker: "meteredProviderFetch(" },
	{ transport: "llm_websocket", file: "src/api/openai-codex-responses.ts", marker: "meterCurrentWebSocket(rawSocket)" },
	{ transport: "mcp_http", file: "src/extensions/mcp/sdk-factory.ts", marker: "withMeteredNetworkRequest(" },
	{ transport: "governed_http", file: "src/runtime/tools/web-fetch.ts", marker: "withMeteredNetworkRequest(" },
	{ transport: "process_io", file: "src/runtime/session-runtime/process-composition.ts", marker: "recordLocalProcessIo(" },
];

export function assertDeclaredLocalTelemetryTransport(value: string): asserts value is LocalTelemetryTransport {
	if (!(LOCAL_TELEMETRY_TRANSPORTS as readonly string[]).includes(value)) {
		throw new Error(`local telemetry transport is not declared: ${value}`);
	}
}

export type TransportCoverage =
	| { readonly transport: LocalTelemetryTransport; readonly state: "measured" }
	| { readonly transport: LocalTelemetryTransport; readonly state: "unavailable"; readonly reason: ObservationUnavailableReason };

/** M0 的显式 transport coverage 注册表；未注册 transport 不得被报告为 measured。 */
export class TransportCoverageRegistry {
	readonly #entries = new Map<LocalTelemetryTransport, TransportCoverage>();

	public register(entry: TransportCoverage): void {
		this.#entries.set(entry.transport, entry);
	}

	public get(transport: LocalTelemetryTransport): TransportCoverage | undefined {
		return this.#entries.get(transport);
	}

	public snapshot(): readonly TransportCoverage[] {
		return LOCAL_TELEMETRY_TRANSPORTS.flatMap((transport) => {
			const entry = this.#entries.get(transport);
			return entry === undefined ? [] : [entry];
		});
	}

	public missingDeclarations(): readonly LocalTelemetryTransport[] {
		return LOCAL_TELEMETRY_TRANSPORTS.filter((transport) => !this.#entries.has(transport));
	}

	public assertComplete(): void {
		const missing = this.missingDeclarations();
		if (missing.length > 0) throw new Error(`local telemetry coverage is incomplete: ${missing.join(", ")}`);
	}
}

export function createProductionTransportCoverageRegistry(): TransportCoverageRegistry {
	const registry = new TransportCoverageRegistry();
	for (const entry of PRODUCTION_LOCAL_TELEMETRY_COVERAGE) registry.register(entry);
	registry.assertComplete();
	return registry;
}
