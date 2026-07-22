import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { canonicalDigest } from "../../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/v3/ids.ts";
import {
	PostCompactionRecallCache,
	PreCompactionMemoryFlush,
	sessionEligibleForExtraction,
} from "../../../../src/runtime/context/memory/extraction.ts";
import { acquireSessionExtractionLease } from "../../../../src/storage/memory-extraction-lease.ts";
import { createMemoryPromotionCandidate } from "../../../../src/runtime/context/memory/promotion.ts";
import type { MemoryRecord, MemoryRef, MemorySearchReceipt } from "../../../../src/runtime/context/memory/types.ts";
import {
	DIGEST,
	NOW,
	approvalReceipt,
	artifact,
	authorityId,
	principalId,
	sessionId,
	tenantId,
	workspaceId,
} from "../../plan-context-memory/helpers.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function approvedMemory(): MemoryRef {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		memoryId: createRuntimeId("memory", "promotion"),
		scope: { scope: "workspace", workspaceId },
		revision: 1,
		contentDigest: canonicalDigest("promotion memory"),
		status: "approved",
	};
}

function evidence(key: string, kind: "test_report" | "session_report" = "session_report") {
	return { ...artifact(canonicalDigest(key)), kind } as const;
}

function record(revision = 1): MemoryRecord {
	const content = "approved memory";
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		memoryId: createRuntimeId("memory", "cache"),
		scope: { scope: "workspace", workspaceId },
		revision,
		status: "approved",
		title: "Cache",
		content,
		contentDigest: canonicalDigest(content),
		sourceRefs: [{
			authorityId,
			tenantId,
			sourceDigest: canonicalDigest("source"),
			trust: "user_approved",
			taint: [],
			observedAt: NOW,
			sourceType: "user",
			principalId,
		}],
		approvalReceipt: approvalReceipt(),
		createdByPrincipalId: principalId,
		createdAt: NOW,
		updatedAt: NOW,
		revocationRevision: 0,
	};
}

function searchReceipt(memory: MemoryRecord): MemorySearchReceipt {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		principalId,
		requestId: createRuntimeId("command", "recall"),
		receiptId: createRuntimeId("receipt", "recall"),
		queryDigest: DIGEST,
		mode: "lexical",
		indexDigest: DIGEST,
		results: [{
			memory: {
				schemaVersion: 1,
				authorityId,
				tenantId,
				memoryId: memory.memoryId,
				scope: memory.scope,
				revision: memory.revision,
				contentDigest: memory.contentDigest,
				status: "approved",
			},
			score: 1,
			stale: false,
			snippet: memory.content,
			lineStart: 1,
			lineEnd: 1,
			sourceDigest: DIGEST,
		}],
		diagnostics: [],
		searchedAt: NOW,
	};
}

