/** CLI/TUI 共用的 schema-negotiated 轻客户端；业务状态只接受 Control Plane projection。 */

import { parseRuntimeId, type RuntimeInstanceId } from "../protocol/v3/ids.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import {
	validateAgentInspectQueryV2,
	validateControlPlaneV2AgentCommand,
	type AgentInspectQueryV2,
	type ControlPlaneV2AgentCommand,
	type ControlPlaneV2AgentCommandResponse,
	type ControlPlaneV2AgentQueryResponse,
} from "./multi-agent-contracts.ts";
import type {
	ControlPlaneClientHello,
	ControlPlaneFeature,
	ControlPlaneResponse,
	ControlPlaneServerHello,
	ControlPlaneTransport,
} from "./types.ts";

export interface LightControlPlaneTransportPort {
	dispatch(frame: unknown): Promise<ControlPlaneResponse>;
}

export interface SchemaNegotiatedControlPlaneClientOptions {
	transport: LightControlPlaneTransportPort;
	clientName: string;
	clientVersion: string;
	transportKind: ControlPlaneTransport;
	requestedFeatures: readonly ControlPlaneFeature[];
	requiredFeatures?: readonly ControlPlaneFeature[];
	requestId?: string;
}

export class SchemaNegotiatedControlPlaneClient {
	readonly #transport: LightControlPlaneTransportPort;
	readonly #hello: ControlPlaneClientHello;
	#handshake: ControlPlaneServerHello | undefined;

	public constructor(options: SchemaNegotiatedControlPlaneClientOptions) {
		this.#transport = options.transport;
		this.#hello = {
			kind: "handshake",
			requestId: options.requestId ?? "runledger-light-client-handshake",
			clientName: options.clientName,
			clientVersion: options.clientVersion,
			protocol: { major: 1, minMinor: 0, maxMinor: 1 },
			controlPlaneSchemaVersions: [1, 2],
			runtimeSchemaVersions: [3],
			requestedFeatures: [...options.requestedFeatures],
			requiredFeatures: [...(options.requiredFeatures ?? [])],
			transport: options.transportKind,
		};
	}

	public serverInstanceId(): RuntimeInstanceId | undefined {
		const value = this.#handshake?.serverInstanceId;
		return value ? parseRuntimeId("runtime", value) : undefined;
	}

	public negotiated(): ControlPlaneServerHello | undefined {
		return this.#handshake ? structuredClone(this.#handshake) : undefined;
	}

	public async connect(): Promise<ControlPlaneResult<ControlPlaneServerHello>> {
		if (this.#handshake) return { ok: true, value: structuredClone(this.#handshake) };
		const response = await this.#transport.dispatch(this.#hello);
		if (response.kind === "error") {
			return { ok: false, error: response.error, effect: "none" };
		}
		if (
			response.kind !== "handshake_result" ||
			response.requestId !== this.#hello.requestId
		) {
			return controlPlaneFailure(
				"adapter_contract_violation",
				"Control Plane handshake response is not correlated",
			);
		}
		this.#handshake = structuredClone(response);
		return { ok: true, value: structuredClone(response) };
	}

	#requireMultiAgent(): ControlPlaneResult<ControlPlaneServerHello> {
		if (!this.#handshake) {
			return controlPlaneFailure(
				"handshake_required",
				"Control Plane client is not connected",
			);
		}
		if (this.#handshake.controlPlaneSchemaVersion < 2) {
			return controlPlaneFailure(
				"unsupported_schema",
				"multi-agent client operations require schema v2",
			);
		}
		if (!this.#handshake.features.includes("multi_agent")) {
			return controlPlaneFailure(
				"unsupported_feature",
				"multi_agent was not negotiated",
			);
		}
		return { ok: true, value: this.#handshake };
	}

	public async executeAgent(
		command: ControlPlaneV2AgentCommand,
	): Promise<ControlPlaneResult<ControlPlaneV2AgentCommandResponse>> {
		const negotiated = this.#requireMultiAgent();
		if (!negotiated.ok) return negotiated;
		const validated = validateControlPlaneV2AgentCommand(command);
		if (!validated.ok) return validated;
		const response = await this.#transport.dispatch(validated.value);
		if (response.kind === "error") {
			return { ok: false, error: response.error, effect: "none" };
		}
		if (
			response.kind !== "command_result" ||
			response.commandId !== command.commandId ||
			response.type !== command.type ||
			!response.type.startsWith("agent:")
		) {
			return controlPlaneFailure(
				"adapter_contract_violation",
				"multi-agent command response is not correlated",
			);
		}
		return {
			ok: true,
			value: response as ControlPlaneV2AgentCommandResponse,
		};
	}

	public async inspectAgent(
		query: AgentInspectQueryV2,
	): Promise<ControlPlaneResult<ControlPlaneV2AgentQueryResponse>> {
		const negotiated = this.#requireMultiAgent();
		if (!negotiated.ok) return negotiated;
		const validated = validateAgentInspectQueryV2(query);
		if (!validated.ok) return validated;
		const response = await this.#transport.dispatch(validated.value);
		if (response.kind === "error") {
			return { ok: false, error: response.error, effect: "none" };
		}
		if (
			response.kind !== "query_result" ||
			response.queryId !== query.queryId ||
			response.type !== "agent:inspect"
		) {
			return controlPlaneFailure(
				"adapter_contract_violation",
				"multi-agent query response is not correlated",
			);
		}
		return {
			ok: true,
			value: response as ControlPlaneV2AgentQueryResponse,
		};
	}
}
