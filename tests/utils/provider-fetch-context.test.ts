import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { runWithProviderProxyFetch } from "../../src/utils/provider-fetch-context.ts";

const servers: Server[] = [];

afterEach(async () => {
	while (servers.length > 0) {
		const server = servers.pop();
		if (!server) continue;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

async function startProxy(label: string): Promise<{ url: string; requests: string[] }> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		response.writeHead(200, { "content-type": "text/plain" });
		response.end(label);
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected an ephemeral proxy address");
	return { url: `http://127.0.0.1:${address.port}`, requests };
}

describe("provider fetch context", () => {
	test("keeps concurrent provider scopes on their own proxy fetch", async () => {
		const firstProxy = await startProxy("first");
		const secondProxy = await startProxy("second");
		let firstEntered!: () => void;
		let secondEntered!: () => void;
		const firstReady = new Promise<void>((resolve) => {
			firstEntered = resolve;
		});
		const secondReady = new Promise<void>((resolve) => {
			secondEntered = resolve;
		});

		const first = runWithProviderProxyFetch("http://first-target.runledger.test", firstProxy.url, async () => {
			firstEntered();
			await secondReady;
			const response = await globalThis.fetch("http://first-target.runledger.test/first");
			return response.text();
		});
		const second = runWithProviderProxyFetch("http://second-target.runledger.test", secondProxy.url, async () => {
			secondEntered();
			await firstReady;
			const response = await globalThis.fetch("http://second-target.runledger.test/second");
			return response.text();
		});

		expect(await Promise.all([first, second])).toEqual(["first", "second"]);
		expect(firstProxy.requests).toEqual(["http://first-target.runledger.test/first"]);
		expect(secondProxy.requests).toEqual(["http://second-target.runledger.test/second"]);
	});
});
