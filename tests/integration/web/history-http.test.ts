import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { startWebServer } from "../../../src/web/server.ts";
import type { WebProjectsPage, WebSnapshot } from "@runledger/collab-web/contracts";
import { webFixture } from "./fixture.ts";

async function login(origin: string, loginUrl: string) {
  const result = await fetch(`${origin}/auth/exchange`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(loginUrl).hash.slice(1) }) });
  expect(result.status).toBe(200);
  const cookie = result.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
  return cookie.split(";")[0];
}

describe("real loopback read-only Web HTTP", () => {
  it("requires a one-use same-origin bootstrap and serves only whitelisted reads", async () => {
    const fixture = webFixture(), session = fixture.create("http");
    session.message("user", [{ type: "text", text: "HTTP history" }]);
    const server = await startWebServer({ layout: fixture.layout, assetsDirectory: "packages/collab-web" });
    try {
      expect((await fetch(`${server.origin}/`)).status).toBe(200);
      expect((await fetch(`${server.origin}/app.css`)).status).toBe(200);
      expect((await fetch(`${server.origin}/api/v1/projects`)).status).toBe(401);
      expect((await fetch(`${server.origin}/auth/exchange`, { method: "POST", headers: { Origin: "https://evil.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(server.loginUrl).hash.slice(1) }) })).status).toBe(403);
      const cookie = await login(server.origin, server.loginUrl);
      expect((await fetch(`${server.origin}/auth/exchange`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(server.loginUrl).hash.slice(1) }) })).status).toBe(401);
      const read = (path: string, extra: RequestInit = {}) => fetch(`${server.origin}${path}`, { headers: { Cookie: cookie }, ...extra });
      const projects = await (await read("/api/v1/projects")).json() as WebProjectsPage;
      expect(projects.items).toHaveLength(1);
      const snapshot = await (await read(`/api/v1/sessions/${session.sessionId}/snapshot`)).json() as WebSnapshot;
      expect(snapshot.timeline.items[0].text).toBe("HTTP history");
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain("authToken"); expect(serialized).not.toContain(fixture.root);
      expect((await read("/api/v1/projects?pageSize=201")).status).toBe(400);
      expect((await read("/api/v1/projects?pageSize=1&pageSize=2")).status).toBe(400);
      expect((await read("/api/v1/projects?sourceWorkspaceLocator=/etc/passwd")).status).toBe(400);
      expect(await new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${server.origin}/api/v1/projects`, { headers: { Cookie: cookie, Host: "attacker.invalid" } }, (response) => { response.resume(); resolve(response.statusCode!); });
        request.on("error", reject); request.end();
      })).toBe(403);
      expect((await read("/api/v1/projects", { headers: { Cookie: cookie, Origin: "https://evil.invalid" } })).status).toBe(403);
      expect((await read("/api/v1/command", { method: "POST" })).status).toBe(405);
      expect((await read(`/api/v1/sessions/${session.sessionId}/domain_query?operation=abort`)).status).toBe(404);
      expect((await read(`/api/v1/sessions/${session.sessionId}/trajectory/${"b".repeat(64)}/detail?field=output`)).status).toBe(404);
      expect((await read("/state.db")).status).toBe(404);
      const other = await startWebServer({ layout: fixture.layout });
      try { expect((await fetch(`${other.origin}/api/v1/projects`, { headers: { Cookie: cookie } })).status).toBe(401); }
      finally { await other.close(); }
    } finally { await server.close(); fixture.close(); }
  });
});
