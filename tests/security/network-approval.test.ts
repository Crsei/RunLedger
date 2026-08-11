import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../src/runtime/contracts/public.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import { PolicyNetworkClient } from "../../src/security/policy-network.ts";
import type { SecuritySnapshot } from "../../src/security/types.ts";

describe("network approval review", () => {
	it("normalizes an exact host, protocol, and explicit or default port key", async () => {
		const module = await import("../../src/security/network/network-approval.ts").catch(() => undefined);
		expect(module?.normalizeNetworkApprovalKey({ host: "API.Example.COM.", protocol: "https" })).toEqual({ host: "api.example.com", protocol: "https", port: 443 });
		expect(module?.normalizeNetworkApprovalKey({ host: "api.example.com", protocol: "http", port: 8080 })).toEqual({ host: "api.example.com", protocol: "http", port: 8080 });
		expect(module?.networkApprovalKeyDigest({ host: "api.example.com", protocol: "https", port: 443 })).not.toEqual(
			module?.networkApprovalKeyDigest({ host: "api.example.com", protocol: "https", port: 8443 }),
		);
	});

	it("caches approved and denied decisions only for the exact session key", async () => {
		const module = await import("../../src/security/network/network-approval.ts").catch(() => undefined);
		let reviews = 0;
		const service = module === undefined ? undefined : new module.NetworkApprovalService({
			review: async (key) => {
				reviews += 1;
				return key.host === "deny.example" ? "deny" : "allow";
			},
		});
		expect(await service?.authorize({ host: "api.example", protocol: "https" })).toMatchObject({ ok: true, value: "allow" });
		expect(await service?.authorize({ host: "API.EXAMPLE.", protocol: "https", port: 443 })).toMatchObject({ ok: true, value: "allow" });
		expect(await service?.authorize({ host: "api.example", protocol: "https", port: 8443 })).toMatchObject({ ok: true, value: "allow" });
		expect(await service?.authorize({ host: "deny.example", protocol: "https" })).toMatchObject({ ok: true, value: "deny" });
		expect(await service?.authorize({ host: "deny.example", protocol: "https" })).toMatchObject({ ok: true, value: "deny" });
		expect(reviews).toBe(3);
	});

	it("requires an injected review port before a PolicyNetworkClient can upgrade an allowlist miss", async () => {
		const module = await import("../../src/security/network/network-approval.ts").catch(() => undefined);
		let brokerCalls = 0;
		const broker = { request: async (request: { readonly url: string }) => {
			brokerCalls += 1;
			return { status: 200, headers: {}, body: Buffer.from("ok"), finalUrl: request.url };
		} };
		const input = { url: "https://api.example/data", method: "GET", headers: {}, maxBytes: 1024 };
		const withoutReview = await new PolicyNetworkClient(broker, { mode: "review", allowedHosts: [] }).request(input);
		expect(withoutReview).toMatchObject({ ok: false, error: { code: "network_denied" } });
		const review = module === undefined ? undefined : new module.NetworkApprovalService({ review: async () => "allow" });
		const withReview = await new PolicyNetworkClient(broker, { mode: "review", allowedHosts: [] }, review).request(input);
		expect(withReview).toMatchObject({ ok: true, value: { status: 200 } });
		expect(brokerCalls).toBe(1);
	});

	it("turns a review allowlist miss into ask while keeping explicit allowlist misses denied", () => {
		const base: SecuritySnapshot = {
			profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "review", allowedHosts: ["trusted.example"] }, sandbox: "workspace-write" },
			filesystem: { readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [], protectedPaths: [] },
			rules: [], sources: ["builtin"], workspaceRoot: "/repo", tempRoot: "/tmp/runledger",
			policyDigest: runtimeDigest("network-review"), createdAt: "2026-08-11T00:00:00.000Z",
		};
		const engine = new PermissionEngine();
		expect(engine.evaluate([{ kind: "network", operation: "fetch", host: "other.example", protocol: "https" }], base).decision).toBe("ask");
		const allowlist = { ...base, profile: { ...base.profile, network: { mode: "allowlist" as const, allowedHosts: ["trusted.example"] } } };
		expect(engine.evaluate([{ kind: "network", operation: "fetch", host: "other.example", protocol: "https" }], allowlist).decision).toBe("deny");
	});
});
