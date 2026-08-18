import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";
import { runWithProviderProxyFetch } from "../../src/utils/provider-fetch-context.ts";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	while (servers.length > 0) {
		const server = servers.pop();
		if (!server) continue;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe("provider fetch context in Bun", () => {
	test("routes a scoped SDK fetch without recursively re-entering the router", async () => {
		const requests: string[] = [];
		const proxy = createServer((request, response) => {
			requests.push(request.url ?? "");
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("proxied");
		});
		servers.push(proxy);
		await new Promise<void>((resolve, reject) => {
			proxy.once("error", reject);
			proxy.listen(0, "127.0.0.1", resolve);
		});
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("Expected an ephemeral proxy address");

		const response = await runWithProviderProxyFetch(
			"http://target.runledger.test",
			`http://127.0.0.1:${address.port}`,
			() => globalThis.fetch("http://target.runledger.test/request"),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("proxied");
		expect(requests).toEqual(["http://target.runledger.test/request"]);
	});
});
