import { Worker } from "node:worker_threads";
import { createRuntimeId } from "../../../runtime/contracts/public.ts";
import { precheckBashCommand } from "./precheck.ts";
import { resolveBashAstAssets } from "./assets.ts";
import {
	BASH_AST_DEADLINE_MS,
	BASH_AST_WORKER_STARTUP_DEADLINE_MS,
	BASH_PARSER_DIGEST,
	BASH_AST_WORKER_POOL_MAX,
	type BashAstAssetPaths,
	type BashAstClassificationResult,
} from "./types.ts";
import {
	parseBashAstWorkerResponse,
	type BashAstWorkerData,
	type BashAstWorkerRequest,
	type BashAstWorkerResponse,
} from "./worker-protocol.ts";

interface ActiveRequest {
	requestId: string;
	resolve(value: BashAstClassificationResult): void;
	timer: ReturnType<typeof setTimeout>;
}

function unavailable(reasonCode: string): BashAstClassificationResult {
	return {
		classification: { kind: "parse-unavailable", reasonCode },
		metrics: {
			durationBucket: "unavailable",
			nodeCountBucket: "unavailable",
			nodeCount: 0,
		},
	};
}

function deadline(parserDigest: string): BashAstClassificationResult {
	return {
		classification: {
			kind: "too-complex",
			reasonCode: "bash_parse_deadline",
			parserDigest,
		},
		metrics: {
			durationBucket: "over-50ms",
			nodeCountBucket: "unavailable",
			nodeCount: 0,
		},
	};
}

function workerUrl(moduleUrl = import.meta.url): URL {
	return new URL(moduleUrl.endsWith(".js") ? "./worker.js" : "./worker.ts", moduleUrl);
}

class BashAstWorkerClient {
	readonly #worker: Worker;
	readonly #ready: Promise<boolean>;
	readonly #parserDigest: string;
	#readyResolve: (ready: boolean) => void = () => undefined;
	#active?: ActiveRequest;
	#closed = false;

