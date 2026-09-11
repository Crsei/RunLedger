import { mkdtemp, mkdir, rm, stat, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliPromptDumpPort } from "../../src/cli/prompt-dump-artifacts.ts";
import { buildRunledgerLayout, type RunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { PromptDumpDocument } from "../../src/tui/interactive/types.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ home: string; layout: RunledgerLayout }> {
	const root = await mkdtemp(join(tmpdir(), "runledger-prompt-dump-"));
	cleanup.push(root);
	const home = join(root, "home");
	await mkdir(home, { recursive: true, mode: 0o700 });
	return { home, layout: buildRunledgerLayout(home, "posix") };
}

function document(sessionId: string): PromptDumpDocument {
	return {
		kind: "runledger.prompt-dump",
		sessionId,
		capturedAtMs: 1_700_000_000_000,
		selection: { thinkingLevel: "high" },
		prompt: {
			systemPrompt: "assembled prompt",
			tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
			source: "assembled",
			turn: 2,
			assembledPromptDigest: runtimeDigest("assembled prompt"),
		},
	};
}

describe("createCliPromptDumpPort", () => {
	it("writes a 0600 document under the layout tmp directory", async () => {
		const { home, layout } = await fixture();
		const result = await createCliPromptDumpPort(layout).write(document("sess_01H"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.path.startsWith(join(home, "tmp", "dump"))).toBe(true);
		expect((await stat(result.path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(home, "tmp", "dump"))).mode & 0o777).toBe(0o700);
		expect(JSON.parse(await readFile(result.path, "utf8"))).toMatchObject({
			kind: "runledger.prompt-dump",
			prompt: { systemPrompt: "assembled prompt", source: "assembled" },
		});
	});

	it("refuses a symlinked dump directory instead of following it", async () => {
		const { home, layout } = await fixture();
		const elsewhere = join(home, "elsewhere");
		await mkdir(elsewhere, { recursive: true, mode: 0o700 });
		await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
		await symlink(elsewhere, join(home, "tmp", "dump"));

		expect(await createCliPromptDumpPort(layout).write(document("sess_01H"))).toEqual({
			ok: false,
			code: "prompt_dump_directory_symlink",
		});
	});
});
