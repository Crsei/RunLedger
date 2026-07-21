/**
 * InteractiveMode —— TUI 主控,组装 pi-tui 组件树并接通 Agent 事件流。
 *
 * 对照 development-doc/tui/02-component-spec.md §1 与 07-roadmap.md M1。
 *
 * M1 阶段("空骨架")目标:
 *   1. 装配组件树(header / loadedResources / chat / status / editor / footer)
 *      与 M2+ 的真实业务组件不同,M1 各 container 暂用 Spacer 占位;
 *   2. 实现 FooterSnapshotProvider 三个方法(isStreaming / getStopReason / getModelId / getSessionId);
 *   3. handleEvent 把 TuiEvent 路由到各 container,M1 阶段除 agent_end / message_end
 *      更新 stopReason 之外其余 case 留 noop 占位(M2 起逐 case 落实);
 *   4. run() / quit() 对接 TUI.start / stop,并注册到 ReplHandle 单例(M8 远期任务接入);
 *   5. 失败护栏常量 MAX_CONSECUTIVE_INIT_FAILURES / INIT_FAILURE_BACKOFF_MS 在 spec 已定义,
 *      M1 不实际触发(无 init 重试路径),M6 起 OSC 11 探测时启用。
 *
 * 本 M1 阶段:
 *   - main 入口由 examples/tui-demo.ts 实例化 InteractiveMode 并 run;
 *   - 实际接 CLI 入口 src/cli/main.ts 留给 M7;
 *   - 与 Agent 的耦合只在 prompt 提交,不修改 agent._state.messages(对照 01 §6.1)。
 */

import {
  Container,
  ProcessTerminal,
  TUI,
  type Terminal,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type EditorTheme,
  type SelectListTheme,
} from "./index.ts";

import type { Agent } from "../runtime/agent.ts";
import type { AgentEvent } from "../runtime/types.ts";
import type { AssistantMessage, ThinkingLevel } from "../types.ts";

import { adaptAgentEvent, type FooterSnapshotProvider, type TuiEvent } from "./types.ts";
import { loadTheme, applyEnvOverrides, type Theme } from "./theme/theme.ts";
import { makeEditorTheme, makeSelectListTheme } from "./theme/factories.ts";
import { CustomEditor, type CustomEditorProps } from "./components/custom-editor.ts";
import { Footer } from "./components/footer.ts";
import { KeybindingHints } from "./components/keybinding-hints.ts";
import { LoadedResourcesComponent } from "./components/loaded-resources.ts";
import { ChatContainer } from "./components/chat-container.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { AssistantMessageComponent, extractToolCalls } from "./components/assistant-message.ts";
import { ToolCallComponent } from "./components/tool-call.ts";
import { ToolResultComponent } from "./components/tool-result.ts";
import { StatusComponent } from "./components/status.ts";
import { SelectorModal } from "./components/selector-modal.ts";
import type { SelectItem } from "./index.ts";
import type { AgentToolResult } from "../runtime/types.ts";
import { createAppKeyListener } from "./keybindings/app-keys.ts";
import { detectScheme } from "./theme/osc-detector.ts";

/** InteractiveMode 装配参数。 */
export interface InteractiveModeOptions {
  agent: Agent;
  /** 终端实现,默认 ProcessTerminal;可传入 mock 终端用于单测。 */
  terminal?: Terminal;
  /** 主题名,默认 dark;M6 接入 env / OSC 11 自动切换。 */
  themeName?: "dark" | "light";
  /** 调试模式:onError 时把堆栈写到 stderr。 */
  debug?: boolean;
  /** M8d:/model 选择器候选列表;空则 selector 不可用。 */
  modelRegistry?: ModelSwitchEntry[];
  /** M8e:thinking level 初始值,默认 "minimal"。 */
  initialThinkingLevel?: ThinkingLevel;
  /** M8e:thinking level change 回调,由 caller 决定如何传给 agent streamFn。 */
  onThinkingChange?: (level: ThinkingLevel) => void;
}

/** M8d:/model 切换条目;由 caller(demo)注入候选。 */
export interface ModelSwitchEntry {
  /** 内部 ID(也是 SelectItem.value) */
  id: string;
  /** 显示 label */
  label: string;
  /** description */
  description?: string;
  /** 真正的 Model instance,将传给 agent.setModel */
  model: Agent["state"]["model"];
}