describe("Memory extraction boundaries", () => {
	it("flushes at most once per compaction cycle and never enables tools", async () => {
		const flush = new PreCompactionMemoryFlush();
		let calls = 0;
		let proposed: { title: string; content: string } | undefined;
		const options = {
			cycleId: "cycle-1",
			estimatedTokens: 1_000,
			flushThresholdTokens: 900,
			trustedProjection: "trusted",
			sampler: {
				sample: async (_input: string, sampleOptions: { tools: readonly []; timeoutMs: number; maxOutputTokens: number }) => {
					calls += 1;
					expect(sampleOptions.tools).toEqual([]);
					return "# Durable rule\nRun the repository check.";
				},
			},
			timeoutMs: 1_000,
			maxOutputTokens: 256,
			maxOutputChars: 1_024,
			existingContentDigests: [] as readonly string[],
			propose: async (title: string, content: string) => { proposed = { title, content }; },
		};
		expect(await flush.run(options)).toMatchObject({ outcome: "proposed" });
		expect(await flush.run(options)).toEqual({ outcome: "already_flushed" });
		expect(calls).toBe(1);
		expect(proposed).toEqual({ title: "Durable rule", content: "Run the repository check." });
	});

	it("handles NO_REPLY, secrets, duplicates, timeout, failure and concurrent busy without blocking compaction", async () => {
		const base = {
			estimatedTokens: 1_000,
			flushThresholdTokens: 900,
			trustedProjection: "trusted",
			timeoutMs: 20,
			maxOutputTokens: 256,
			maxOutputChars: 1_024,
			existingContentDigests: [] as readonly string[],
			propose: async () => undefined,
		};
		expect(await new PreCompactionMemoryFlush().run({ ...base, cycleId: "empty", sampler: { sample: async () => "NO_REPLY" } })).toMatchObject({ outcome: "empty" });
		expect(await new PreCompactionMemoryFlush().run({ ...base, cycleId: "secret", sampler: { sample: async () => "# Secret\nsk-abcdefghijklmnopqrstuvwxyz123456" } })).toMatchObject({ outcome: "invalid" });
		const duplicate = "same content";
		expect(await new PreCompactionMemoryFlush().run({
			...base,
			cycleId: "duplicate",
			existingContentDigests: [canonicalDigest(duplicate)],
			sampler: { sample: async () => `# Duplicate\n${duplicate}` },
		})).toMatchObject({ outcome: "duplicate" });
		const timed = new PreCompactionMemoryFlush();
		expect(await timed.run({
			...base,
			cycleId: "timeout",
			sampler: { sample: async () => new Promise<string>(() => undefined) },
		})).toMatchObject({ outcome: "failed" });
		expect(await timed.run({ ...base, cycleId: "timeout", sampler: { sample: async () => "# Retry\nforbidden" } })).toEqual({ outcome: "already_flushed" });
		expect(await new PreCompactionMemoryFlush().run({
			...base,
			cycleId: "failure",
			sampler: { sample: async () => { throw new Error("sampler failed"); } },
		})).toMatchObject({ outcome: "failed" });

		let release: ((value: string) => void) | undefined;
		const blocking = new PreCompactionMemoryFlush();
		const first = blocking.run({
			...base,
			timeoutMs: 1_000,
			cycleId: "blocking",
			sampler: { sample: async () => new Promise<string>((resolve) => { release = resolve; }) },
		});
		expect(blocking.isFlushing).toBe(true);
		expect(await blocking.run({ ...base, cycleId: "other", sampler: { sample: async () => "NO_REPLY" } })).toEqual({ outcome: "busy" });
		if (release === undefined) throw new Error("blocking sampler was not started");
		release("NO_REPLY");
		expect(await first).toMatchObject({ outcome: "empty" });
		expect(blocking.isFlushing).toBe(false);
	});

	it("invalidates post-compaction recall when canonical records change", () => {
		const cache = new PostCompactionRecallCache();
		const first = record(1);
		const receipt = searchReceipt(first);
		cache.set("checkpoint-1", [first], receipt);
		expect(cache.get("checkpoint-1", [first])).toEqual(receipt);
		expect(cache.get("checkpoint-1", [{ ...first, revision: 2 }])).toBeUndefined();
		cache.invalidate("checkpoint-1");
		expect(cache.get("checkpoint-1", [first])).toBeUndefined();
	});

	it("uses an exclusive cross-process extraction lease and explicit eligibility", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-extraction-"));
		roots.push(root);
		const leasePath = join(root, "session.lock");
		const lease = await acquireSessionExtractionLease({ path: leasePath, sessionId, owner: "parent", now: new Date(NOW), ttlMs: 60_000 });
		expect(lease).toBeDefined();
		expect(await acquireSessionExtractionLease({ path: leasePath, sessionId, owner: "same-process", now: new Date(NOW), ttlMs: 60_000 })).toBeUndefined();

		const moduleUrl = pathToFileURL(join(process.cwd(), "src/storage/memory-extraction-lease.ts")).href;
		const script = `import { acquireSessionExtractionLease } from ${JSON.stringify(moduleUrl)}; const lease = await acquireSessionExtractionLease({ path: ${JSON.stringify(leasePath)}, sessionId: ${JSON.stringify(sessionId)}, owner: "child", now: new Date(${JSON.stringify(NOW)}), ttlMs: 60000 }); process.stdout.write(lease === undefined ? "busy" : "acquired"); if (lease) await lease.release();`;
		const busy = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd() });
		expect(busy.stdout).toBe("busy");
		await lease?.release();
		const acquired = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd() });
		expect(acquired.stdout).toBe("acquired");

		expect(sessionEligibleForExtraction({ endedAt: NOW, now: new Date("2026-07-22T00:10:00.000Z"), minimumAgeMs: 60_000, alreadyProcessed: false, terminal: true })).toBe(true);
		expect(sessionEligibleForExtraction({ endedAt: NOW, now: new Date("2026-07-22T00:10:00.000Z"), minimumAgeMs: 60_000, alreadyProcessed: true, terminal: true })).toBe(false);
	});
});

