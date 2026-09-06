// 仅向调用方指定的全新隔离目录写入合成 UI 历史，不调用 provider。
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openSessionDatabase } from '../../../dist/storage/session-store/database.js';
import { installSessionStoreSchema } from '../../../dist/storage/session-store/schema.js';
import { SessionStore } from '../../../dist/storage/session-store/session-store.js';
import { OwnerStore } from '../../../dist/storage/session-store/owner-store.js';
import { SessionOwner } from '../../../dist/runtime/session-owner/session-owner.js';
import { createTcpOwnerTransport } from '../../../dist/runtime/session-server/owner-probe.js';
import { SqliteLedgerSink } from '../../../dist/runtime/session-runtime/sqlite-ledger.js';
import { standardHarnessProfileRef } from '../../../dist/runtime/harness-profiles/index.js';
import { createRuntimeId } from '../../../dist/runtime/protocol/ids.js';
import { resolveSessionWorkspaceIdentity } from '../../../dist/workspace/session-identity.js';

if (!process.argv[2]) throw new Error("usage: seed.mjs <isolated-root>");
const root = resolve(process.argv[2]);
// 不接受已有 home，防止 fixture 误写真实用户 authority。
mkdirSync(`${root}/home`, { mode: 0o700 });
mkdirSync(`${root}/workspace`, { mode: 0o700 });
const db = openSessionDatabase(`${root}/home/state.db`);
installSessionStoreSchema(db);
const store = new SessionStore(db);
const identity = await resolveSessionWorkspaceIdentity(`${root}/workspace`);
const sessionId = createRuntimeId('session', 'ui_theme_fixture');
store.createSession({ sessionId, ...identity, harnessProfile: standardHarnessProfileRef(), settingsDigest: 'd'.repeat(64) });
const transport = createTcpOwnerTransport();
const owner = new SessionOwner({ store, ownerStore: new OwnerStore(db), transport });
try {
  const result = await owner.open(sessionId);
  if (!result.ok || result.outcome !== 'claimed') throw new Error('fixture owner claim failed');
  const sink = new SqliteLedgerSink({ store, fence: () => result.fence });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'UI_THEME_USER fixture only' }], timestamp: Date.now() },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'UI_THEME_THOUGHT reasoning fixture' }, { type: 'text', text: 'UI_THEME_ANSWER final fixture' }], api: 'openai-responses', provider: 'openai', model: 'gpt-5', usage, stopReason: 'stop', timestamp: Date.now() },
  ];
  messages.forEach((message, index) => sink.append({ id: `theme-${index}`, sessionId, parentId: sessionId, timestamp: Date.now(), type: 'message', payload: { role: message.role, message } }));
  owner.release('paused');
  process.stdout.write(`${sessionId}\n`);
} finally {
  owner.stopHeartbeat();
  await transport.closeCandidate();
  db.close();
}
