import { describe, expect, it } from "vitest";
import { createStdlibTools } from "../../src/runtime/tools/index.ts";
import type { ExecutionEnv } from "../../src/runtime/execution-env.ts";

describe("Host-injected stdlib ExecutionEnv", () => {
	it("routes filesystem, shell, and WebFetch through the injected ports", async () => {
		const calls: string[] = [];
		const files = new Map<string, string>([["/workspace/input.txt", "hello"]]);
		const env: ExecutionEnv = {
			cwd: "/workspace",
			fs: {
				readFile: async (path) => {
					calls.push(`read:${path}`);
					return Buffer.from(files.get(path) ?? "", "utf8");
				},
				writeFile: async (path, data) => {
					calls.push(`write:${path}`);
					files.set(path, typeof data === "string" ? data : data.toString("utf8"));
				},
				stat: async (path) => ({
					size: Buffer.byteLength(files.get(path) ?? "", "utf8"),
					mtimeMs: 1,
					isFile: files.has(path),
					isDirectory: path === "/workspace",
				}),
				readdir: async () => [],
				mkdir: async () => {},
				rm: async () => {},
			},
			shell: {
				exec: async (command) => {
					calls.push(`shell:${command}`);
					return { stdout: "governed shell", stderr: "", exitCode: 0 };
				},
			},
			network: {
				request: async (request) => {
					calls.push(`network:${request.url}`);
					return {
						status: 200,
						headers: { "content-type": "text/plain" },
						body: Buffer.from("governed network", "utf8"),
						finalUrl: request.url,
					};
				},
			},
		};
		const tools = createStdlibTools("/workspace", { executionEnv: env });

		await tools.get("read")?.execute("tool-read", { path: "input.txt", lineNumbers: false });
		await tools.get("write")?.execute("tool-write", { path: "output.txt", content: "written" });
		await tools.get("bash")?.execute("tool-bash", { command: "echo governed" });
		await tools.get("WebFetch")?.execute("tool-fetch", { url: "https://example.com", prompt: "summarize" });

		expect(calls).toEqual([
			"read:/workspace/input.txt",
			"write:/workspace/output.txt",
			"shell:echo governed",
			"network:https://example.com/",
		]);
	});

	it("routes grep and find helper shells through the managed process facade", async () => {
		const rawShellCalls: string[] = [];
		const managedShellCalls: string[] = [];
		const env: ExecutionEnv = {
			cwd: "/workspace",
			fs: {
				readFile: async () => Buffer.from("", "utf8"),
				writeFile: async () => {},
				stat: async () => ({ size: 0, mtimeMs: 1, isFile: true, isDirectory: false }),
				readdir: async () => [],
				mkdir: async () => {},
				rm: async () => {},
			},
			shell: {
				exec: async (command) => {
					rawShellCalls.push(command);
					return { stdout: "raw", stderr: "", exitCode: 0 };
				},
			},
		};
		const tools = createStdlibTools("/workspace", {
			executionEnv: env,
			managedProcess: {
				start: async () => ({ ok: false as const, code: "not_used" }),
				exec: async (input) => {
					managedShellCalls.push(input.command);
					return { stdout: input.command.endsWith("--version") ? "version" : "managed", stderr: "", exitCode: 0 };
				},
			},
		});

		await tools.get("grep")?.execute("tool-grep", { pattern: "needle" });
		await tools.get("find")?.execute("tool-find", { pattern: "*.ts" });

		expect(rawShellCalls).toEqual([]);
		expect(managedShellCalls.some((command) => command === "rg --version")).toBe(true);
		expect(managedShellCalls.some((command) => command === "fd --version")).toBe(true);
	});
});
