/**
 * S2 拆分:governed network leaf —— 授权完成后才触碰 broker 最终 I/O。
 */

import type { Network, NetworkRequest, NetworkResponse } from "../../runtime/execution-env.ts";
import { digestOf } from "../sandbox/common.ts";
import { settleGatewayEffect, unwrapSecurityResult } from "./audit-settlement.ts";
import type { createAuthorizer } from "./permission-requester.ts";

export function createGovernedNetwork(
	authorize: ReturnType<typeof createAuthorizer>,
	cwd: string,
): Network {
	return {
		request: async (request: NetworkRequest, signal?: AbortSignal): Promise<NetworkResponse> => {
			const url = new URL(request.url);
			const context = await authorize(
				request.principal ?? "WebFetch",
				[{ kind: "network", operation: "fetch", host: url.hostname, protocol: url.protocol === "http:" ? "http" : "https", ...(url.port ? { port: Number(url.port) } : {}) }],
				networkDigestInput(request),
				cwd,
				signal,
			);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.network.request(request, signal)));
		},
	};
}

function networkDigestInput(request: NetworkRequest): Record<string, unknown> {
	return {
		url: request.url,
		method: request.method,
		headers: request.headers,
		bodyDigest: digestOf(request.body ?? ""),
		maxBytes: request.maxBytes,
		principal: request.principal ?? "WebFetch",
	};
}
