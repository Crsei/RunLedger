import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { ModelCapabilityProfile, ModelRouteRequest } from "../../../src/runtime/model-routing/types.ts";
import { loadCanonicalModelCompatibilityRouter } from "../../../src/cli/runtime-host-model-manifest.ts";

function profile(overrides: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
	return {
		profileId: "provider/summarizer",
		providerId: "provider",
		modelId: "summarizer",
		manifestVersion: "1",
		manifestDigest: runtimeDigest("profile-manifest"),
		contextWindow: 16_384,
		maxOutputTokens: 2_048,
		reasoningProtocol: "none",
		toolProtocol: "none",
		imageInput: false,
		compaction: "summary",
		status: "verified",
		...overrides,
	};
}

function manifest(profiles: readonly ModelCapabilityProfile[]) {
	const body = { version: 1 as const, profiles, aliases: { summarizer: profiles[0]!.profileId } };
	return { ...body, manifestDigest: runtimeDigest(body) };
}

function request(targetProfileId = "summarizer"): ModelRouteRequest {
	return {
		requestId: createRuntimeId("command", "manifest-loader-request"),
		operation: "summarize",
		targetProfileId,
		contextDigest: runtimeDigest("context"),
		planDigest: runtimeDigest("plan"),
		resourceDigest: runtimeDigest("resources"),
		requiredContextTokens: 1_024,
		requiredOutputTokens: 256,
		requiresTools: false,
		requiresReasoningReplay: false,
		requiresImages: false,
		traceId: createRuntimeId("trace", "manifest-loader-request"),
	};
}

describe("canonical model compatibility manifest loader", () => {
	it("loads the exact canonical manifest and routes the summarizer alias", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-model-manifest-"));
		const layout = buildRunledgerLayout(root, "posix");
		try {
			const document = manifest([profile()]);
			const path = join(layout.state, "model-compatibility", "manifest.json");
			await mkdir(join(layout.state, "model-compatibility"), { recursive: true });
			await writeFile(path, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });

			const loaded = await loadCanonicalModelCompatibilityRouter(layout);
			expect(loaded.ok).toBe(true);
			if (!loaded.ok) return;
			expect(loaded.path).toBe(path);
			expect(loaded.manifest.manifestDigest).toEqual(document.manifestDigest);
			expect(loaded.router.route(request()).outcome).toBe("compatible");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed for a missing or invalid canonical manifest without a built-in fallback", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-model-manifest-missing-"));
		const layout = buildRunledgerLayout(root, "posix");
		try {
			const missing = await loadCanonicalModelCompatibilityRouter(layout);
			expect(missing).toMatchObject({ ok: false, error: { code: "manifest_missing" } });

			const path = join(layout.state, "model-compatibility", "manifest.json");
			await mkdir(join(layout.state, "model-compatibility"), { recursive: true });
			await writeFile(path, JSON.stringify({ version: 1, profiles: [], aliases: {}, manifestDigest: runtimeDigest("wrong") }), { encoding: "utf8", mode: 0o600 });
			const invalid = await loadCanonicalModelCompatibilityRouter(layout);
			expect(invalid).toMatchObject({ ok: false, error: { code: "manifest_invalid" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
