import { describe, expect, it, vi } from "vitest";
import { InteractiveMode, type InteractiveModeOptions } from "../../src/tui/interactive-mode.ts";
import { TranscriptOverlayComponent } from "../../src/tui/transcript-view.ts";
import type { SessionDomainResult } from "../../src/runtime/session-runtime/domain-router.ts";
import type { PromptDumpDocument, PromptDumpPort } from "../../src/tui/interactive/types.ts";
import { findCommand } from "../../src/tui/commands/registry.ts";
import { ContractController, ContractTerminal } from "./fixtures/contract-integration.ts";

const INSPECTION: Record<string, unknown> = {
  systemPrompt: "You are RunLedger's interactive coding agent.\n\nAGENTS: keep replies concise.",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
  source: "assembled",
  selection: { provider: "captured-provider", model: "captured-model", thinkingLevel: "high" },
  turn: 4,
  capturedAtMs: 1_700_000_000_000,
  assembledPromptDigest: { algorithm: "sha256", digest: "a".repeat(64) },
  basePromptDigest: { algorithm: "sha256", digest: "b".repeat(64) },
  compositionDigest: { algorithm: "sha256", digest: "c".repeat(64) },
};

function notices(mode: InteractiveMode): string {
  return mode.getTuiState().timeline.committedRows
    .flatMap((row) => row.kind === "notice" ? [row.message.text] : [])
    .join("\n");
}

function overlayText(mode: InteractiveMode): string {
  const overlay = mode.overlayComponent;
  return overlay instanceof TranscriptOverlayComponent ? overlay.render(120).join("\n") : "";
}

async function withMode(
  controller: ContractController,
  run: (mode: InteractiveMode, terminal: ContractTerminal) => Promise<void>,
  options: Omit<InteractiveModeOptions, "controller" | "terminal"> = {},
): Promise<void> {
  const terminal = new ContractTerminal(100, 30);
  const mode = new InteractiveMode({ controller, terminal, ...options });
  const running = mode.run();
  try {
    // 与既有 TUI harness(contract-integration)一致:先让 init 的 microtask 落地再注入输入。
    await Promise.resolve();
    await Promise.resolve();
    await run(mode, terminal);
  } finally {
    mode.quit();
    await running;
  }
}

describe("/dump assembled system prompt", () => {
  it("is a read-only command gated on the prompt inspection operation", () => {
    expect(findCommand("dump")).toMatchObject({
      canonicalName: "dump",
      actionType: "ui.dump",
      requiredOperation: "session.prompt.inspect",
      supportsInlineArgs: false,
      availableDuringTask: true,
      policy: { draft: "allowed", history: "allowed", query: "allowed", frozen: "allowed" },
    });
  });

  it("renders the assembled prompt and writes the sidecar document", async () => {
    const requests: string[] = [];
    const documents: PromptDumpDocument[] = [];
    const promptDumpPort: PromptDumpPort = {
      write: async (document) => { documents.push(document); return { ok: true, path: "/tmp/home/tmp/dump/prompt-dump-contract-session-1.json" }; },
    };
    const controller = new ContractController({
      supportedOperations: ["session.prompt.inspect"],
      querySessionDomain: async (operation) => { requests.push(operation); return INSPECTION; },
    });
    await withMode(controller, async (mode) => {
      mode.echoPrompt("/dump");
      await vi.waitFor(() => { expect(notices(mode)).toContain("/dump: assembled at turn 4"); });

      expect(requests).toEqual(["session.prompt.inspect"]);
      const overlay = overlayText(mode);
      expect(overlay).toContain("## System Prompt");
      expect(overlay).toContain("keep replies concise");
      expect(overlay).toContain("## Configuration");
      expect(overlay).toContain("Prompt source: assembled · turn 4");
      expect(overlay).toContain("- read — Read a file");
      expect(overlay).toContain("Prompt dump");
      expect(overlay).toContain("Model: captured-model");
      expect(overlay).toContain("Thinking: high");
      expect(notices(mode)).toContain("Clipboard: unavailable in this terminal");
      expect(notices(mode)).toContain("JSON: /tmp/home/tmp/dump/prompt-dump-contract-session-1.json");
    }, { promptDumpPort, harnessProfile: { id: "standard", version: 1 }, permissionProfile: "default" });

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      kind: "runledger.prompt-dump",
      sessionId: "contract-session",
      permissionProfile: "default",
      selection: { provider: "captured-provider", model: "captured-model", thinkingLevel: "high" },
      harnessProfile: { id: "standard", version: 1 },
      prompt: { source: "assembled", turn: 4, systemPrompt: INSPECTION.systemPrompt },
    });
  });

  it("explains the missing capability without sending a domain request", async () => {
    const requests: string[] = [];
    const controller = new ContractController({
      supportedOperations: [],
      querySessionDomain: async (operation) => { requests.push(operation); return INSPECTION; },
    });
    await withMode(controller, async (mode) => {
      mode.echoPrompt("/dump");
      await vi.waitFor(() => { expect(notices(mode)).toContain("unavailable in this session"); });
      expect(requests).toEqual([]);
      expect(notices(mode)).toContain("/trajectory");
      expect(overlayText(mode)).toBe("");
    });
  });

  it("rejects inline arguments with usage", async () => {
    await withMode(new ContractController({ supportedOperations: ["session.prompt.inspect"] }), async (mode) => {
      mode.echoPrompt("/dump now");
      await vi.waitFor(() => { expect(notices(mode)).toContain("Usage: /dump"); });
    });
  });

  it("fails closed when the prompt exceeds the single-frame budget", async () => {
    class OversizeController extends ContractController {
      override readonly querySessionDomain = async (operation: string): Promise<SessionDomainResult> => ({
        ok: false, status: "failed", code: "prompt_inspect_too_large", operation,
      });
    }
    await withMode(new OversizeController({ supportedOperations: ["session.prompt.inspect"] }), async (mode) => {
      mode.echoPrompt("/dump");
      await vi.waitFor(() => { expect(notices(mode)).toContain("single-frame budget"); });
      expect(overlayText(mode)).toBe("");
    });
  });
});
