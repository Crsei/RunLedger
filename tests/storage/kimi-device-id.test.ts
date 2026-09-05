import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { createKimiCodeDeviceIdProvider } from "../../src/storage/kimi-device-id.ts";
import { builtinProviders } from "../../src/providers/all.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "runledger-kimi-device-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("canonical Kimi device identity", () => {
	it("persists beneath the injected layout and reuses the identity across instances", async () => {
		const layout = buildRunledgerLayout(join(root, "first"), "posix");
		const readId = createKimiCodeDeviceIdProvider(layout);
		const id = readId();
		expect(id).toMatch(/^[a-f0-9]{32}$/);
		expect(readId()).toBe(id);
		expect(createKimiCodeDeviceIdProvider(layout)()).toBe(id);
		expect((await readFile(join(layout.home, "kimi-device-id"), "utf8")).trim()).toBe(id);
		if (process.platform !== "win32") {
			expect((await stat(layout.home)).mode & 0o777).toBe(0o700);
			expect((await stat(join(layout.home, "kimi-device-id"))).mode & 0o777).toBe(0o600);
		}
		const other = createKimiCodeDeviceIdProvider(buildRunledgerLayout(join(root, "second"), "posix"))();
		expect(other).not.toBe(id);
	});

	it("keeps an instance-local temporary identity when persistence is unavailable", async () => {
		const unavailable = join(root, "file");
		await writeFile(unavailable, "not a directory");
		const readId = createKimiCodeDeviceIdProvider(buildRunledgerLayout(unavailable, "posix"));
		const id = readId();
		expect(id).toMatch(/^[a-f0-9]{32}$/);
		expect(readId()).toBe(id);
		expect(await readFile(unavailable, "utf8")).toBe("not a directory");
	});

	it("binds the canonical identity through the builtin provider OAuth factory", async () => {
		const layout = buildRunledgerLayout(join(root, "builtin"), "posix");
		await mkdir(layout.home, { recursive: true });
		const id = "a".repeat(32);
		await writeFile(join(layout.home, "kimi-device-id"), `${id}\n`, { mode: 0o600 });
		const observed: string[] = [];
		const provider = builtinProviders({ kimiCode: {
			getDeviceId: createKimiCodeDeviceIdProvider(layout),
			fetch: async (_input, init) => {
				observed.push(new Headers(init?.headers).get("X-Msh-Device-Id") ?? "");
				return new Response(JSON.stringify({ access_token: "fixture-access", expires_in: 3600 }), { status: 200 });
			},
		} }).find((entry) => entry.id === "kimi-code");
		if (provider?.auth.oauth === undefined) throw new Error("Kimi OAuth missing");
		await provider.auth.oauth.refresh({ type: "oauth", access: "old", refresh: "fixture-refresh", expires: 1 });
		expect(observed).toEqual([id]);
	});
});
