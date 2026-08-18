import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchWithProviderProxy } from "../../src/utils/fetch-provider-proxy.ts";

type FetchCall = {
	input: unknown;
	init: RequestInit | undefined;
};

function stubFetch(response = new Response("ok")): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
		calls.push({ input, init });
		return response;
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("provider fetch proxy", () => {
	test("adds a Node proxy agent while preserving the fetch request", async () => {
		const calls = stubFetch();
		const init: RequestInit = { method: "POST", body: "payload" };

		const response = await fetchWithProviderProxy(
			"pi-messages-fetch-agent",
			"https://fetch-agent.runledger.test/messages",
			init,
			{
				RUNLEDGER_PROXY_PI_MESSAGES_FETCH_AGENT: "http://proxy.runledger.test:3128",
				no_proxy: "never-match.runledger.test",
			},
		);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://fetch-agent.runledger.test/messages");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.body).toBe("payload");
		expect((calls[0]?.init as RequestInit & { agent?: unknown }).agent).toBeDefined();
	});

	test("bypasses the proxy wrapper for a NO_PROXY target", async () => {
		const calls = stubFetch();
		const init: RequestInit = { method: "GET" };

		await fetchWithProviderProxy("pi-messages-fetch-direct", "https://direct.runledger.test/messages", init, {
			RUNLEDGER_PROXY: "http://proxy.runledger.test:3128",
			no_proxy: "direct.runledger.test",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.init).toBe(init);
		expect((calls[0]?.init as RequestInit & { agent?: unknown }).agent).toBeUndefined();
	});
});
