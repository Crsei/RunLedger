/** 多个 Host-owned Session resource domain 的唯一显式组合器。 */

import type { SessionDomainResult } from "./domain-router.ts";
import type { SessionResourceDomainPort } from "./session-runtime.ts";

/**
 * 资源域按其冻结 operation manifest 路由；相同 operation 立即拒绝组合，
 * 避免 settings/extension 通过注册顺序互相覆盖。
 */
export function composeSessionResourceDomains(domains: readonly SessionResourceDomainPort[]): SessionResourceDomainPort {
	const operationManifest = domains.flatMap((domain) => domain.operationManifest);
	if (new Set(operationManifest.map((entry) => entry.operation)).size !== operationManifest.length) {
		throw new Error("duplicate Session resource domain operation");
	}
	return {
		operationManifest: Object.freeze(operationManifest.map((entry) => Object.freeze({ ...entry }))),
		query: async (operation, payload, context) => {
			const domain = domains.find((candidate) => candidate.operationManifest.some((entry) => entry.operation === operation && entry.access === "read"));
			return domain === undefined ? unavailable(operation) : domain.query(operation, payload, context);
		},
		mutate: async (operation, payload, context) => {
			const domain = domains.find((candidate) => candidate.operationManifest.some((entry) => entry.operation === operation && entry.access === "mutate"));
			return domain?.mutate === undefined ? unavailable(operation) : domain.mutate(operation, payload, context);
		},
	};
}

function unavailable(operation: string): SessionDomainResult {
	return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
}
