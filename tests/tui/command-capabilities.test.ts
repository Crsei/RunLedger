import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { SelectionView } from "../../src/tui/components/selection-view.ts";
import type { SlashCommandPopup } from "../../src/tui/components/slash-command-popup.ts";
import type { TUI } from "../../src/tui/index.ts";
import type { SessionDomainResult } from "../../src/runtime/session-runtime/domain-router.ts";
import { ContractController, ContractTerminal } from "./fixtures/contract-integration.ts";

function notices(mode: InteractiveMode): string {
  return mode.getTuiState().timeline.committedRows
    .flatMap((row) => row.kind === "notice" ? [row.message.text] : [])
    .join("\n");
}

async function withMode(controller: ContractController, run: (mode: InteractiveMode, terminal: ContractTerminal) => Promise<void>): Promise<void> {
  const terminal = new ContractTerminal(100, 30);
  const mode = new InteractiveMode({ controller, terminal });
  const running = mode.run();
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await run(mode, terminal);
  } finally {
    mode.quit();
    await running;
  }
}

describe("Session command availability", () => {
  it.each([
    ["/compact", "summary"],
    ["/memory", "/resume"],
    ["/remember keep this note", "/resume"],
  ])("explains unavailable %s without sending a domain request", async (command, advice) => {
    const requests: string[] = [];
    const controller = new ContractController({
      supportedOperations: [],
      querySessionDomain: async (operation) => { requests.push(operation); return {}; },
      commandSessionDomain: async (operation) => { requests.push(operation); return {}; },
    });
    await withMode(controller, async (mode) => {
      mode.echoPrompt(command);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(notices(mode)).toContain("unavailable in this session");
      expect(notices(mode)).toContain("operation_unavailable");
      expect(notices(mode)).toContain(advice);
      expect(requests).toEqual([]);
    });
  });

  it("labels unavailable commands in the typing popup and rejects its Enter action", async () => {
    await withMode(new ContractController({ supportedOperations: [] }), async (mode, terminal) => {
      terminal.send("/");
      terminal.send("memory");
      const popup = (mode as unknown as { readonly slashPopup?: SlashCommandPopup }).slashPopup;
      expect(popup?.selectedItem()?.description).toContain("Unavailable in this session");
      terminal.send("\r");
      expect(notices(mode)).toContain("unavailable in this session");
      expect(notices(mode)).toContain("/resume");
    });
  });

  it("labels unavailable commands in /commands and rejects a selected action", async () => {
    await withMode(new ContractController({ supportedOperations: [] }), async (mode) => {
      mode.openSlashCommands();
      const overlay = (mode as unknown as { readonly ui: TUI }).ui.getOverlay();
      expect(overlay).toBeInstanceOf(SelectionView);
      if (!(overlay instanceof SelectionView)) throw new Error("missing command selector");
      const block = overlay.present()[0];
      if (block?.kind !== "select") throw new Error("missing selector presentation");
      const index = block.options.findIndex((option) => option.label === "/memory");
      expect(index).toBeGreaterThanOrEqual(0);
      expect(block.options[index]?.description).toContain("Unavailable in this session");
      for (let count = 0; count < index; count += 1) overlay.handleInput("\x1b[B");
      overlay.handleInput("\r");
      expect(notices(mode)).toContain("unavailable in this session");
    });
  });

  it("dispatches a negotiated memory query and presents its real result", async () => {
    const requests: string[] = [];
    const controller = new ContractController({
      supportedOperations: ["memory.inspect"],
      querySessionDomain: async (operation) => {
        requests.push(operation);
        return { memory: { recordCount: 2, proposalCount: 0, generation: 1 } };
      },
    });
    await withMode(controller, async (mode) => {
      mode.echoPrompt("/memory");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(requests).toEqual(["memory.inspect"]);
      expect(notices(mode)).toContain("records=2");
      expect(notices(mode)).not.toContain("unavailable");
    });
  });

  it("explains a server unavailable response after local capability negotiation", async () => {
    class UnavailableController extends ContractController {
      override readonly querySessionDomain = async (operation: string): Promise<SessionDomainResult> => ({
        ok: false, status: "unavailable", code: "operation_unavailable", operation,
      });
    }
    await withMode(new UnavailableController({ supportedOperations: ["memory.inspect"] }), async (mode) => {
      mode.echoPrompt("/memory");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(notices(mode)).toContain("unavailable in this session");
      expect(notices(mode)).toContain("/resume");
      expect(notices(mode)).toContain("operation_unavailable");
    });
  });
});