describe("Memory experience promotion", () => {
	it("enforces case -> repository rule -> repeated validation -> regression suite -> managed global handoff", () => {
		const memory = approvedMemory();
		const caseCandidate = createMemoryPromotionCandidate({ memory, targetLevel: "case", evidenceArtifacts: [evidence("case")] });
		const repository = createMemoryPromotionCandidate({ memory, previous: caseCandidate, targetLevel: "repository_rule", evidenceArtifacts: [evidence("repository")] });
		const repeated = createMemoryPromotionCandidate({
			memory,
			previous: repository,
			targetLevel: "repeated_validation",
			evidenceArtifacts: [evidence("validation-1", "test_report"), evidence("validation-2", "test_report")],
		});
		const regression = createMemoryPromotionCandidate({ memory, previous: repeated, targetLevel: "regression_suite", evidenceArtifacts: [evidence("regression", "test_report")] });
		const global = createMemoryPromotionCandidate({ memory, previous: regression, targetLevel: "global_rule", evidenceArtifacts: [evidence("global-regression", "test_report")] });

		expect([caseCandidate, repository, repeated, regression, global].every((candidate) => candidate.directPublicationAllowed === false)).toBe(true);
		expect(global.disposition).toBe("managed_handoff_required");
		expect(global).not.toHaveProperty("approvalReceipt");
		expect(() => createMemoryPromotionCandidate({ memory, previous: global, targetLevel: "global_rule", evidenceArtifacts: [evidence("again", "test_report")] })).toThrow("terminal");
	});

	it("fails closed on skipped levels, weak validation, cross-tenant evidence or prior digest drift", () => {
		const memory = approvedMemory();
		expect(() => createMemoryPromotionCandidate({ memory, targetLevel: "repository_rule", evidenceArtifacts: [evidence("skip")] })).toThrow("exactly one level");
		const caseCandidate = createMemoryPromotionCandidate({ memory, targetLevel: "case", evidenceArtifacts: [evidence("case-2")] });
		const repository = createMemoryPromotionCandidate({ memory, previous: caseCandidate, targetLevel: "repository_rule", evidenceArtifacts: [evidence("repository-2")] });
		expect(() => createMemoryPromotionCandidate({ memory, previous: repository, targetLevel: "repeated_validation", evidenceArtifacts: [evidence("only-one", "test_report")] })).toThrow("two distinct");
		expect(() => createMemoryPromotionCandidate({
			memory,
			targetLevel: "case",
			evidenceArtifacts: [{ ...evidence("foreign"), tenantId: createRuntimeId("tenant", "foreign") }],
		})).toThrow("authority or tenant");
		expect(() => createMemoryPromotionCandidate({
			memory,
			previous: { ...caseCandidate, candidateDigest: canonicalDigest("tampered") },
			targetLevel: "repository_rule",
			evidenceArtifacts: [evidence("tampered")],
		})).toThrow("digest drifted");
	});
});