/** 组件树引用,挂在 InteractiveMode 实例上以便 handleEvent 路由 mutation。 */
interface ContainerRefs {
  header: Container;
  loadedResources: LoadedResourcesComponent;
  chat: ChatContainer;
  status: StatusComponent;
  editor: CustomEditor;
  footer: Footer;
  hints: KeybindingHints;
}

/** 失败护栏常量(对照 02-spec §1 与 03-event-binding §5.1)。 */
const MAX_CONSECUTIVE_INIT_FAILURES = 3;
const INIT_FAILURE_BACKOFF_MS = 10_000;

export class InteractiveMode implements FooterSnapshotProvider {
  private readonly ui: TUI;
  private readonly terminal: Terminal;
  private readonly agent: Agent;
  private theme: Theme;
  private readonly kb: KeybindingsManager;
  private readonly refs: ContainerRefs;
  private unsubscribe?: () => void;

  // FooterSnapshotProvider 状态(只有 handleEvent 路径写)
  private streaming = false;
  private stopReason: string | undefined = undefined;

  // M3 toolExecution 映射:toolCallId -> ToolCallComponent;tool_execution_end 后移除。
  private readonly toolCallComponents: Map<string, ToolCallComponent> = new Map();

  // 失败护栏状态(M1 不主动触发)
  private consecutiveInitFailures = 0;

  // M8d/e:modelRegistry + thinking level 切换状态
  private modelRegistry: ModelSwitchEntry[];
  private thinkingLevel: ThinkingLevel;
  private readonly onThinkingChange?: (level: ThinkingLevel) => void;

  constructor(opts: InteractiveModeOptions) {
    this.agent = opts.agent;
    this.terminal = opts.terminal ?? new ProcessTerminal();
    this.theme = applyEnvOverrides(loadTheme(opts.themeName ?? "dark"));
    this.modelRegistry = opts.modelRegistry ?? [];
    this.thinkingLevel = opts.initialThinkingLevel ?? "minimal";
    this.onThinkingChange = opts.onThinkingChange;

    // TUI 使用 showHardwareCursor=false,Editor 自身以 CURSOR_MARKER 通知光标位置
    this.ui = new TUI(this.terminal, false);

    // KeybindingsManager:本期安装默认 TUI_KEYBINDINGS,后续 M6 在此挂 user bindings
    this.kb = new KeybindingsManager(TUI_KEYBINDINGS);
    setKeybindings(this.kb);

    // 装配组件树
    this.refs = this.assembleTree();

    // 注册到 RunLedger 进程级单例 handle(M8 远期接通);M1 阶段 setReplHandle 仍 noop
    // 此处仅保留 hook 点,不在本期调用 setReplHandle,避免引入运行时副作用。
    void MAX_CONSECUTIVE_INIT_FAILURES;
    void INIT_FAILURE_BACKOFF_MS;
  }

  /** 装配组件树并返回引用;M2 起把 LoadedResources / Chat 等 container 换成真实组件。 */
  private assembleTree(): ContainerRefs {
    const header = new Container();
    const loadedResources = new LoadedResourcesComponent({
      activeLedgerSessionId: this.agent.sessionId,
    });
    // 把已注册工具数填到 loadedResources
    loadedResources.setResource("tools", this.agent.state.tools.length);
    const chat = new ChatContainer();
    const status = new StatusComponent({});
    const editorTheme: EditorTheme = makeEditorTheme(this.theme, this.makeSelectListTheme());
    const editorProps: CustomEditorProps = {
      theme: this.theme,
      selectListTheme: this.makeSelectListTheme(),
      onSubmit: (text) => this.handleSubmit(text),
    };
    const editor = new CustomEditor(this.ui, editorTheme, editorProps);
    const footer = new Footer({ theme: this.theme, provider: this });
    const hints = new KeybindingHints({ theme: this.theme, hints: [] });

    // 组件树结构(对照 02 §1):
    //   header / loadedResources / chat / status / editor / footer / hints
    this.ui.addChild(header);
    this.ui.addChild(loadedResources);
    this.ui.addChild(chat);
    this.ui.addChild(status);
    this.ui.addChild(editor);
    this.ui.addChild(footer);
    this.ui.addChild(hints);

    // Editor 拿焦点
    this.ui.setFocus(editor);

    return { header, loadedResources, chat, status, editor, footer, hints };
  }

  /** 用 dark 主题色拼一个最小 SelectListTheme 占位;M6 阶段补完整色槽。 */
  private makeSelectListTheme(): SelectListTheme {
    return makeSelectListTheme(this.theme);
  }

