/**
 * B0 起复用的 contract-integration harness fixture。
 *
 * 只组装测试用 fake controller / fake terminal / InteractiveMode，
 * 不改变 production state；PTY 场景统一使用隔离 RUNLEDGER_DIR，
 * 绝不读取或迁移真实用户目录。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEvent,
  AgentMessage,
  UserAgentMessage,
} from "../../../src/runtime/types.ts";
import type {
  InteractiveSessionControllerPort,
  ProviderStatus,
  RuntimeSelection,
} from "../../../src/runtime/interactive-session-controller.ts";
import type { AuthInteraction, AuthType, Credential } from "../../../src/auth/types.ts";
import type { AssistantMessage, ModelThinkingLevel } from "../../../src/types.ts";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import type { LedgerEntry } from "../../../src/runtime/ledger/types.ts";
import { InteractiveMode, type ModelSwitchEntry } from "../../../src/tui/interactive-mode.ts";
import type { Terminal } from "../../../src/tui/index.ts";
import type { SessionDomainMutationContext, SessionDomainRequestContext, SessionDomainResult } from "../../../src/runtime/session-runtime/domain-router.ts";
import type { AgentRunSummary } from "../../../src/runtime/session-runtime/run-timing.ts";

/** 可配置列/行的 fake terminal；writes 捕获渲染帧。 */
export class ContractTerminal implements Terminal {
  private input: ((data: string) => void) | undefined;
  readonly writes: string[] = [];
  startCount = 0;
  stopCount = 0;

  constructor(
    private readonly columnsValue = 80,
    private readonly rowsValue = 24,
  ) {}