	public constructor(assets: BashAstAssetPaths) {
		this.#parserDigest = assets.parserDigest;
		const data: BashAstWorkerData = { protocolVersion: 1, assets };
		this.#worker = new Worker(workerUrl(), {
			workerData: data,
			execArgv: process.execArgv.filter((argument) =>
				!argument.startsWith("--input-type")
			),
		});
		this.#ready = new Promise<boolean>((resolve) => {
			this.#readyResolve = resolve;
		});
		this.#worker.on("message", (value: unknown) => this.#accept(value));
		this.#worker.once("error", () => this.#fail("bash_worker_crash"));
		this.#worker.once("exit", (code) => {
			if (code !== 0 || !this.#closed) this.#fail("bash_worker_exit");
		});
	}

	#accept(value: unknown): void {
		const message = parseBashAstWorkerResponse(value);
		if (!message) {
			this.#fail("bash_worker_protocol");
			return;
		}
		if (message.type === "ready") {
			this.#readyResolve(true);
			return;
		}
		if (message.type === "failed") {
			this.#readyResolve(false);
			this.#fail(message.reasonCode);
			return;
		}
		const active = this.#active;
		if (!active || active.requestId !== message.requestId) {
			this.#fail("bash_worker_correlation");
			return;
		}
		clearTimeout(active.timer);
		this.#active = undefined;
		this.#worker.unref();
		active.resolve(message.result);
	}

	#fail(reasonCode: string): void {
		this.#readyResolve(false);
		const active = this.#active;
		this.#active = undefined;
		if (active) {
			clearTimeout(active.timer);
			this.#worker.unref();
			active.resolve(unavailable(reasonCode));
		}
	}

	public async initialize(timeoutMs = BASH_AST_WORKER_STARTUP_DEADLINE_MS): Promise<boolean> {
		let readyTimer: ReturnType<typeof setTimeout> | undefined;
		const ready = await Promise.race([
			this.#ready,
			new Promise<boolean>((resolve) => {
				readyTimer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
		if (readyTimer) clearTimeout(readyTimer);
		return ready && !this.#closed;
	}

	public async classify(command: string): Promise<BashAstClassificationResult> {
		const ready = await this.initialize(BASH_AST_DEADLINE_MS);
		if (!ready || this.#closed) return unavailable("bash_worker_unavailable");
		this.#worker.ref();
		const requestId = createRuntimeId(
			"command",
			`bash-ast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#active = undefined;
				resolve(deadline(this.#parserDigest));
				void this.close();
			}, BASH_AST_DEADLINE_MS);
			this.#active = { requestId, resolve, timer };
			const request: BashAstWorkerRequest = {
				protocolVersion: 1,
				type: "classify",
				requestId,
				command,
			};
			this.#worker.postMessage(request);
		});
	}

	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#fail("bash_worker_closed");
		await this.#worker.terminate();
	}
}

interface PoolSlot {
	client?: BashAstWorkerClient;
	tail: Promise<void>;
}

export class BashAstWorkerPool {
	readonly #size: number;
	readonly #slots: PoolSlot[];
	#assetsPromise?: Promise<BashAstAssetPaths | undefined>;
	#next = 0;
	#closed = false;
	#active = 0;
	#drainWaiters: Array<() => void> = [];

	public constructor(size = Math.min(BASH_AST_WORKER_POOL_MAX, 2)) {
		if (!Number.isSafeInteger(size) || size < 1 || size > BASH_AST_WORKER_POOL_MAX) {
			throw new TypeError("Bash AST worker pool size is outside the fixed bound");
		}
		this.#size = size;
		this.#slots = Array.from({ length: size }, () => ({ tail: Promise.resolve() }));
	}

	async #loadAssets(): Promise<BashAstAssetPaths | undefined> {
		this.#assetsPromise ??= resolveBashAstAssets();
		return this.#assetsPromise;
	}

	public async initialize(): Promise<boolean> {
		if (this.#closed) return false;
		const assets = await this.#loadAssets();
		if (!assets) return false;
		const initialized = await Promise.all(this.#slots.map(async (slot) => {
			slot.client ??= new BashAstWorkerClient(assets);
			if (await slot.client.initialize()) return true;
			await slot.client.close();
			slot.client = undefined;
			return false;
		}));
		return initialized.every(Boolean);
	}

	public async classify(command: string): Promise<BashAstClassificationResult> {
		if (this.#closed) return unavailable("bash_worker_pool_closed");
		const prechecked = precheckBashCommand(command, BASH_PARSER_DIGEST);
		if (prechecked) {
			return {
				classification: prechecked,
				metrics: {
					durationBucket: "precheck",
					nodeCountBucket: "0-100",
					nodeCount: 0,
				},
			};
		}
		this.#active += 1;
		try {
			const assets = await this.#loadAssets();
			if (!assets) return unavailable("bash_wasm_unavailable");
			const slot = this.#slots[this.#next % this.#size]!;
			this.#next += 1;
			const previous = slot.tail;
			let release: () => void = () => undefined;
			slot.tail = previous.then(() => new Promise<void>((resolve) => {
				release = resolve;
			}));
			await previous;
			try {
				slot.client ??= new BashAstWorkerClient(assets);
				if (!await slot.client.initialize()) {
					await slot.client.close();
					slot.client = undefined;
					return unavailable("bash_worker_unavailable");
				}
				const result = await slot.client.classify(command);
				if (
					result.classification.kind === "parse-unavailable" ||
					(result.classification.kind === "too-complex" &&
						result.classification.reasonCode === "bash_parse_deadline")
				) {
					await slot.client.close();
					slot.client = undefined;
				}
				return result;
			} finally {
				release();
			}
		} finally {
			this.#active -= 1;
			if (this.#active === 0) {
				for (const resolveWaiter of this.#drainWaiters.splice(0)) {
					resolveWaiter();
				}
			}
		}
	}

	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#active > 0) {
			await new Promise<void>((resolveDrain) => {
				this.#drainWaiters.push(resolveDrain);
			});
		}
		await Promise.all(this.#slots.map(async (slot) => {
			await slot.tail;
			await slot.client?.close();
			slot.client = undefined;
		}));
	}
}
