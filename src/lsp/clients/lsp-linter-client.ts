/** LSP 协议兜底 linter 客户端:真实语言服务器跑 linter 的默认路径。 */
import { ensureFileOpen, getOrCreateClient, refreshFile, waitForProjectLoaded } from "../client.ts";
import type { Diagnostic, LinterClient, LspProcessSpawner, ServerConfig } from "../types.ts";
import { fileToUri } from "../utils.ts";

export interface LspLinterClientOptions {
	spawn?: LspProcessSpawner;
}

export class LspLinterClient implements LinterClient {
	private readonly config: ServerConfig;
	private readonly cwd: string;
	private readonly options: LspLinterClientOptions;

	public static create(config: ServerConfig, cwd: string): LspLinterClient {
		return new LspLinterClient(config, cwd);
	}

	public constructor(config: ServerConfig, cwd: string, options: LspLinterClientOptions = {}) {
		this.config = config;
		this.cwd = cwd;
		this.options = options;
	}

	public async lint(filePath: string, signal?: AbortSignal): Promise<Diagnostic[]> {
		const client = await getOrCreateClient(this.config, this.cwd, { spawn: this.options.spawn }, signal);
		await ensureFileOpen(client, filePath, signal);
		await waitForProjectLoaded(client, signal);
		await refreshFile(client, filePath, signal);
		return client.diagnostics.get(fileToUri(filePath))?.diagnostics ?? [];
	}
}