  get columns(): number {
    return this.columnsValue;
  }
  get rows(): number {
    return this.rowsValue;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  start(onInput: (data: string) => void): void {
    this.startCount += 1;
    this.input = onInput;
  }
  stop(): void {
    this.stopCount += 1;
    this.input = undefined;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void {
    this.input?.(data);
  }
  frame(): string {
    return this.writes.join("");
  }
}

/** 构造一个最小 assistant message，供 replay / live 事件使用。 */
export function contractAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: mockModel.api,
    provider: mockModel.provider,
    model: mockModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

export interface ContractProviderStatus {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly source?: string;
  readonly interactiveAuthTypes: readonly AuthType[];
}

export interface ContractModelOption {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

export interface ContractControllerOptions {
	readonly agentRuns?: readonly AgentRunSummary[];
  readonly messages?: readonly AgentMessage[];
  readonly warnings?: readonly string[];
  readonly auditEntries?: readonly LedgerEntry[];
  readonly inFlight?: boolean;
  readonly selection?: Partial<RuntimeSelection>;
  readonly toolCount?: number;
  readonly providerStatuses?: readonly ContractProviderStatus[];
  readonly availableModels?: readonly ContractModelOption[];
  readonly onLogin?: (providerId: string) => Promise<void>;
  readonly onLogout?: (providerId: string) => Promise<void>;
  readonly querySessionDomain?: (operation: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly commandSessionDomain?: (operation: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly supportedOperations?: readonly string[];
}

/** B0 harness：可控 event 源 + 可查询状态的 fake controller。 */
export class ContractController implements InteractiveSessionControllerPort {
  readonly sessionId = "contract-session";
  readonly messages: readonly AgentMessage[];
  readonly warnings: readonly string[];
  readonly auditEntries: readonly LedgerEntry[];
  readonly toolCount: number;
  readonly agentRuns: readonly AgentRunSummary[];
  readonly querySessionDomain?: (operation: string, body: Record<string, unknown>, context: SessionDomainRequestContext) => Promise<SessionDomainResult>;
  readonly commandSessionDomain?: (operation: string, body: Record<string, unknown>, context: SessionDomainMutationContext) => Promise<SessionDomainResult>;
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private inFlightValue: boolean;
  private selectionValue: RuntimeSelection;
  private readonly options: ContractControllerOptions;
  private disposedValue = false;
  promptCalls: string[] = [];

  supports(operation: string): boolean {
	const defaults = [
		"session.provider.status",
		"session.model.list",
		"session.model.select",
		"session.thinking.set",
		"session.auth.login",
		"session.auth.logout",
		...(this.querySessionDomain === undefined ? [] : ["extension.inspect", "plan.inspect", "security.inspect", "worktree.inspect"]),
		...(this.commandSessionDomain === undefined ? [] : ["extension.reload"]),
	];
	return (this.options.supportedOperations ?? defaults).includes(operation);
  }

  constructor(options: ContractControllerOptions = {}) {
    this.options = options;
    this.messages = options.messages ?? [];
    this.warnings = options.warnings ?? [];
    this.auditEntries = options.auditEntries ?? [];
    this.toolCount = options.toolCount ?? 0;
    this.agentRuns = options.agentRuns ?? [];
    this.inFlightValue = options.inFlight ?? false;
    this.selectionValue = {
      provider: options.selection?.provider,
      model: options.selection?.model,
      thinkingLevel: options.selection?.thinkingLevel ?? "off",
    };
    this.querySessionDomain = options.querySessionDomain === undefined ? undefined : async (operation, body) => {
      const value = await options.querySessionDomain!(operation, body);
      const domainRevision = typeof value.domainRevision === "number" && Number.isSafeInteger(value.domainRevision) ? value.domainRevision : 0;
      return { ok: true, status: "ok", operation, domainRevision, value };
    };
    this.commandSessionDomain = options.commandSessionDomain === undefined ? undefined : async (operation, body) => {
      const value = await options.commandSessionDomain!(operation, body);
      const domainRevision = typeof value.domainRevision === "number" && Number.isSafeInteger(value.domainRevision) ? value.domainRevision : 0;
      return { ok: true, status: "ok", operation, domainRevision, value };
    };
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get inFlight(): boolean {
    return this.inFlightValue;
  }
  get currentSelection(): RuntimeSelection {
    return { ...this.selectionValue };
  }
  getSteeringMessages(): readonly UserAgentMessage[] {
    return [];
  }
  getFollowUpMessages(): readonly UserAgentMessage[] {
    return [];
  }
  async getProviderStatuses(): Promise<ProviderStatus[]> {
    return (this.options.providerStatuses ?? []).map((status) => ({
      id: status.id,
      name: status.name,
      configured: status.configured,
      source: status.source,
      authTypes: [...status.interactiveAuthTypes],
      interactiveAuthTypes: [...status.interactiveAuthTypes],
    }));
  }
  getProvider(): undefined {
    return undefined;
  }
  async getAvailableModels(): Promise<readonly { readonly provider: string; readonly id: string }[]> {
    return (this.options.availableModels ?? []).map((model) => ({ provider: model.provider, id: model.id }));
  }
  async login(providerId: string, _type: AuthType, _interaction: AuthInteraction): Promise<Credential> {
    await this.options.onLogin?.(providerId);
    return { provider: providerId, type: "api_key", key: "contract-key" } as Credential;
  }
  async logout(providerId: string): Promise<void> {
    await this.options.onLogout?.(providerId);
  }
  async selectModel(): Promise<void> {}
  async setThinkingLevel(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
    this.selectionValue = { ...this.selectionValue, thinkingLevel: level };
    return level;
  }
  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    this.inFlightValue = true;
    this.options.onPrompt?.(text);
    const now = Date.now();
    this.emit({ type: "agent_start", timestamp: now });
    this.emit({
      type: "message_start",
      timestamp: now,
      role: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    this.emit({
      type: "message_start",
      timestamp: now,
      role: "assistant",
      message: contractAssistantMessage(),
    });
    this.emit({
      type: "message_update",
      timestamp: now,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "contract reply",
      },
    });
    this.emit({
      type: "tool_execution_start",
      timestamp: now,
      toolCallId: "tool_call_contract_1",
      toolName: "echo",
      args: { text: "hello" },
    });
    this.emit({
      type: "tool_execution_end",
      timestamp: now,
      toolCallId: "tool_call_contract_1",
      toolName: "echo",
      isError: false,
      result: {
        type: "toolResult",
        toolCallId: "tool_call_contract_1",
        toolName: "echo",
        content: [{ type: "text", text: "hello" }],
      },
    });
    this.emit({
      type: "message_end",
      timestamp: now,
      role: "assistant",
      stopReason: "stop",
      message: contractAssistantMessage({ content: [{ type: "text", text: "contract reply" }] }),
    });
    this.emit({ type: "agent_end", timestamp: now });
    this.inFlightValue = false;
  }
  interrupt(): void {}
  clearAllQueues(): { steering: UserAgentMessage[]; followUp: UserAgentMessage[] } {
    return { steering: [], followUp: [] };
  }
  async waitForIdle(): Promise<void> {}
  dispose(): void {
    this.disposedValue = true;
  }
  get disposed(): boolean {
    return this.disposedValue;
  }
  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) void listener(event);
  }
}

export interface ContractHarness {
  readonly mode: InteractiveMode;
  readonly terminal: ContractTerminal;
  readonly controller: ContractController;
  readonly runDir: string;
  readonly originalRunledgerDir: string | undefined;
  dispose(): Promise<void>;
}

export interface ContractHarnessOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly controller?: ContractController;
  readonly modelRegistry?: ModelSwitchEntry[];
}

/**
 * 装配隔离 RUNLEDGER_DIR + InteractiveMode + fake terminal 的完整 harness。
 * caller 必须保证在 finally 中调用 dispose()。
 */
export function createContractHarness(options: ContractHarnessOptions = {}): ContractHarness {
  const runDir = mkdtempSync(join(tmpdir(), "runledger-contract-"));
  const originalRunledgerDir = process.env.RUNLEDGER_DIR;
  process.env.RUNLEDGER_DIR = runDir;
  const terminal = new ContractTerminal(options.columns ?? 80, options.rows ?? 24);
  const controller = options.controller ?? new ContractController();
  const mode = new InteractiveMode({
    controller,
    terminal,
    modelRegistry: options.modelRegistry,
  });
  const running = mode.run();
  return {
    mode,
    terminal,
    controller,
    runDir,
    originalRunledgerDir,
    dispose: async () => {
      if (terminal.stopCount === 0) {
        // 先关 overlay（Escape），再 Ctrl+D 退出；overlay 打开时 Ctrl+D 被吞
        terminal.send("\x1b");
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        terminal.send("\x04");
      }
      await running;
      controller.dispose();
      if (originalRunledgerDir === undefined) delete process.env.RUNLEDGER_DIR;
      else process.env.RUNLEDGER_DIR = originalRunledgerDir;
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

/** 等 microtask/帧排空。 */
export async function settleFrames(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
