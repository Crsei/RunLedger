import { describe, expect, it } from "vitest";
import { createInitialTuiState } from "../../src/tui/application/reducer.ts";
import {
  builtinCommandDefinitions,
  COMPATIBILITY_COMMAND_NAMES,
} from "../../src/tui/commands/builtins.ts";
import { executeCommand } from "../../src/tui/commands/executor.ts";
import { parseCommand } from "../../src/tui/commands/parser.ts";
import { CommandRegistry } from "../../src/tui/commands/registry.ts";
import type { CommandDefinition } from "../../src/tui/commands/types.ts";

const BOOTSTRAP = {
  workspace: "/workspace",
  session: { id: "session-1", format: "v3" as const, lifecycle: "active" as const },
};

describe("command registry/parser/executor", () => {
  it("uses one complete catalog with /help as the only alias", () => {
    const registry = new CommandRegistry(builtinCommandDefinitions());
    expect(registry.snapshot.definitions.map((item) => item.canonicalName)).toEqual([
      "commands",
      "sessions",
      "session",
      "clear",
      "provider",
      "login",
      "logout",
      "model",
      "thinking",
      "plugins",
      "skills",
      "hooks",
      "mcp",
      "reload-extensions",
      "prompt",
      "quit",
    ]);
    expect(registry.snapshot.byName.help).toBe(registry.snapshot.byName.commands);
  });

  it("registers /sessions as native and gates it on the read-only catalog capability", () => {
    const snapshot = new CommandRegistry(builtinCommandDefinitions()).snapshot;
    const definition = snapshot.byName.sessions!;
    expect(definition.executionStrategy).toBe("native");
    expect(definition.historyPolicy).toBe("ephemeral");
    expect(definition.activeQueryPolicy).toBe("reject");
    expect(definition.availability(createInitialTuiState(BOOTSTRAP))).toMatchObject({
      state: "disabled",
    });
    expect(definition.availability(createInitialTuiState(BOOTSTRAP, {
      sessionCatalog: { available: true },
    }))).toEqual({ state: "available" });
    expect(snapshot.definitions).toHaveLength(16);
  });

  it("derives native /session identity from bootstrap and gates it on catalog capability", () => {
    const snapshot = new CommandRegistry(builtinCommandDefinitions()).snapshot;
    const state = createInitialTuiState(BOOTSTRAP, {
      sessionCatalog: { available: true },
    });
    const parsed = parseCommand("/session", snapshot, "command:session");
    if (!parsed.ok) throw new Error("fixture parse failed");
    const output = executeCommand(state, snapshot, parsed.intent);
    expect(output.actions).toMatchObject([{
      type: "effect.dispatch",
      effect: {
        type: "session.current.enrich",
        sessionId: BOOTSTRAP.session.id,
        correlationId: "command:session",
      },
    }]);
    expect(snapshot.byName.session).toMatchObject({
      executionStrategy: "native",
      historyPolicy: "ephemeral",
      activeQueryPolicy: "reject",
    });
  });

  it("keeps /clear native, ephemeral, immediate, and outside compatibility", () => {
    const snapshot = new CommandRegistry(builtinCommandDefinitions()).snapshot;
    const clear = snapshot.byName.clear!;
    expect(clear).toMatchObject({
      executionStrategy: "native",
      historyPolicy: "ephemeral",
      activeQueryPolicy: "immediate",
    });
    expect(COMPATIBILITY_COMMAND_NAMES).not.toContain("clear");
    expect(COMPATIBILITY_COMMAND_NAMES).toHaveLength(11);
  });

  it("keeps /provider native, ephemeral, reject-on-active, and capability-gated", () => {
    const snapshot = new CommandRegistry(builtinCommandDefinitions()).snapshot;
    const provider = snapshot.byName.provider!;
    expect(provider).toMatchObject({
      executionStrategy: "native",
      historyPolicy: "ephemeral",
      activeQueryPolicy: "reject",
    });
    expect(COMPATIBILITY_COMMAND_NAMES).not.toContain("provider");
    expect(provider.availability(createInitialTuiState(BOOTSTRAP))).toMatchObject({
      state: "disabled",
    });
    const state = createInitialTuiState(BOOTSTRAP, {
      providerWorkflow: { available: true },
    });
    expect(provider.availability(state)).toEqual({ state: "available" });
    const parsed = parseCommand("/provider", snapshot, "command:provider");
    if (!parsed.ok) throw new Error("provider fixture parse failed");
    expect(executeCommand(state, snapshot, parsed.intent).actions).toMatchObject([{
      type: "effect.dispatch",
      effect: {
        type: "provider.status",
        correlationId: "command:provider",
      },
    }]);
  });

  it("rejects duplicate canonical names and aliases", () => {
    const definitions = builtinCommandDefinitions();
    expect(() => new CommandRegistry([definitions[0]!, definitions[0]!])).toThrow("duplicate");
  });

  it("normalizes aliases and validates argument counts without shell expansion", () => {
    const snapshot = new CommandRegistry(builtinCommandDefinitions()).snapshot;
    expect(parseCommand("/help", snapshot, "command:1")).toMatchObject({
      ok: true,
      intent: { canonicalName: "commands", normalizedArgs: [] },
    });
    expect(parseCommand("/clear unexpected", snapshot, "command:2")).toMatchObject({
      ok: false,
      canonicalName: "clear",
    });
    expect(parseCommand("/missing", snapshot, "command:3")).toMatchObject({
      ok: false,
      message: "Unknown command: /missing",
    });
  });

  it("opens /commands synchronously and routes compatibility through one effect", () => {
    const snapshot = new CommandRegistry(builtinCommandDefinitions()).snapshot;
    const state = createInitialTuiState(BOOTSTRAP);
    const commands = parseCommand("/commands", snapshot, "command:1");
    const model = parseCommand("/model", snapshot, "command:2");
    if (!commands.ok || !model.ok) throw new Error("fixture parse failed");
    expect(executeCommand(state, snapshot, commands.intent).actions.map((item) => item.type)).toEqual([
      "overlay.set",
      "command.terminal",
    ]);
    expect(executeCommand(state, snapshot, model.intent).actions).toMatchObject([{
      type: "effect.dispatch",
      effect: { type: "command.compatibility", canonicalName: "model" },
    }]);
  });

  it("fails closed on stale generation before calling a handler", () => {
    let calls = 0;
    const definition: CommandDefinition = {
      ...builtinCommandDefinitions()[0]!,
      canonicalName: "probe",
      aliases: [],
      handler: () => {
        calls++;
        return { state: "handled" };
      },
    };
    const registry = new CommandRegistry([definition]);
    const parsed = parseCommand("/probe", registry.snapshot, "command:1");
    if (!parsed.ok) throw new Error("fixture parse failed");
    registry.replace([definition]);
    const output = executeCommand(createInitialTuiState(BOOTSTRAP), registry.snapshot, parsed.intent);
    expect(calls).toBe(0);
    expect(output.actions[0]).toMatchObject({
      type: "command.terminal",
      terminal: { state: "failed" },
    });
  });

  it("executes immediate UI commands or rejects query-producing commands while active", () => {
    const snapshot = new CommandRegistry(builtinCommandDefinitions()).snapshot;
    const active = {
      ...createInitialTuiState(BOOTSTRAP),
      queryGuard: {
        state: "running" as const,
        correlationId: "prompt:1",
        effectId: "prompt:1:effect:0",
      },
    };
    const immediate = parseCommand("/clear", snapshot, "command:1");
    const rejected = parseCommand("/model", snapshot, "command:2");
    if (!immediate.ok || !rejected.ok) throw new Error("fixture parse failed");
    expect(executeCommand(active, snapshot, immediate.intent).actions.map((item) => item.type)).toEqual([
      "timeline.viewport.clear",
      "command.terminal",
    ]);
    expect(executeCommand(active, snapshot, rejected.intent).actions[0]).toMatchObject({
      type: "command.terminal",
      terminal: { state: "failed", message: "another query is active" },
    });
  });
});
