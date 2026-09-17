import { describe, expect, it } from "vitest";
import { SessionOwner } from "../../../src/runtime/session-owner/session-owner.ts";
import { SessionRuntimeServer } from "../../../src/runtime/session-server/runtime-server.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { freezeSessionProtocolManifest } from "../../../src/runtime/session-server/protocol.ts";
import { createTestController } from "../../runtime/session-server/harness.ts";
import { startWebServer } from "../../../src/web/server.ts";
import { webFixture } from "./fixture.ts";

describe("Web capability adapters over real Owner TCP", () => {
  it("uses only equipped readonly domains, maps allowlisted fields and shows offline explicitly", async () => {
    const fixture = webFixture(), sessionId = createRuntimeId("session", "capabilities");
    fixture.store.createSession({ sessionId, workspaceId: "workspace_web-fixture", repositoryId: "repository_web-fixture", harnessProfile: standardHarnessProfileRef(), settingsDigest: "a".repeat(64) });
    let fence: OwnerFence, processCount = 1;
    const called: string[] = [];
    const controller = createTestController({ sessionId, store: fixture.store, getFence: () => fence });
    const runtime = new SessionRuntimeServer({ sessionId, store: fixture.store, controller: { ...controller,
      protocolManifest: () => freezeSessionProtocolManifest({ protocolCapabilities: ["session.core", "session.process", "session.plan", "session.multi-agent"], operationManifest: [
        ...controller.protocolManifest!().operationManifest,
        { operation: "session.process.list", capability: "session.process", access: "read" }, { operation: "session.process.output", capability: "session.process", access: "read" },
        { operation: "plan.inspect", capability: "session.plan", access: "read" }, { operation: "agent.inspect", capability: "session.multi-agent", access: "read" },
      ] }),
      handleQuery: async (request) => {
        const operation = String(request.body.operation); called.push(operation);
        expect(request.body.sessionId).toBe(sessionId); expect(request.body.generation).toBe(fence.generation);
        const values: Record<string, unknown> = {
          "session.process.list": { items: Array.from({ length: processCount }, (_, index) => ({ executionId: `exec_private_${index}`, commandDisplay: { label: "printf sample", authority: "spawned" }, state: "exited", outputSize: 7, nativePath: "/private/path" })) },
          "session.process.output": { text: "sample\n", truncated: false, nextCursor: null },
          "agent.inspect": { nodes: [{ agentId: "agent_root", role: "root" }, { agentId: "agent_child", role: "child", state: "completed", usage: { modelTurns: 1, toolCalls: 1, activeDurationMs: 20 }, nativePath: "/private/child" }] },
          "plan.inspect": { state: { status: "awaiting_approval", revision: 2, completeness: "complete", updatedAt: "2026-09-16", plan: { artifactRef: "/private/plan" }, approval: { status: "pending", secret: "not-public" } } },
        };
        return { ok: true, value: values[operation] };
      },
    } });
    const owner = new SessionOwner({ store: fixture.store, ownerStore: new OwnerStore(fixture.db), transport: runtime });
    const claimed = await owner.open(sessionId); if (!claimed.ok || claimed.outcome !== "claimed") throw new Error("claim failed");
    fence = claimed.fence; owner.publish("running"); runtime.activate(fence, owner.currentAuthToken, "running");
    const server = await startWebServer({ layout: fixture.layout });
    try {
      const auth = await fetch(`${server.origin}/auth/exchange`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(server.loginUrl).hash.slice(1) }) });
      const headers = { Cookie: auth.headers.get("set-cookie")!.split(";")[0] };
      const read = async (name: string) => { const response = await fetch(`${server.origin}/api/v1/sessions/${sessionId}/${name}`, { headers }); expect(response.status).toBe(200); return response.json() as Promise<Record<string, unknown>>; };
      const process = await read("processes"); expect(process).toMatchObject({ available: true, items: [{ label: "printf sample", state: "exited", outputPreview: "sample\n" }] });
      const children = await read("children"); expect(children).toMatchObject({ available: true, items: [{ sessionId: null, state: "completed" }] });
      const plan = await read("plan"); expect(plan.summary).toContain("awaiting_approval"); expect(plan.summary).toContain("pending");
      expect(JSON.stringify([process, children, plan])).not.toContain("/private/");
      expect(JSON.stringify(plan)).not.toContain("not-public");
      expect(called).toEqual(["session.process.list", "session.process.output", "agent.inspect", "plan.inspect"]);
      processCount = 70; called.length = 0;
      let page = await read("processes?pageSize=200");
      expect(page.items).toHaveLength(32); expect(called.filter((operation) => operation === "session.process.output")).toHaveLength(32);
      const ids = new Set((page.items as { id: string }[]).map((item) => item.id));
      while (typeof page.after === "string") {
        page = await read(`processes?cursor=${page.after}`);
        for (const item of page.items as { id: string }[]) { expect(ids.has(item.id)).toBe(false); ids.add(item.id); }
      }
      expect(ids.size).toBe(70);
      await runtime.close();
      expect(await read("processes")).toEqual({ available: false, reason: "offline" });
      expect(fixture.store.replaySessionEvents(sessionId).some((event) => event.eventType === "driver.claimed")).toBe(false);
    } finally { await server.close(); owner.release("detached"); await runtime.close(); fixture.close(); }
  });
});
