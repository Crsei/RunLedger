import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stream, streamSimple } from "../../../src/api/openai-completions.ts";
import { defaultConvertToLlm } from "../../../src/runtime/agent-loop.ts";
import { assembleAgentModelContext } from "../../../src/runtime/context/model-request-adapter.ts";
import type { AgentMessage } from "../../../src/runtime/types.ts";
import { createModels, createProvider } from "../../../src/models.ts";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { claimDriver, fetchDomainSnapshot } from "../../../src/cli/main.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createCatalogModelRouter } from "../../../src/runtime/model-routing/catalog-router.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { AgentEvent } from "../../../src/runtime/types.ts";
import type { Model } from "../../../src/types.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

describe("harness hardening through HTTP and Session Owner", () => {
  it.each([
    { mode: "off", terminal: "error" },
    { mode: "events", terminal: "error" },
    { mode: "off", terminal: "partial_error" },
    { mode: "events", terminal: "partial_error" },
    { mode: "off", terminal: "tool_calls" },
    { mode: "events", terminal: "tool_calls" },
    { mode: "off", terminal: "overflow" },
    { mode: "events", terminal: "overflow" },
  ] as const)("keeps $terminal execution evidence accurate with recording $mode", async ({ mode, terminal }) => {
    const fails = terminal === "error" || terminal === "partial_error";
    const root = mkdtempSync(join(tmpdir(), "runledger-hardening-owner-"));
    const home = join(root, "home"); mkdirSync(home);
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: Record<string, unknown>, finish: string | null = null) => res.write(`data: ${JSON.stringify({
        id: "hardening", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      if (requests.length === 1) {
        send({ role: "assistant", tool_calls: [{ index: 0, id: "call_hardening", type: "function", function: { name: "bash", arguments: terminal === "partial_error" ? '{"command":' : JSON.stringify({ command: terminal === "overflow" ? "printf HEAD; printf '%080000d' 0; printf TAIL_FAILURE >&2; exit 1" : "printf exactly-once >> effect.txt" }) } }] });
        if (fails) res.write(`data: ${JSON.stringify({ error: { message: "injected terminal stream failure", type: "server_error" } })}\n\n`);
        else send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: "Completed fixture." });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture listener missing");
    const model: Model<"openai-completions"> = {
      id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      contextWindow: 100_000, maxTokens: 1_024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const models = createModels();
    models.setProvider(createProvider({ id: "fixture", models: [model],
      auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key", source: "fixture" }), resolve: async () => ({ auth: { apiKey: "fixture-only" }, source: "fixture" }) } },
      api: { stream, streamSimple },
    }));
    const layout = buildRunledgerLayout(home, "posix");
    const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
    const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
    const sessionId = createRuntimeId("session", `hardening-${terminal}-${mode}`);
    store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "hardening"), repositoryId: createRuntimeId("repository", "hardening"), settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef() });
    let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
    let client: SessionInteractiveController | undefined;
    try {
      embedded = await createEmbeddedSessionRuntime({ sessionId, store, ownerStore, domain: {
        cwd: root, layout, models, settings: { autoTitle: false, provider: "fixture", model: "fixture", recording: { mode } },
        modelRequestRouter: createCatalogModelRouter(models),
        securitySources: [{ source: "cli", read: async () => ({ status: "available", text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }) }],
      } });
      client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
      await claimDriver(embedded, client);
      const events: AgentEvent[] = [];
      client.subscribe((event) => { events.push(event); });
      await client.resumeEvents();
      await client.prompt("Execute the fixture command once.");
      await client.waitForIdle();
      expect(requests.length).toBe(fails ? 1 : 2);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
      const committed = store.listAllAttemptReceipts(sessionId).filter((receipt) => receipt.outcome === "committed");
      if (fails) {
        expect(existsSync(join(root, "effect.txt"))).toBe(false);
        expect(committed).toHaveLength(0);
        expect(events.find((event) => event.type === "agent_end")).toMatchObject({ stopReason: "error" });
        expect(JSON.stringify(events)).toContain("not executed");
      } else {
        if (terminal === "overflow") {
          const wire = requests[1]?.messages as Record<string, unknown>[];
          const output = String(wire.find((message) => message.role === "tool")?.content);
          expect(output).toContain("TAIL_FAILURE");
          expect(output).toContain("omitted");
          expect(output.length).toBeLessThanOrEqual(32_000);
        } else expect(readFileSync(join(root, "effect.txt"), "utf8")).toBe("exactly-once");
        expect(committed.filter((receipt) => receipt.effectClass === "process_spawn")).toHaveLength(1);
        const wire = requests[1]?.messages as Record<string, unknown>[];
        expect(wire.some((message) => message.role === "tool" && message.tool_call_id === "call_hardening")).toBe(true);
      }
    } finally {
      client?.dispose();
      await embedded?.handle.close();
      await embedded?.runtime?.shutdownAfterLastAttachment("paused");
      db.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("sends recent complete dependency groups in chronological order to the HTTP adapter", async () => {
    let wire: Record<string, unknown> = {};
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      wire = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "context", object: "chat.completion.chunk", created: 1, model: "context", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing listener");
    const model: Model<"openai-completions"> = { id: "context", name: "Context", provider: "fixture", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"], contextWindow: 1600, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const history: AgentMessage[] = Array.from({ length: 14 }, (_, index): AgentMessage[] => [
      { role: "user", origin: "user", content: [{ type: "text", text: `task-${index}: ${"x".repeat(200)}` }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `done-${index}` }] },
    ]).flat();
    history.push(
      { role: "user", origin: "user", content: [{ type: "text", text: "current task: inspect only" }] },
      { role: "assistant", stopReason: "toolUse", content: ["a", "b"].map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })) },
      { role: "toolResult", content: ["a", "b"].map((id) => ({ type: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `result-${id}` }], isError: false })) },
      { role: "user", origin: "user", content: [{ type: "text", text: "correction: never modify" }] },
    );
    const raw = await defaultConvertToLlm(history);
    const original = structuredClone(raw);
    try {
      const assembled = assembleAgentModelContext({ model, context: { messages: raw, tools: [] }, sessionId: "wire-context", turn: 1 });
      const result = await stream(model, assembled.context, { apiKey: "fixture-only" }).result();
      expect(result.stopReason).toBe("stop");
      const text = JSON.stringify(wire.messages);
      expect(text).toContain("task-13:");
      expect(text).not.toContain("task-0:");
      expect(text).toContain("current task: inspect only");
      expect(text).toContain("correction: never modify");
      const messages = wire.messages as Record<string, unknown>[];
      const calls = messages.flatMap((message) => (message.tool_calls ?? []) as { id: string }[]).map((call) => call.id);
      const results = messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id);
      expect(calls).toHaveLength(2);
      expect(results).toEqual(calls);
      expect(text.indexOf("current task")).toBeLessThan(text.indexOf("result-a"));
      expect(text.indexOf("result-b")).toBeLessThan(text.indexOf("correction"));
      expect(raw).toEqual(original);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

});
