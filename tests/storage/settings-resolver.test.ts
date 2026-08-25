import { describe, expect, it } from "vitest";
import { SettingsResolver } from "../../src/storage/settings-resolver.ts";

describe("SettingsResolver", () => {
	it("applies override > workspace > user > schema default precedence and returns frozen groups", () => {
		const resolver = new SettingsResolver({
			user: { retry: { maxRetries: 2, baseDelayMs: 100 }, recap: { idleSeconds: 120 } },
			workspace: { retry: { baseDelayMs: 400 } },
			overrides: { retry: { maxRetries: 4 } },
		});

		expect(resolver.get("retry.maxRetries")).toBe(4);
		expect(resolver.get("retry.baseDelayMs")).toBe(400);
		expect(resolver.get("retry.maxDelayMs")).toBe(10_000);
		expect(resolver.get("recap.idleSeconds")).toBe(120);
		expect(resolver.getGroup("retry")).toEqual({
			enabled: true,
			maxRetries: 4,
			baseDelayMs: 400,
			maxDelayMs: 10_000,
		});
		expect(Object.isFrozen(resolver.snapshot())).toBe(true);
		expect(Object.isFrozen(resolver.getGroup("retry"))).toBe(true);
	});

	it("falls back to the next valid layer and preserves invalid diagnostics", () => {
		const resolver = new SettingsResolver({
			user: { retry: { maxRetries: 2 } },
			workspace: { retry: { maxRetries: 99 } },
		});

		expect(resolver.get("retry.maxRetries")).toBe(2);
		expect(resolver.diagnostics()).toContainEqual(expect.objectContaining({
			code: "out_of_range",
			path: "retry.maxRetries",
			source: "workspace",
		}));
	});

	it("keeps digest stable across source key order and does not include raw layer data", () => {
		const first = new SettingsResolver({ user: { retry: { baseDelayMs: 100, maxRetries: 2 } } });
		const second = new SettingsResolver({ user: { retry: { maxRetries: 2, baseDelayMs: 100 } } });

		expect(first.digest().digest).toBe(second.digest().digest);
		expect(first.digest().digest).not.toContain("/tmp");
		expect(JSON.stringify(first.snapshot())).not.toContain("apiKey");
	});

	it("builds one immutable runtime snapshot with source layers and policy diagnostics", () => {
		const resolver = new SettingsResolver({
			user: {
				retry: { maxRetries: 2, baseDelayMs: 100 },
				tools: { approvalMode: "write" },
				providers: { maxInFlightRequests: { openai: 2 } },
				task: { maxConcurrency: 2 },
			},
			workspace: {
				retry: { baseDelayMs: 400 },
				workspace: { additionalDirectories: [".cache"] },
				compaction: { thresholdPercent: 70 },
			},
			overrides: { retry: { maxRetries: 4 }, steeringMode: "all" },
			overrideScope: "session",
		});
		const snapshot = (resolver as unknown as {
			effectiveRuntimeSnapshot(): {
				readonly retry: { readonly maxRetries: number; readonly baseDelayMs: number };
				readonly compaction: { readonly thresholdPercent: number };
				readonly toolPolicy: { readonly approvalPolicy?: string };
				readonly providerPolicy: { readonly maxInFlightRequests?: Readonly<Record<string, number>> };
				readonly taskPolicy: { readonly maxConcurrency: number };
				readonly workspacePolicy: { readonly additionalDirectories: readonly string[] };
				readonly sessionPolicy: { readonly steeringMode: string };
				readonly sourceLayers: Readonly<Record<string, string>>;
				readonly diagnostics: readonly unknown[];
				readonly digest: { readonly digest: string };
			}
		}).effectiveRuntimeSnapshot();

		expect(snapshot.retry).toMatchObject({ maxRetries: 4, baseDelayMs: 400 });
		expect(snapshot.compaction.thresholdPercent).toBe(70);
		expect(snapshot.toolPolicy.approvalPolicy).toBe("on-request");
		expect(snapshot.providerPolicy.maxInFlightRequests).toEqual({ openai: 2 });
		expect(snapshot.taskPolicy.maxConcurrency).toBe(2);
		expect(snapshot.workspacePolicy.additionalDirectories).toEqual([".cache"]);
		expect(snapshot.sessionPolicy.steeringMode).toBe("all");
		expect(snapshot.sourceLayers["retry.maxRetries"]).toBe("session");
		expect(snapshot.sourceLayers["retry.baseDelayMs"]).toBe("workspace");
		expect(snapshot.diagnostics).toEqual([]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.retry)).toBe(true);
		expect(snapshot.digest.digest).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("projects the user-owned shellPath into the immutable runtime snapshot", () => {
		const snapshot = new SettingsResolver({ user: { shellPath: "/usr/local/bin/runledger-shell" } }).effectiveRuntimeSnapshot();
		expect(snapshot.shellPath).toBe("/usr/local/bin/runledger-shell");
		expect(snapshot.sourceLayers.shellPath).toBe("user");
		expect(Object.isFrozen(snapshot)).toBe(true);
	});

	it("lets a workspace disable Git presentation without changing the default", () => {
		const snapshot = new SettingsResolver({ workspace: { git: { enabled: false } } }).effectiveRuntimeSnapshot();
		expect(snapshot.git.enabled).toBe(false);
		expect(snapshot.sourceLayers["git.enabled"]).toBe("workspace");
	});

	it("intersects restrictive user, workspace, and request policy layers", () => {
		const resolver = new SettingsResolver({
			user: {
				disabledProviders: ["openai"],
				tools: { write: { enabled: false }, read: { defaultLimit: 50 } },
				task: { disabledAgents: ["research"], maxRuntimeMs: 5_000 },
			},
			workspace: {
				disabledProviders: ["anthropic"],
				tools: { write: { enabled: true }, read: { defaultLimit: 100 } },
				task: { disabledAgents: ["qa"], maxRuntimeMs: 10_000 },
			},
		});
		const snapshot = resolver.effectiveRuntimeSnapshot();

		expect(snapshot.toolPolicy.write?.enabled).toBe(false);
		expect(snapshot.toolPolicy.read?.defaultLimit).toBe(50);
		expect(snapshot.providerPolicy.disabledProviders).toEqual(["openai", "anthropic"]);
		expect(snapshot.taskPolicy.disabledAgents).toEqual(["research", "qa"]);
		expect(snapshot.taskPolicy.maxRuntimeMs).toBe(5_000);
	});

	it("exposes apply boundaries as immutable runtime metadata", () => {
		const snapshot = new SettingsResolver().effectiveRuntimeSnapshot();

		expect(snapshot.applyModes["display.showTokenUsage"]).toBe("live");
		expect(snapshot.applyModes["retry.maxRetries"]).toBe("next-turn");
		expect(snapshot.applyModes["startup.quiet"]).toBe("startup");
		expect(Object.isFrozen(snapshot.applyModes)).toBe(true);
		expect(snapshot.digest.digest).toMatch(/^[a-f0-9]{64}$/u);
	});
});
