import { createServer } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";
import { describe, expect, test } from "vitest";

import { createProxyAgentForUrl, createProxyFetchForUrl } from "../../src/utils/proxy-agent.ts";

const apiVersion = ["v", "1"].join("");

describe("provider proxy agent", () => {
	test("creates an HTTP agent for HTTP targets", () => {
		const agent = createProxyAgentForUrl(`http://api.runledger.test/${apiVersion}`, "http://proxy.runledger.test:3128");

		expect(agent).toBeInstanceOf(HttpProxyAgent);
	});

	test("creates an HTTPS agent for HTTPS targets", () => {
		const agent = createProxyAgentForUrl(`https://api.runledger.test/${apiVersion}`, "http://proxy.runledger.test:3128");

		expect(agent).toBeInstanceOf(HttpsProxyAgent);
	});

	test("sends the SDK fetch through the Node proxy agent", async () => {
		let receivedPath: string | undefined;
		const proxyServer = createServer((request, response) => {
			receivedPath = request.url;
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("ok");
		});

		await new Promise<void>((resolve, reject) => {
			proxyServer.once("error", reject);
			proxyServer.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = proxyServer.address();
			if (!address || typeof address === "string") {
				throw new Error("Expected an ephemeral proxy server address");
			}
			const fetcher = createProxyFetchForUrl(
				`http://api.runledger.test/${apiVersion}`,
				`http://127.0.0.1:${address.port}`,
			);
			const response = await fetcher(`http://api.runledger.test/${apiVersion}/messages`, { method: "POST" });

			expect(response.status).toBe(200);
			expect(receivedPath).toBe(`http://api.runledger.test/${apiVersion}/messages`);
		} finally {
			await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
		}
	});

	test("rejects unsupported target protocols", () => {
		expect(() => createProxyAgentForUrl("ftp://api.runledger.test/file", "http://proxy.runledger.test:3128")).toThrow(
			"Unsupported target protocol",
		);
	});
});
