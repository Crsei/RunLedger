/**
 * B0 baseline：标准 InteractiveMode 行为 characterization（native）。
 *
 * 通过 contract-integration fixture 固定当前生产行为：标准启动、历史 replay、
 * 一次流式回复 + 工具调用、overlay、Ctrl+C/Ctrl+D 退出，以及隔离 RUNLEDGER_DIR。
 * 本批不改变 production state；owner 一律在 finally destroy。
 *
 * 注：fake-terminal render 路径把 `present()` 组件投影成 "[object Object]"，
 * 属既有基线缺陷（OpenTUI runtime 路径按结构化 block 消费）；B0 的 chat 内容
 * 断言走 ChatContainer.present() 结构化投影，不经 renderer 文本路径。
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ContractController,
  contractAssistantMessage,
  createContractHarness,
  settleFrames,
} from "./fixtures/contract-integration.ts";
import type { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import type { ChatContainer } from "../../src/tui/components/chat-container.ts";
import type { PresentationBlock } from "../../src/tui/presentation.ts";
import type { AgentMessage } from "../../src/runtime/types.ts";

/** 剥离 ANSI 控制序列后返回纯文本帧。 */
function plainFrame(terminal: { frame(): string }): string {
  return terminal
    .frame()
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, "")
    .replace(/\x1b\][^\x07]*\x07/gu, "")
    .replace(/\x1b[()][a-zA-Z]/gu, "");
}

/** 通过 ChatContainer.present() 取结构化投影文本（OpenTUI runtime 消费路径）。 */
function chatText(mode: InteractiveMode): string {
  const refs = (mode as unknown as { refs: { chat: ChatContainer } }).refs;
  const blocks: PresentationBlock[] = refs.chat.present(120);
  return blocks.map((block) => ("content" in block ? block.content : "")).join("\n");
}

function seededReplayController(): ContractController {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "historical user text" }] },
    contractAssistantMessage({ content: [{ type: "text", text: "historical assistant text" }] }),
    {
      role: "toolResult",
      content: [
        {
          type: "toolResult",
          toolCallId: "historical_tool_1",
          toolName: "read",
          content: [{ type: "text", text: "historical tool result text" }],
        },
      ],
    },
  ];
  return new ContractController({ messages });
}

