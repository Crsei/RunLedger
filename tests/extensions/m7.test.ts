import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Meter } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { compatibilitySkillRoots } from "../../src/extensions/compatibility-importer.ts";
import { HttpHookHandler } from "../../src/extensions/hooks/http-handler.ts";
import { MarketplaceInstaller } from "../../src/extensions/marketplace/installer.ts";
import type {
	MarketplaceActivationReceipt,
	MarketplaceApprovalReceipt,
	MarketplaceDownloadReceipt,
	MarketplaceLocator,
	MarketplaceProbeReceipt,
	MarketplaceVerificationReceipt,
	PluginVersionStorePort,
} from "../../src/extensions/marketplace/types.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { ExtensionMetrics } from "../../src/extensions/metrics/extension-metrics.ts";
import { ExtensionConfigWatcher } from "../../src/extensions/watcher/config-watcher.ts";
import type { HookEnvelope } from "../../src/extensions/hooks/types.ts";
import { makeExtensionTempDir, NodeTestExtensionStorage, removeExtensionTempDir } from "./helpers.ts";

const storage = new NodeTestExtensionStorage();
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function temporary(label: string): Promise<string> {
	const path = await makeExtensionTempDir(label);
	temporaryDirectories.push(path);
	return path;
}

function marketplaceFixture() {
	const locator: MarketplaceLocator = { packageName: "team-tools", version: "1.2.3", publisherId: "publisher-1", sourceUrl: "https://market.example/team-tools-1.2.3.tgz", expectedDigest: "a".repeat(64), expectedSignature: "signature-fixture-value" };
	const download: MarketplaceDownloadReceipt = { stagedRoot: "/staging/team-tools", bytes: 1_024, digest: locator.expectedDigest, sourceUrl: locator.sourceUrl, downloadReceiptId: "download-1" };
	const verification: MarketplaceVerificationReceipt = { signatureValid: true, publisherTrusted: true, publisherRevision: 4, verificationReceiptId: "verification-1" };
	const probe: MarketplaceProbeReceipt = { ok: true, manifestDigest: "manifest", capabilityDigest: "capability", containsExecutableResources: false, probeReceiptId: "probe-1" };
	const approval: MarketplaceApprovalReceipt = { receiptId: "approval-1", packageName: locator.packageName, version: locator.version, digest: locator.expectedDigest, capabilityDigest: probe.capabilityDigest, profile: "metadata-only", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" };
	const activation: MarketplaceActivationReceipt = { packageName: locator.packageName, version: locator.version, digest: locator.expectedDigest, activationReceiptId: "activation-1" };
	const staged: string[] = [];
	const store: PluginVersionStorePort = {
		stageVerified: async () => { staged.push("staged"); return "/verified/team-tools"; },
		activate: async () => activation,
		active: async () => activation,
		uninstall: async () => true,
		rollback: async () => ({ ...activation, version: "1.2.2", activationReceiptId: "rollback-1" }),
	};
	const installer = new MarketplaceInstaller({
		download: { downloadToStaging: async () => download },
		signatures: { verify: async () => verification },
		probe: { probe: async () => probe },
		approvals: { authorize: async () => approval },
		store,
		cooldownMs: 60_000,
	});
	return { locator, download, verification, probe, approval, activation, staged, store, installer };
}

function hookEnvelope(payload: Readonly<Record<string, unknown>> = { toolName: "Read", input: { path: "README.md" } }): HookEnvelope {
	return { schemaVersion: 1, event: "PreToolUse", eventId: "http-hook", timestamp: "2026-07-22T00:00:00.000Z", sessionId: "session-http-hook", cwd: "/workspace", snapshotId: "snapshot-http-hook", source: "project", payload };
}

describe("M7 hardened extension capabilities", () => {
	it("requires an exact marketplace locator, trusted publisher, bounded probe, exact approval and cooldown before atomic activation", async () => {
		const fixture = marketplaceFixture();
		expect(await fixture.installer.install(fixture.locator)).toMatchObject({ ok: true, value: fixture.activation });
		expect(fixture.staged).toEqual(["staged"]);
		expect(await fixture.installer.install({ ...fixture.locator, version: "latest" })).toMatchObject({ ok: false, code: "invalid_locator" });
		const digestMismatch = new MarketplaceInstaller({ download: { downloadToStaging: async () => ({ ...fixture.download, digest: "b".repeat(64) }) }, signatures: { verify: async () => fixture.verification }, probe: { probe: async () => fixture.probe }, approvals: { authorize: async () => fixture.approval }, store: fixture.store });
		expect(await digestMismatch.install(fixture.locator)).toMatchObject({ ok: false, code: "digest_mismatch" });
		const untrusted = new MarketplaceInstaller({ download: { downloadToStaging: async () => fixture.download }, signatures: { verify: async () => ({ ...fixture.verification, publisherTrusted: false }) }, probe: { probe: async () => fixture.probe }, approvals: { authorize: async () => fixture.approval }, store: fixture.store });
		expect(await untrusted.install(fixture.locator)).toMatchObject({ ok: false, code: "publisher_untrusted" });
		const executable = new MarketplaceInstaller({ download: { downloadToStaging: async () => fixture.download }, signatures: { verify: async () => fixture.verification }, probe: { probe: async () => ({ ...fixture.probe, containsExecutableResources: true }) }, approvals: { authorize: async () => fixture.approval }, store: fixture.store });
		expect(await executable.install(fixture.locator)).toMatchObject({ ok: false, code: "approval_required" });
		const recent = { ...fixture.approval, approvedAt: new Date().toISOString() };
		const cooling = new MarketplaceInstaller({ download: { downloadToStaging: async () => fixture.download }, signatures: { verify: async () => fixture.verification }, probe: { probe: async () => fixture.probe }, approvals: { authorize: async () => recent }, store: fixture.store, cooldownMs: 60_000 });
		expect(await cooling.install(fixture.locator, "update")).toMatchObject({ ok: false, code: "cooldown" });
		expect(await fixture.installer.rollback("team-tools", "1.2.3")).toMatchObject({ ok: true, value: { version: "1.2.2" } });
	});

	it("stores only opaque OAuth handles in 0600 metadata and revokes them on logout", async () => {
		const root = await temporary("mcp-oauth");
		const metadataPath = join(root, "oauth.json");
		const revoked: string[] = [];
		const store = new McpOAuthCredentialStore(metadataPath, storage, {
			store: async ({ audience, credentialMaterial }) => {
				expect(credentialMaterial).toBe("raw-access-token");
				return { handleId: "credential-handle", audienceDigest: canonicalDigest(audience), issuedAt: "2026-07-22T00:00:00.000Z" };
			},
			revoke: async (handleId) => { revoked.push(handleId); return true; },
		});
		const handle = await store.login({
			serverId: "mcp-server:project:fixture",
			provider: {
				begin: async () => ({ authorizationUrl: "https://auth.example/authorize", state: "state", verifierHandle: "verifier" }),
				complete: async ({ code }) => { expect(code).toBe("code"); return { audience: "https://mcp.example", credentialMaterial: "raw-access-token" }; },
			},
			authorizationServer: "https://auth.example",
			redirectUri: "http://127.0.0.1/callback",
			receiveCode: async () => "code",
		});
		expect(handle.handleId).toBe("credential-handle");
		const metadata = await readFile(metadataPath, "utf8");
		expect(metadata).toContain("credential-handle");
		expect(metadata).not.toContain("raw-access-token");
		expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
		expect(await store.logout("mcp-server:project:fixture")).toBe(true);
		expect(revoked).toEqual(["credential-handle"]);
	});

	it("enforces HTTPS, public DNS, exact approval, same-origin redirect and connected-address pinning for HTTP hooks", async () => {
		const url = "https://hooks.example.test/run";
		let addresses: readonly string[] = ["203.0.113.10"];
		let finalUrl = url;
		let connectedAddress = "203.0.113.10";
		let stale = false;
		let sensitive = false;
		const handler = new HttpHookHandler({
			dns: { resolve: async () => addresses },
			authorization: {
				authorize: async (input) => {
					sensitive = input.containsSensitiveData;
					return { receiptId: "http-hook-approval", urlDigest: canonicalDigest(input.url), payloadDigest: input.payloadDigest, expiresAt: stale ? "2000-01-01T00:00:00.000Z" : "2999-01-01T00:00:00.000Z" };
				},
			},
			client: { post: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ decision: "allow", additionalContext: "checked" })), finalUrl, connectedAddress }) },
		});
		expect(await handler.invoke(url, hookEnvelope({ token: "sensitive", input: {} }))).toMatchObject({ ok: true, output: { decision: "allow" } });
		expect(sensitive).toBe(true);
		expect(await handler.invoke("http://hooks.example.test/run", hookEnvelope())).toMatchObject({ ok: false, reason: expect.stringContaining("HTTPS") });
		addresses = ["127.0.0.1"];
		expect(await handler.invoke(url, hookEnvelope())).toMatchObject({ ok: false, reason: expect.stringContaining("DNS result") });
		addresses = ["203.0.113.10"];
		stale = true;
		expect(await handler.invoke(url, hookEnvelope())).toMatchObject({ ok: false, reason: expect.stringContaining("missing or stale") });
		stale = false;
		finalUrl = "https://other.example/run";
		expect(await handler.invoke(url, hookEnvelope())).toMatchObject({ ok: false, reason: expect.stringContaining("cross-origin") });
		finalUrl = url;
		connectedAddress = "203.0.113.11";
		expect(await handler.invoke(url, hookEnvelope())).toMatchObject({ ok: false, reason: expect.stringContaining("rebinding") });
	});

	it("debounces sorted watcher changes and keeps compatibility imports disabled unless explicitly requested", async () => {
		let listener: ((path: string) => void) | undefined;
		let callback: (() => void) | undefined;
		let closed = false;
		const reloads: readonly string[][] = [];
		const watcher = new ExtensionConfigWatcher({
			watcher: { watch: async (paths, next) => { expect(paths).toEqual(["a", "b"]); listener = next; return { close: async () => { closed = true; } }; } },
			scheduler: { schedule: (_key, delayMs, next) => { expect(delayMs).toBe(250); callback = next; }, cancel: () => { callback = undefined; } },
			onReloadRequested: (paths) => { (reloads as string[][]).push([...paths]); },
		});
		await watcher.start(["b", "a", "b"]);
		listener?.("z");
		listener?.("a");
		callback?.();
		expect(reloads).toEqual([["a", "z"]]);
		await watcher.close();
		expect(closed).toBe(true);
		const root = await temporary("compatibility");
		await mkdir(join(root, ".claude"));
		const disabled = await compatibilitySkillRoots({ projectRoot: root, storage });
		expect(disabled.roots).toHaveLength(0);
		expect(disabled.diagnostics.filter((item) => item.code === "compatibility.disabled")).toHaveLength(3);
		const enabled = await compatibilitySkillRoots({ projectRoot: root, storage, enabledSources: ["claude"] });
		expect(enabled.roots).toHaveLength(1);
		expect(enabled.diagnostics.map((item) => item.code)).toContain("compatibility.enabled");
	});

	it("records bounded OTel counters and latency without replacing audit", () => {
		const counters: Array<{ name: string; value: number }> = [];
		const histograms: number[] = [];
		const meter = {
			createCounter: (name: string) => ({ add: (value: number) => counters.push({ name, value }) }),
			createHistogram: () => ({ record: (value: number) => histograms.push(value) }),
		} as unknown as Meter;
		const metrics = new ExtensionMetrics(meter);
		metrics.record({ kind: "mcp", operation: "call", ok: false, durationMs: 42 });
		expect(counters.map((item) => item.name)).toEqual(["runledger.extensions.operations", "runledger.extensions.failures"]);
		expect(histograms).toEqual([42]);
	});
});
