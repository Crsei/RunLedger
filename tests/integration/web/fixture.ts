import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";

export function webFixture() {
  const root = mkdtempSync(join(tmpdir(), "runledger-web-test-")), layout = buildRunledgerLayout(root, "posix");
  const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
  const store = new SessionStore(db), owners = new OwnerStore(db);
  const create = (name: string) => {
    const sessionId = createRuntimeId("session", name);
    store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "web-fixture"), repositoryId: createRuntimeId("repository", "web-fixture"), harnessProfile: standardHarnessProfileRef(), settingsDigest: "a".repeat(64) });
    const owner = owners.tryClaim({ mode: "fresh", sessionId }, { runtimeId: createRuntimeId("runtime", name), endpoint: { host: "127.0.0.1", port: 12345 }, authTokenHex: "a".repeat(64), ownerStartedAtMs: Date.now() });
    if (!owner.ok || owner.outcome !== "claimed") throw new Error("claim failed");
    let sequence = 0;
    const append = (type: string, payload: Record<string, unknown>) => store.appendEvent(owner.fence, { eventId: createRuntimeId("event", `${name}-${++sequence}`), eventType: type, ownerGeneration: 1, payloadJson: JSON.stringify(payload), createdAtMs: Date.now(), expectedPreviousEventHash: store.latestEventHead(sessionId).hash });
    const message = (role: string, content: unknown[]) => append("ledger.message", { payload: { message: { role, content } } });
    return { sessionId, fence: owner.fence, append, message };
  };
  return { root, layout, db, store, create, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
