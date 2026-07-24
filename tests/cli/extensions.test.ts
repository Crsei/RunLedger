import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { main, type ExtensionConfirmationPort } from "../../src/cli/main.ts";
import { parseExtensionCommand } from "../../src/extensions/control-plane/commands.ts";
import {
	ExtensionControlPlane,
	type ExtensionControlPlaneResponse,
} from "../../src/extensions/control-plane/control-plane.ts";
import type { ExtensionCommand } from "../../src/extensions/control-plane/commands.ts";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");
const TSX_LOADER = resolve(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "runledger-extension-cli-"));
	temporaryDirectories.push(path);
	return path;
}

function runCli(cwd: string, args: readonly string[]) {
	return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			RUNLEDGER_DIR: join(cwd, "agent"),
		},
	});
}

describe("Extension CLI discovery-only entrypoint", () => {
	it("parses exact marketplace and OAuth commands without falling through to legacy flags", () => {
		expect(parseExtensionCommand([
			"plugin",
			"install",
			"--locator",
			"locator.json",
			"--yes",
			"--digest",
			"a".repeat(64),
			"--json",
		])).toEqual({
			ok: true,
			command: {
				kind: "plugin-install",
				locatorPath: "locator.json",
				yes: true,
				digest: "a".repeat(64),
				json: true,
			},
		});
		expect(parseExtensionCommand([
			"plugin",
			"rollback",
			"team-tools",
			"--from",
			"1.2.3",
		])).toMatchObject({
			ok: true,
			command: {
				kind: "plugin-rollback",
				packageName: "team-tools",
				fromVersion: "1.2.3",
			},
		});
		expect(parseExtensionCommand([
			"mcp",
			"login",
			"mcp-server:project:secure",
		])).toMatchObject({
			ok: true,
			command: {
				kind: "mcp-login",
				resourceId: "mcp-server:project:secure",
			},
		});
		expect(parseExtensionCommand(["plugin", "install", "--locator"])).toMatchObject({
			ok: false,
			message: expect.stringContaining("--locator"),
		});
	});

	it("returns schemaVersion 1 JSON before session/TUI startup and creates no files", async () => {
		const cwd = await temporary();
		const result = runCli(cwd, ["inspect", "--json"]);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: 1,
			ok: true,
			exitCode: 0,
			data: { resources: [] },
		});
		expect(await readdir(cwd)).toEqual([]);
	});

	it("keeps structured failures on stdout and uses a stable fail-closed exit code", async () => {
		const cwd = await temporary();
		const result = runCli(cwd, ["mcp", "doctor", "--json"]);
		expect(result.status).toBe(4);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: 1,
			ok: false,
			exitCode: 4,
			error: { code: "privileged_ports_unavailable" },
		});
		expect(await readdir(cwd)).toEqual([]);
	});

	it("fails marketplace mutations closed before reading a locator when privileged ports are absent", async () => {
		const cwd = await temporary();
		const result = runCli(cwd, [
			"plugin",
			"install",
			"--locator",
			"missing-locator.json",
			"--yes",
			"--digest",
			"a".repeat(64),
			"--json",
		]);
		expect(result.status).toBe(4);
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: 1,
			ok: false,
			error: { code: "privileged_ports_unavailable" },
		});
		expect(await readdir(cwd)).toEqual([]);
	});

	it("uses an exact digest prompt only on an interactive terminal", async () => {
		const digest = "b".repeat(64);
		const commands: ExtensionCommand[] = [];
		class InteractiveControlPlane extends ExtensionControlPlane {
			public constructor() {
				super({
					discovery: {
						inspect: async () => {
							throw new Error("stub execute must be used");
						},
					},
				});
			}

			public override async execute(command: ExtensionCommand): Promise<ExtensionControlPlaneResponse> {
				commands.push(command);
				if (!command.yes) {
					return {
						schemaVersion: 1,
						ok: false,
						exitCode: 5,
						data: {
							confirmation: {
								operation: "plugin-install",
								identity: "team-tools@1.2.3 by fixture",
								digest,
								capabilities: ["required:filesystem-read"],
							},
						},
						error: {
							code: "confirmation_required",
							message: "confirmation required",
						},
					};
				}
				return { schemaVersion: 1, ok: true, exitCode: 0, data: { installed: true } };
			}
		}
		const confirmation: ExtensionConfirmationPort = {
			available: () => true,
			confirm: async (details) => details.digest,
		};
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await main(
				["plugin", "install", "--locator", "locator.json", "--json"],
				{
					extensionControlPlane: new InteractiveControlPlane(),
					extensionConfirmation: confirmation,
				},
			);
		} finally {
			stdout.mockRestore();
			process.exitCode = undefined;
		}
		expect(commands).toHaveLength(2);
		expect(commands[1]).toMatchObject({ yes: true, digest });
	});
});
