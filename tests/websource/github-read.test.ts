import { describe, expect, it } from "vitest";
import { executeGitHubRead } from "../../src/websource/github-read.ts";
import type { WebSearchCredentialPort } from "../../src/websource/credentials.ts";
import type { WebSearchFetch } from "../../src/websource/transport.ts";

function credentials(token?: string): WebSearchCredentialPort {
	return {
		has: async () => token !== undefined,
		getApiKey: async () => token,
		getConfig: async () => undefined,
	};
}

describe("GitHub read transport", () => {
	it("constructs a fixed repository endpoint and passes the injected credential", async () => {
		let requested = "";
		let authorization: string | null = null;
		const fetch: WebSearchFetch = async (input, init) => {
			requested = input;
			authorization = new Headers(init?.headers).get("authorization");
			return Response.json({ full_name: "acme/widget", description: "A widget", visibility: "public", default_branch: "main" });
		};
		const result = await executeGitHubRead({ op: "repo_view", repo: "acme/widget" }, { fetch, credentials: credentials("secret") });
		expect(result).toMatchObject({ ok: true, details: { endpoint: "/repos/acme/widget" } });
		expect(result.text).toContain("# acme/widget");
		expect(requested).toBe("https://api.github.com/repos/acme/widget");
		expect(authorization).toBe("Bearer secret");
	});

	it("reads base64 text but returns a bounded binary notice", async () => {
		const fetch: WebSearchFetch = async () => Response.json({
			type: "file", encoding: "base64", content: Buffer.from("hello\n").toString("base64"), size: 6,
		});
		const text = await executeGitHubRead({ op: "file_read", repo: "acme/widget", path: "README.md" }, { fetch, credentials: credentials() });
		expect(text).toMatchObject({ ok: true, text: "hello\n" });
		const binaryFetch: WebSearchFetch = async () => Response.json({
			type: "file", encoding: "base64", content: Buffer.from([0, 1, 2]).toString("base64"), size: 3,
		});
		const binary = await executeGitHubRead({ op: "file_read", repo: "acme/widget", path: "logo.bin" }, { fetch: binaryFetch, credentials: credentials() });
		expect(binary).toMatchObject({ ok: true });
		expect(binary.text).toContain("Cannot read binary file");
	});

	it("keeps queries bounded and maps GitHub failures to stable tool output", async () => {
		let url = "";
		const fetch: WebSearchFetch = async (input) => {
			url = input;
			return new Response("rate limited", { status: 403 });
		};
		const result = await executeGitHubRead({ op: "search_prs", query: "repo:acme/widget bug", limit: 4 }, { fetch, credentials: credentials() });
		expect(result).toMatchObject({ ok: false, details: { status: 403 } });
		expect(result.text).toContain("rate limit");
		expect(url).toContain("/search/issues?");
		expect(url).toContain(encodeURIComponent("repo:acme/widget bug is:pr"));
	});

	it("rejects path escape before any request", async () => {
		let called = false;
		const fetch: WebSearchFetch = async () => {
			called = true;
			return Response.json({});
		};
		await expect(executeGitHubRead({ op: "file_read", repo: "acme/widget", path: "../secret" }, { fetch, credentials: credentials() }))
			.rejects.toThrow("escapes repository root");
		expect(called).toBe(false);
	});
});