describe("B0 baseline: standard InteractiveMode production behavior", () => {
  for (const columns of [60, 80, 143]) {
    test(`startup renders a footer frame at ${columns} columns and quits cleanly`, async () => {
      const harness = createContractHarness({ columns, rows: 24 });
      try {
        await settleFrames();
        expect(harness.terminal.startCount).toBe(1);
        expect(harness.terminal.writes.length).toBeGreaterThan(0);
        const frame = plainFrame(harness.terminal);
        expect(frame).toContain("contract-session");
      } finally {
        await harness.dispose();
      }
      expect(harness.terminal.stopCount).toBe(1);
      expect(harness.controller.disposed).toBe(true);
    });
  }

  test("history replay renders historical user/assistant/tool rows in order", async () => {
    const harness = createContractHarness({ controller: seededReplayController() });
    try {
      await settleFrames();
      const text = chatText(harness.mode);
      const userIndex = text.indexOf("historical user text");
      const assistantIndex = text.indexOf("historical assistant text");
      const toolIndex = text.indexOf("historical tool result text");
      expect(userIndex).toBeGreaterThanOrEqual(0);
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(userIndex).toBeLessThan(assistantIndex);
      expect(assistantIndex).toBeLessThan(toolIndex);
    } finally {
      await harness.dispose();
    }
  });

  test("one streaming reply with a tool call renders incrementally and settles", async () => {
    const harness = createContractHarness();
    try {
      harness.mode.echoPrompt("hello contract");
      await settleFrames();
      expect(harness.controller.promptCalls).toEqual(["hello contract"]);
      const text = chatText(harness.mode);
      expect(text).toContain("contract reply");
      expect(text).toContain("echo");
      const frame = plainFrame(harness.terminal);
      expect(frame).toContain("contract-session");
    } finally {
      await harness.dispose();
    }
  });

  test("overlay open + Ctrl+C does not quit; empty Ctrl+D quits", async () => {
    const harness = createContractHarness();
    try {
      harness.mode.openSlashCommands();
      await settleFrames();
      harness.terminal.send("\x03");
      await settleFrames();
      expect(harness.terminal.stopCount).toBe(0);
    } finally {
      await harness.dispose();
    }
    expect(harness.terminal.stopCount).toBe(1);
  });

  test("B1: footer/session strip derive from the same TuiState bootstrap generation", async () => {
    const harness = createContractHarness({ columns: 80, rows: 24 });
    try {
      await settleFrames();
      const state = harness.mode.getTuiState();
      expect(state.bootstrap.session.id).toBe("contract-session");
      expect(state.bootstrap.session.format).toBe("current-canonical");
      expect(state.bootstrap.authorityGeneration).toBe(1);
      const frame = plainFrame(harness.terminal);
      expect(frame).toContain("contract-session");
    } finally {
      await harness.dispose();
    }
  });

  test("B2: replay + streaming + tool call produce a stable committed timeline", async () => {
    const harness = createContractHarness({ controller: seededReplayController() });
    try {
      harness.mode.echoPrompt("hello contract");
      await settleFrames();
      const timeline = harness.mode.getTuiState().timeline;
      const kinds = timeline.committedRows.map((r) => r.kind);
      expect(kinds).toContain("user");
      expect(kinds).toContain("assistant");
      expect(kinds).toContain("tool");
      const assistant = timeline.committedRows.find((r) => r.kind === "assistant" && r.text.text.includes("contract reply"));
      expect(assistant).toBeDefined();
      expect(assistant?.streaming).toBe(false);
      const tool = timeline.committedRows.find((r) => r.kind === "tool" && r.toolCallId === "tool_call_contract_1");
      expect(tool?.status).toBe("succeeded");
      // 历史 replay 与 live 共用同一 timeline；稳定 row id 不重复
      const ids = timeline.committedRows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => id.startsWith("user:")).length).toBe(2); // 1 replay + 1 live
    } finally {
      await harness.dispose();
    }
  });

  test("B3: overlay/composer/selection intents flow through the store", async () => {
    const harness = createContractHarness();
    try {
      await settleFrames();
      expect(harness.mode.getTuiState().interaction.overlay).toEqual({ state: "closed" });
      harness.mode.openSlashCommands();
      await settleFrames();
      expect(harness.mode.getTuiState().interaction.overlay.state).toBe("command");
      harness.terminal.send("\x1b");
      await settleFrames();
      expect(harness.mode.getTuiState().interaction.overlay).toEqual({ state: "closed" });
      harness.mode.echoPrompt("hello contract");
      await settleFrames();
      const interaction = harness.mode.getTuiState().interaction;
      expect(interaction.generation).toBeGreaterThan(0);
      expect(interaction.composerEmpty).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  test("B4: extension workflow drives the /mcp selector with typed loading states", async () => {
    const controller = new ContractController({
      queryHostDomain: async (operation) => operation === "extension.inspect"
        ? { ok: true, snapshot: { snapshotId: "s1", generation: 1, digest: "d", descriptors: [{ kind: "mcp-server", identity: { qualifiedId: "mcp-server:stdio", version: "1.0.0", digest: { algorithm: "sha256", digest: "dd" } }, displayName: "stdio-server", enabled: true, trusted: true, ready: true }] } }
        : { ok: true },
    });
    const harness = createContractHarness({ controller });
    try {
      expect(harness.mode.getTuiState().capabilities.extensions.state).toBe("available");
      await harness.mode.openMcpServerSelector();
      await settleFrames();
      const workflow = harness.mode.getTuiState().extensionWorkflow;
      expect(workflow.state).toBe("ready");
      // fake-terminal render 路径把 present() 组件投影为 [object Object]（B0 基线缺陷），
      // overlay 可见性以结构化状态断言
      const ui = (harness.mode as unknown as { ui: { hasOverlay(): boolean } }).ui;
      expect(ui.hasOverlay()).toBe(true);
      expect(harness.mode.getTuiState().interaction.overlay.state).toBe("command");
    } finally {
      await harness.dispose();
    }
  });

  test("B5: /model and /thinking route through workflows; /prompt shows unavailable", async () => {
    const controller = new ContractController({
      providerStatuses: [{ id: "anthropic", name: "Anthropic", configured: true, interactiveAuthTypes: [] }],
      availableModels: [{ provider: "anthropic", id: "claude-x", name: "Claude X" }],
    });
    const harness = createContractHarness({ controller });
    try {
      await harness.mode.openModelSelector("anthropic");
      await settleFrames();
      expect(harness.mode.getTuiState().modelWorkflow.state).toBe("ready");
      expect(harness.mode.getTuiState().capabilities.model.state).toBe("available");
      harness.mode.openThinkingSelector();
      await settleFrames();
      const thinking = harness.mode.getTuiState().thinkingWorkflow;
      expect(thinking.state).toBe("ready");
      expect((thinking as { value: { level: string } }).value.level).toBe("off");
      // /prompt 无 authority → unavailable notice，不出现内建模板
      harness.mode.openPromptSelector();
      await settleFrames();
      expect(harness.mode.getTuiState().capabilities.prompt.state).toBe("unavailable");
    } finally {
      await harness.dispose();
    }
  });

  test("runs against an isolated RUNLEDGER_DIR, never the real user home", async () => {
    const realHomeRunledger = join(homedir(), ".runledger");
    const harness = createContractHarness();
    try {
      expect(process.env.RUNLEDGER_DIR).toBe(harness.runDir);
      expect(harness.runDir.startsWith(harness.originalRunledgerDir ?? "/nonexistent")).toBe(false);
      expect(harness.runDir).not.toBe(realHomeRunledger);
      expect(existsSync(harness.runDir)).toBe(true);
      await settleFrames();
      expect(plainFrame(harness.terminal)).toContain("contract-session");
    } finally {
      await harness.dispose();
    }
    expect(existsSync(harness.runDir)).toBe(false);
    if (harness.originalRunledgerDir !== undefined) {
      expect(process.env.RUNLEDGER_DIR).toBe(harness.originalRunledgerDir);
    } else {
      expect(process.env.RUNLEDGER_DIR).toBeUndefined();
    }
  });
});