  /** 启动 TUI;阻塞至 quit() 或 stdin EOF。 */
  async run(): Promise<void> {
    this.unsubscribe = this.agent.subscribe((ev) => this.handleAgentEvent(ev));
    // 注册全局 app.* 键位拦截(M6):在 Editor listener 之前注册,确保优先级
    this.ui.addInputListener(
      createAppKeyListener({
        onInterrupt: () => this.handleInterrupt(),
        onExit: () => this.quit(),
        onRefresh: () => this.ui.invalidate(),
      }),
    );
    //OSC 11 自动探测 dark/light(M6):异步探测,响应到达后切换 theme-factory 生效下次 invalidate
    void detectScheme(this.terminal).then((scheme) => {
      this.maybeSwitchTheme(scheme);
    });
    // TUI.start 是同步阻塞,使用 await 让上层 wrapper 可 await,实际同步start/stop
    this.ui.start();
  }

  /** 中断当前 turn;M8c:真接 agent.interrupt()。 */
  private handleInterrupt(): void {
    if (this.streaming || this.agent.inFlight) {
      this.agent.interrupt();
      this.streaming = false;
      this.ui.requestRender();
    } else {
      // 非 streaming 时把 footer 切 idle
      this.streaming = false;
      this.ui.requestRender();
    }
  }

  /** OSC 11 探测返回 scheme 后切换 theme;M6 真实装 env 覆盖已不依赖 scheme 路径。 */
  private maybeSwitchTheme(scheme: "dark" | "light"): void {
    if (scheme === "dark") {
      // 默认已 dark,无需切换
      return;
    }
    // light:重新 build theme 与 factories;但编辑器主题已被 Editor 实例消费,
    // 替换需要 Editor 暴露 setTheme;本期 M6 暂只刷新 footer / loadedResources 主题;
    // 下次 polish 会做完整 swap。
    this.theme.primary = "#1a1a1a";
    this.ui.invalidate();
  }

  /** 退出 TUI。 */
  quit(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.ui.stop();
  }

  /**
   * 公共 prompt 注入入口;demo 与未来 ReplHandle.sendText 走同一通道。
   *
   * 实现:把 Editor onSubmit 流转过来即可——等价于"程序模拟一键回车提交"。
   * 不调 agent.prompt 直绕,保证 handleSubmit 中 _前_ push UserMessageComponent 一致路径。
   */
  echoPrompt(text: string): void {
    this.handleSubmit(text);
  }

