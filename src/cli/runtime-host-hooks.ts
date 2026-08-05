/** Host resource gate used by the RuntimeHookAdapter. */

import type { AdapterIdentityRef } from "../runtime/protocol/adapter.ts";
import { runtimeDigest, type RuntimeContentRef } from "../runtime/protocol/foundation.ts";
import type { RuntimeResourceInvocationPort } from "../runtime/contracts/ports.ts";
import type { SecurityResult } from "../security/types.ts";
import type { HostResourceAuthorization, HostResourceAuthorizationRequest } from "./runtime-host-security.ts";

export interface HostHookResourceInvocationPortOptions {
	readonly adapter: AdapterIdentityRef;
	readonly sessionId: string;
	readonly principalId: string;
	readonly cwd: string;
	readonly authorize: (request: HostResourceAuthorizationRequest) => Promise<SecurityResult<HostResourceAuthorization>>;
}

export function createHostHookResourceInvocationPort(options: HostHookResourceInvocationPortOptions): RuntimeResourceInvocationPort {
	return {
		execute: async (request) => {
			const authorized = await options.authorize({
				sessionId: options.sessionId,
				principalId: options.principalId,
				requestId: request.requestId,
				traceId: request.traceId,
				toolName: "hook",
				cwd: options.cwd,
				argumentsDigest: request.inputDigest,
			});
			if (!authorized.ok) {
				return {
					port: request.port,
					action: request.action,
					requestId: request.requestId,
					outcome: "denied",
					effect: "none",
					adapter: options.adapter,
					outputDigest: runtimeDigest({ requestId: request.requestId, code: authorized.error.code }),
					error: {
						code: "capability_denied",
						message: authorized.error.message,
						retryable: authorized.error.retryable,
						correlationId: request.traceId,
					},
					completedAt: new Date().toISOString(),
				};
			}
			const receiptRef: RuntimeContentRef = {
				subjectKind: "receipt",
				digest: authorized.value.authorizationDigest,
				mediaType: "application/vnd.runledger.authorization+json",
				size: 0,
			};
			return {
				port: request.port,
				action: request.action,
				requestId: request.requestId,
				outcome: "ok",
				effect: "terminal",
				adapter: options.adapter,
				outputDigest: runtimeDigest({ requestId: request.requestId, authorizationDigest: authorized.value.authorizationDigest }),
				receiptRef,
				completedAt: new Date().toISOString(),
			};
		},
	};
}
