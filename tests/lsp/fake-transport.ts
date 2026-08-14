/**
 * 测试用脚本化 LspTransport:stdin 写出即记录帧文本,
 * 测试经 emitResponse / emitNotification 注入服务端消息。
 */
import type {
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	LspTransport,
	LspWriteSink,
} from "../../src/lsp/types.ts";

const encoder = new TextEncoder();

export class FakeTransport implements LspTransport {
	readonly sent: string[] = [];
	readonly stdin: LspWriteSink;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	exitCode: number | null = null;
	pid = 42;
	private killed = false;
	private streamController!: ReadableStreamDefaultController<Uint8Array>;
	private stderrTail = "";
	private readonly decoder = new TextDecoder();

	constructor() {
		this.stdout = new ReadableStream<Uint8Array>({
			start: (controller) => { this.streamController = controller; },
		});
		this.stdin = {
			write: (data) => {
				const text = typeof data === "string" ? data : this.decoder.decode(data);
				this.sent.push(text);
				const separator = text.indexOf("\r\n\r\n");
				const body = separator >= 0 ? text.slice(separator + 4) : text;
				const message = JSON.parse(body) as Partial<LspJsonRpcRequest>;
				if (message.method === "shutdown" && message.id !== undefined) {
					queueMicrotask(() => this.emitResponse(message.id!, null));
				}
				return typeof data === "string" ? data.length : data.length;
			},
			flush: () => 0,
		};
		let resolveExit!: (code: number) => void;
		this.exited = new Promise<number>((resolve) => { resolveExit = resolve; });
		this.emitExit = (code: number) => { this.exitCode = code; resolveExit(code); };
	}
	readonly emitExit: (code: number) => void;

	emitResponse(id: number | string, result: unknown): void {
		this.pushFrame({ jsonrpc: "2.0", id, result });
	}

	emitRequest(method: string, params: unknown, id: number | string): void {
		this.pushFrame({ jsonrpc: "2.0", id, method, params });
	}

	emitNotification(method: string, params: unknown): void {
		this.pushFrame({ jsonrpc: "2.0", method, params });
	}

	/** 已发送帧中匹配 method 的请求参数(测试断言)。 */
	lastRequest(method: string): LspJsonRpcRequest | undefined {
		for (let i = this.sent.length - 1; i >= 0; i -= 1) {
			const raw = this.sent[i];
			if (raw === undefined) continue;
			const body = raw.includes("\r\n\r\n") ? raw.slice(raw.indexOf("\r\n\r\n") + 4) : raw;
			const message = JSON.parse(body) as LspJsonRpcRequest | LspJsonRpcNotification;
			if ("method" in message && message.method === method) return message as LspJsonRpcRequest;
		}
		return undefined;
	}

	responseFor(id: number | string): LspJsonRpcResponse | undefined {
		for (let index = this.sent.length - 1; index >= 0; index -= 1) {
			const raw = this.sent[index];
			if (raw === undefined) continue;
			const body = raw.includes("\r\n\r\n") ? raw.slice(raw.indexOf("\r\n\r\n") + 4) : raw;
			const message = JSON.parse(body) as LspJsonRpcResponse;
			if (message.id === id && !("method" in message)) return message;
		}
		return undefined;
	}

	kill(): void {
		this.killed = true;
		if (this.exitCode === null) this.emitExit(-1);
	}

	isKilled(): boolean { return this.killed; }

	peekStderr(): string { return this.stderrTail; }

	appendStderr(text: string): void { this.stderrTail += text; }

	private pushFrame(message: LspJsonRpcResponse | LspJsonRpcRequest | LspJsonRpcNotification): void {
		const body = JSON.stringify(message);
		const frame = `Content-Length: ${encoder.encode(body).length}\r\n\r\n${body}`;
		this.streamController.enqueue(encoder.encode(frame));
	}
}