  /**
   * 打开 slash 命令选择器(M5 占位,M6 键位 / 触发接通)。
   * 选中 / xxx 后,把 / xxx 当 user prompt 注入(目前 mock 占位)。
   */
  openSlashCommands(): void {
    const items: SelectItem[] = [
      { value: "/help", label: "/help", description: "Show help" },
      { value: "/clear", label: "/clear", description: "Clear chat" },
      { value: "/model", label: "/model", description: "Switch model" },
      { value: "/thinking", label: "/thinking", description: "Switch thinking level" },
      { value: "/mcp", label: "/mcp", description: "Switch mcp server" },
      { value: "/prompt", label: "/prompt", description: "Pick prompt template" },
    ];
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/commands",
      items,
      onSelect: (item) => {
        this.ui.hideOverlay();
        // 二级 selector 派发
        switch (item.value) {
          case "/model":
            this.openModelSelector();
            break;
          case "/thinking":
            this.openThinkingSelector();
            break;
          default:
            this.echoPrompt(item.value);
        }
      },
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 打开预设 prompt 选择器(M5 占位,M7+ 真实模板接入)。
   */
  openPromptSelector(): void {
    const items: SelectItem[] = [
      { value: "Summarize this repo", label: "Summarize this repo" },
      { value: "Run tests", label: "Run tests" },
    ];
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/prompt templates",
      items,
      onSelect: (item) => this.echoPrompt(item.label),
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 打开 mcp server 选择器(M5 占位,真实 mcp 注册表接入留 M5+ 远期)。
   */
  openMcpServerSelector(): void {
    const items: SelectItem[] = [];
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/mcp servers (none loaded)",
      items,
      onSelect: () => this.ui.hideOverlay(),
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 打开 /model 选择器(M8d)。从 modelRegistry 取候选 SelectItem;
   * 选中后调 agent.setModel(modelEntry.model),Footer 下次 pull 自动反映新 modelId。
   */
  openModelSelector(): void {
    const items: SelectItem[] = this.modelRegistry.map((entry) => ({
      value: entry.id,
      label: entry.label,
      description: entry.description,
    }));
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/model — switch model",
      items,
      onSelect: (item) => {
        const entry = this.modelRegistry.find((e) => e.id === item.value);
        if (entry) {
          this.agent.setModel(entry.model);
        }
        this.ui.hideOverlay();
      },
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 打开 /thinking 选择器(M8e)。候选 ThinkingLevel;
   * 选中后注入到当前 thinkingLevel,触发 agent.setState 透传到下次 prompt。
   * 注:thinking level 切换是 streamFn options 责任;对用 createAnthropicAgent 装的 agent,
   *   其 streamFn 包络读取 thinkingLevel closure;改 thinking 需要 streamFn 重建。
   *   M8 简化:thinkingLevel 切换通过 hook 注入(由 caller 注册 onThinkingChange 回调);
   *   默认实现仅记录到 this.thinkingLevel 供 Footer 显示。
   */
  openThinkingSelector(): void {
    const items: SelectItem[] = [
      { value: "minimal", label: "minimal", description: "thinking off" },
      { value: "low", label: "low", description: "4k budget" },
      { value: "medium", label: "medium", description: "10k budget" },
      { value: "high", label: "high", description: "32k budget" },
      { value: "xhigh", label: "xhigh", description: "64k budget" },
    ];
    const modal = new SelectorModal({
      theme: this.theme,
      selectListTheme: makeSelectListTheme(this.theme),
      title: "/thinking — switch thinking level",
      items,
      onSelect: (item) => {
        this.setThinkingLevel(item.value as ThinkingLevel);
        this.ui.hideOverlay();
      },
      onCancel: () => this.ui.hideOverlay(),
    });
    this.ui.showOverlay(modal, { anchor: "bottom-left" });
  }

  /**
   * 切换 thinking level:记录到 this.thinkingLevel + 调可选 onThinkingChange 钩子。
   * 默认钩子(由 demo 注入)负责 agent.streamFn 重建或 AgentLoopConfig 透传。
   */
  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
    this.onThinkingChange?.(level);
    this.ui.requestRender();
  }

  getThinkingLevel(): ThinkingLevel {
    return this.thinkingLevel;
  }

  /** FooterSnapshotProvider:由 Footer.render 周期性 pull。 */
  isStreaming(): boolean {
    return this.streaming;
  }
  getStopReason(): string | undefined {
    return this.stopReason;
  }
  getModelId(): string {
    const st = this.agent.state.model;
    return typeof st === "string" ? st : (st as { id?: string }).id ?? "<unknown-model>";
  }
  getSessionId(): string {
    return this.agent.sessionId;
  }

  /** Editor.onSubmit 回调;把文本作为 user prompt 投递给 Agent,同时落 UI。 */
  private handleSubmit(text: string): void {
    if (text.length === 0) {
      return;
    }
    // M8d/e:文本以 "/" 开头则视为 slash 命令触发,不发给 LLM。
    // /model /thinking /mcp /prompt 等直接打开选择器;/help /clear 等查询命令
    // 暂时也走 echoPrompt 路径(后续完善)。
    if (text.startsWith("/")) {
      const cmd = text.slice(1);
      switch (cmd) {
        case "model":
          this.openModelSelector();
          return;
        case "thinking":
          this.openThinkingSelector();
          return;
        case "mcp":
          this.openMcpServerSelector();
          return;
        case "prompt":
          this.openPromptSelector();
          return;
        case "commands":
        case "help":
          this.openSlashCommands();
          return;
        case "clear":
          this.refs.chat.clear();
          this.ui.requestRender();
          return;
        default:
          // 未知 /xxx 兜底:仍当 prompt 发给 agent(便于在 mock 上看到 /unknown 文本)
          break;
      }
    }
    // push 用户消息块到 chat viewport
    this.refs.chat.push(
      new UserMessageComponent({
        theme: this.theme,
        text,
        timestamp: Date.now(),
      }),
    );
    // 同步置 streaming=true,footer 立即显示状态
    this.streaming = true;
    this.stopReason = undefined;
    this.ui.requestRender();
    // agent.prompt 异步执行;事件回流驱动 footer 与 chat 更新
    void this.agent.prompt(text).then(
      () => {
        // agent.prompt resolve 即所有回合结束;最终状态由 agent_end 路径写入
      },
      (err: unknown) => {
        // 异常不外抛(对照 02 §1 不可变契约);记 stderr
        process.stderr.write(`[interactive-mode] agent.prompt failed: ${String(err)}\n`);
      },
    );
  }

  /** Agent.subscribe 回调,适配为 TuiEvent 后分发。 */
  private handleAgentEvent(ev: AgentEvent): void {
    let adapted: TuiEvent;
    try {
      adapted = adaptAgentEvent(ev);
    } catch (e) {
      process.stderr.write(`[interactive-mode] adaptAgentEvent failed: ${String(e)}\n`);
      return;
    }
    this.handleEvent(adapted);
  }

  /**
   * 主控 switch;M2 阶段:message_* 路由把 AssistantMessageComponent 挂上 chat 并流式更新;
   * user 消息块在 handleSubmit 阶段已 push,事件流不再处理 user 分支;
   * 其余 case 留 noop 占位,M3 起逐 case 落实(对照 03-event-binding §1 表)。
   */
  private handleEvent(ev: TuiEvent): void {
    try {
      switch (ev.type) {
        case "agent_start":
          this.streaming = true;
          this.stopReason = undefined;
          break;
        case "agent_end":
          this.streaming = false;
          // agent_end 不带 stopReason,保留最近一次 turn_end / message_end 的 stopReason
          break;
        case "turn_start":
          this.refs.status.setTurn(ev.turn);
          break;
        case "turn_end":
          this.refs.status.setTurn(ev.turn);
          if (ev.stopReason) this.refs.status.setStopReason(ev.stopReason);
          break;
        case "message_start":
          if (ev.role === "assistant") {
            // push 一个新的 AssistantMessageComponent,流式阶段 partial 为空(等 message_update)
            const comp = new AssistantMessageComponent({ theme: this.theme });
            this.refs.chat.push(comp);
          }
          break;
        case "message_end":
          this.stopReason = ev.stopReason ?? this.stopReason;
          this.refs.status.setStopReason(this.stopReason);
          if (ev.role === "assistant") {
            // finalize:从 chat 末位调 finalize,通知 Markdown layout flush
            const last = this.refs.chat.last();
            if (last instanceof AssistantMessageComponent) {
              last.finalize();
            }
          }
          break;
        case "message_update": {
          const e = ev.assistantMessageEvent;
          if (e.type === "done" || e.type === "error") {
            // done/error 即 stream fan-in 终点;final 已在 message_end 路径处理
            break;
          }
          const partial = (e as { partial?: AssistantMessage }).partial;
          if (partial === undefined) break;
          if (partial.role !== "assistant") break;
          // 找 chat 末位的 AssistantMessageComponent;若没有则补 push 一份
          let last = this.refs.chat.last();
          if (!(last instanceof AssistantMessageComponent)) {
            const comp = new AssistantMessageComponent({ theme: this.theme, partial });
            this.refs.chat.push(comp);
            last = comp;
          } else {
            last.setPartial(partial);
          }
          // M3 临时:从 partial 抽 toolCalls 占位记录(本期不在 UI 中渲染);后续 M3 路由
          void extractToolCalls(partial);
          break;
        }
        case "tool_execution_start": {
          const comp = new ToolCallComponent({
            theme: this.theme,
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            initialStatus: "running",
          });
          this.toolCallComponents.set(ev.toolCallId, comp);
          this.refs.chat.push(comp);
          break;
        }
        case "tool_execution_update": {
          const comp = this.toolCallComponents.get(ev.toolCallId);
          if (comp) {
            comp.setPartialResult(ev.partialResult as AgentToolResult);
          }
          break;
        }
        case "tool_execution_end": {
          const comp = this.toolCallComponents.get(ev.toolCallId);
          if (comp) {
            comp.setStatus(ev.isError ? "error" : "ok");
            // ToolResultComponent 也追加一份(显式 done 行)
            const resultComp = new ToolResultComponent({
              theme: this.theme,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              result: { content: [], details: undefined } as AgentToolResult,
              isError: ev.isError ?? false,
              timestamp: ev.timestamp,
            });
            this.refs.chat.push(resultComp);
            this.toolCallComponents.delete(ev.toolCallId);
          }
          break;
        }
      }
    } catch (e) {
      // 异常不外抛(对照 02 §1 不可变契约);记 stderr
      process.stderr.write(`[interactive-mode] handleEvent ${ev.type} failed: ${String(e)}\n`);
    }
    // 任何事件后都请求一次合帧
    this.ui.requestRender();
  }
}
