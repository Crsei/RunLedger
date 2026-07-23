import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryChildRuntimeAuthorityStore,
  childRuntimeAuthorityRecordDigest,
  classifyChildRuntimeColdRecord,
  createClaimedChildRuntimeAuthorityRecord,
  createQuarantinedChildRuntimeAuthorityRecord,
  createReleasePendingChildRuntimeAuthorityRecord,
  createReleasedChildRuntimeAuthorityRecord,
  createResidentChildRuntimeAuthorityRecord,
  isChildRuntimeAuthorityRecord,
} from "../../../src/runtime/agents/child-runtime-authority.ts";
import type {
  AgentLaunchReceiptRef,
  AgentResidencyReceiptRef,
  AgentRuntimeReleaseReceiptRef,
  AgentRuntimeReleaseRequest,
} from "../../../src/runtime/agents/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
  createSessionEventStreamRef,
  type EventCursor,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { V3SessionWriterFenceReceipt } from "../../../src/storage/v3-session-manager.ts";
import { FileChildRuntimeAuthorityStore } from "../../../src/storage/child-runtime-authority-state.ts";

const NOW = "2026-07-23T01:00:00.000Z";
const RESIDENT_AT = "2026-07-23T01:00:01.000Z";
const RELEASE_PENDING_AT = "2026-07-23T01:00:02.000Z";
const RELEASED_AT = "2026-07-23T01:00:03.000Z";
const authorityId = createRuntimeId("authority", "child-runtime-sidecar");
const tenantId = createRuntimeId("tenant", "child-runtime-sidecar");
const principalId = createRuntimeId("principal", "child-runtime-sidecar");
const parentSessionId = createRuntimeId("session", "child-runtime-parent");
const parentAgentId = createRuntimeId("agent", "child-runtime-parent");
const parentRuntimeId = createRuntimeId("runtime", "child-runtime-parent");
const agentId = createRuntimeId("agent", "child-runtime-child");
const sessionId = createRuntimeId("session", "child-runtime-child");
const workspaceId = createRuntimeId("workspace", "child-runtime-child");
const runtimeInstanceId = createRuntimeId("runtime", "child-runtime-child");
const launchRequestId = createRuntimeId("command", "child-runtime-launch");
const launchRequestDigest = canonicalDigest("child runtime launch request");
const sessionFilePath = "/tmp/runledger-child-runtime-authority/session.jsonl";
const MAX_AUTHORITY_RECORD_BYTES = 8 * 1024 * 1024;
const roots: string[] = [];

function cursor(
  seed: string,
  targetSessionId = sessionId,
  sequence = 0,
): EventCursor {
  return {
    stream: createSessionEventStreamRef(
      { authorityId, tenantId },
      targetSessionId,
    ),
    sequence,
    eventId: createRuntimeId("event", `child-runtime-${seed}`),
    eventHash: canonicalDigest({ seed, sequence }),
  };
}

function writerFence(
  seed: string,
  targetSessionId = sessionId,
  targetRuntimeId = runtimeInstanceId,
): V3SessionWriterFenceReceipt {
  const body = {
    authorityId,
    tenantId,
    sessionId: targetSessionId,
    runtimeId: targetRuntimeId,
    stream: createSessionEventStreamRef(
      { authorityId, tenantId },
      targetSessionId,
    ),
    leaseId: createRuntimeId("lease", `child-runtime-${seed}`),
    writerEpoch: 1,
    fencingTokenDigest: canonicalDigest({ seed, fence: true }),
    acquiredAt: NOW,
    expiresAt: "2026-07-23T01:05:00.000Z",
  };
  const receiptDigest = canonicalDigest(body);
  return {
    ...body,
    receiptId: createRuntimeId("receipt", `child-runtime-fence-${seed}`),
    receiptDigest,
  };
}

function launchReceipt(): AgentLaunchReceiptRef {
  const body: Omit<AgentLaunchReceiptRef, "receiptDigest"> = {
    receiptId: createRuntimeId("receipt", "child-runtime-launch"),
    agentId,
    sessionId,
    launchRevision: 1,
    launchedAt: RESIDENT_AT,
  };
  return { ...body, receiptDigest: canonicalDigest(body) };
}

function residencyReceipt(
  state: AgentResidencyReceiptRef["state"] = "resident",
  revision = 1,
  observedAt = RESIDENT_AT,
): AgentResidencyReceiptRef {
  const body: Omit<AgentResidencyReceiptRef, "receiptDigest"> = {
    receiptId: createRuntimeId(
      "receipt",
      `child-runtime-residency-${state}-${revision}`,
    ),
    agentId,
    sessionId,
    runtimeInstanceId,
    state,
    revision,
    observedAt,
  };
  return { ...body, receiptDigest: canonicalDigest(body) };
}

function releaseRequest(seed = "one"): AgentRuntimeReleaseRequest {
  const body: Omit<AgentRuntimeReleaseRequest, "requestDigest"> = {
    requestId: createRuntimeId("command", `child-runtime-release-${seed}`),
    agentId,
    sessionId,
    launchReceipt: launchReceipt(),
    previousResidencyReceipt: residencyReceipt(),
    reason: "completed",
  };
  return { ...body, requestDigest: canonicalDigest(body) };
}

function releaseReceipt(seed = "one"): AgentRuntimeReleaseReceiptRef {
  const request = releaseRequest(seed);
  const body: Omit<AgentRuntimeReleaseReceiptRef, "receiptDigest"> = {
    receiptId: createRuntimeId("receipt", `child-runtime-release-${seed}`),
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    agentId,
    sessionId,
    runtimeInstanceId,
    launchReceiptId: request.launchReceipt.receiptId,
    launchRevision: request.launchReceipt.launchRevision,
    writerFenceReceiptId: writerFence("child").receiptId,
    writerFenceReceiptDigest: writerFence("child").receiptDigest,
    finalCursor: cursor(`release-${seed}`, sessionId, 3),
    residencyReceipt: residencyReceipt("nonresident", 2, RELEASED_AT),
    releasedAt: RELEASED_AT,
  };
  return { ...body, receiptDigest: canonicalDigest(body) };
}

function claimedRecord(seed = "one") {
  return createClaimedChildRuntimeAuthorityRecord({
    authorityId,
    tenantId,
    principalId,
    parentSessionId,
    parentAgentId,
    parentGraphRevision: 7,
    parentGraphCursor: cursor("parent-graph", parentSessionId, 12),
    parentNodeDigest: canonicalDigest("parent graph node"),
    agentId,
    sessionId,
    workspaceId,
    runtimeInstanceId,
    launchRequestId,
    launchRequestDigest:
      seed === "one" ? launchRequestDigest : canonicalDigest(`launch-${seed}`),
    delegationReceiptDigest: canonicalDigest("delegation receipt"),
    workspaceReceiptDigest: canonicalDigest("workspace receipt"),
    budgetReservationDigest: canonicalDigest("budget reservation"),
    artifactContractDigest: canonicalDigest("artifact contract"),
    ownerParentRuntimeId: parentRuntimeId,
    ownerParentWriterFence: writerFence(
      "parent",
      parentSessionId,
      parentRuntimeId,
    ),
    revision: 1,
    updatedAt: NOW,
  });
}

function residentRecord() {
  return createResidentChildRuntimeAuthorityRecord({
    previous: claimedRecord(),
    sessionFilePath,
    genesisCursor: cursor("genesis"),
    launchReceipt: launchReceipt(),
    residencyReceipt: residencyReceipt(),
    childWriterFence: writerFence("child"),
    updatedAt: RESIDENT_AT,
  });
}

function releasePendingRecord(seed = "one") {
  return createReleasePendingChildRuntimeAuthorityRecord({
    previous: residentRecord(),
    releaseRequest: releaseRequest(seed),
    preStopWriterFence: writerFence("child"),
    updatedAt: RELEASE_PENDING_AT,
  });
}

function writerLeaseReleasedEvidence() {
  const fence = writerFence("child");
  const body = {
    authorityId,
    tenantId,
    sessionId,
    runtimeInstanceId,
    leaseId: fence.leaseId,
    writerEpoch: fence.writerEpoch,
    fencingTokenDigest: fence.fencingTokenDigest,
    releasedAt: RELEASED_AT,
  };
  return { ...body, evidenceDigest: canonicalDigest(body) };
}

function releasedRecord(seed = "one") {
  return createReleasedChildRuntimeAuthorityRecord({
    previous: releasePendingRecord(seed),
    releaseReceipt: releaseReceipt(seed),
    writerLeaseReleasedEvidence: writerLeaseReleasedEvidence(),
    updatedAt: RELEASED_AT,
  });
}

function quarantinedRecord() {
  return createQuarantinedChildRuntimeAuthorityRecord({
    previous: claimedRecord(),
    reason: "cold_recovery_unsupported",
    evidenceDigest: canonicalDigest("operator review required"),
    updatedAt: RELEASE_PENDING_AT,
  });
}

async function temporaryRoot(seed: string): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), `runledger-child-runtime-${seed}-`),
  );
  roots.push(root);
  return root;
}

async function regularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function fileHandlePrototype(path: string): Promise<FileHandle> {
  const handle = await open(path, "r");
  try {
    return Object.getPrototypeOf(handle) as FileHandle;
  } finally {
    await handle.close();
  }
}

function requestedReadLength(args: readonly unknown[]): number {
  const first = args[0];
  if (ArrayBuffer.isView(first)) {
    if (typeof args[2] === "number") return args[2];
    const options = args[1];
    if (
      typeof options === "object" &&
      options !== null &&
      "length" in options &&
      typeof options.length === "number"
    ) {
      return options.length;
    }
    return first.byteLength;
  }
  if (
    typeof first === "object" &&
    first !== null &&
    "buffer" in first &&
    ArrayBuffer.isView(first.buffer)
  ) {
    return "length" in first && typeof first.length === "number"
      ? first.length
      : first.buffer.byteLength;
  }
  return 0;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("child runtime authority sidecar store", () => {
  it("validates every self-digested state and cold-replays only complete released evidence", () => {
    const records = [
      claimedRecord(),
      residentRecord(),
      releasePendingRecord(),
      releasedRecord(),
      quarantinedRecord(),
    ] as const;
    expect(records.map((record) => record.state)).toEqual([
      "claimed",
      "resident",
      "release_pending",
      "released",
      "quarantined",
    ]);
    for (const record of records) {
      const { recordDigest, ...body } = record;
      expect(recordDigest).toBe(childRuntimeAuthorityRecordDigest(body));
      expect(isChildRuntimeAuthorityRecord(record)).toBe(true);
    }
    expect(residentRecord()).toMatchObject({
      sessionFilePath,
      genesisCursor: { sequence: 0 },
      launchReceipt: { agentId, sessionId },
      residencyReceipt: { runtimeInstanceId, state: "resident" },
      childWriterFence: { runtimeId: runtimeInstanceId },
    });
    expect(releasePendingRecord()).toMatchObject({
      releaseRequest: {
        agentId,
        sessionId,
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      preStopWriterFence: { runtimeId: runtimeInstanceId },
    });
    expect(releasedRecord()).toMatchObject({
      releaseReceipt: {
        agentId,
        sessionId,
        residencyReceipt: { state: "nonresident" },
      },
      writerLeaseReleasedEvidence: {
        runtimeInstanceId,
        releasedAt: RELEASED_AT,
        evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });

    expect(classifyChildRuntimeColdRecord(releasedRecord())).toEqual({
      kind: "replay_released",
      receipt: releasedRecord().releaseReceipt,
    });
    for (const record of [
      claimedRecord(),
      residentRecord(),
      releasePendingRecord(),
      quarantinedRecord(),
    ]) {
      expect(classifyChildRuntimeColdRecord(record)).toEqual({
        kind: "quarantine",
        observedState: record.state,
        takeoverAllowed: false,
      });
    }
    expect(
      isChildRuntimeAuthorityRecord({
        ...releasedRecord(),
        runtimeInstanceId: createRuntimeId("runtime", "foreign"),
      }),
    ).toBe(false);
    expect(
      isChildRuntimeAuthorityRecord({
        ...releasedRecord(),
        releaseReceipt: {
          ...releasedRecord().releaseReceipt,
          receiptDigest: "0".repeat(64),
        },
      }),
    ).toBe(false);
  });

  it("rejects released evidence assembled from different child writer fences", () => {
    const released = releasedRecord();
    const alternateFence = writerFence("alternate-child");
    const { evidenceDigest: _evidenceDigest, ...releasedEvidenceBody } =
      released.writerLeaseReleasedEvidence;
    const alternateEvidenceBody = {
      ...releasedEvidenceBody,
      leaseId: alternateFence.leaseId,
      writerEpoch: alternateFence.writerEpoch,
      fencingTokenDigest: alternateFence.fencingTokenDigest,
    };
    const alternateEvidence = {
      ...alternateEvidenceBody,
      evidenceDigest: canonicalDigest(alternateEvidenceBody),
    };
    const { recordDigest: _recordDigest, ...releasedBody } = released;
    const forgedBody = {
      ...releasedBody,
      childWriterFence: alternateFence,
      writerLeaseReleasedEvidence: alternateEvidence,
    };
    const forged = {
      ...forgedBody,
      recordDigest: childRuntimeAuthorityRecordDigest(forgedBody),
    };

    expect(forged.preStopWriterFence.receiptDigest).not.toBe(
      forged.childWriterFence.receiptDigest,
    );
    expect(isChildRuntimeAuthorityRecord(forged)).toBe(false);
  });

  it("rejects released residency evidence observed at a different time", () => {
    const released = releasedRecord();
    const { receiptDigest: _residencyDigest, ...residencyBody } =
      released.releaseReceipt.residencyReceipt;
    const changedResidencyBody = {
      ...residencyBody,
      observedAt: "2026-07-23T01:00:02.500Z",
    };
    const changedResidency = {
      ...changedResidencyBody,
      receiptDigest: canonicalDigest(changedResidencyBody),
    };
    const { receiptDigest: _releaseDigest, ...releaseReceiptBody } =
      released.releaseReceipt;
    const changedReleaseReceiptBody = {
      ...releaseReceiptBody,
      residencyReceipt: changedResidency,
    };
    const changedReleaseReceipt = {
      ...changedReleaseReceiptBody,
      receiptDigest: canonicalDigest(changedReleaseReceiptBody),
    };
    const { recordDigest: _recordDigest, ...releasedBody } = released;
    const forgedBody = {
      ...releasedBody,
      releaseReceipt: changedReleaseReceipt,
    };
    const forged = {
      ...forgedBody,
      recordDigest: childRuntimeAuthorityRecordDigest(forgedBody),
    };

    expect(forged.releaseReceipt.residencyReceipt.observedAt).not.toBe(
      forged.releaseReceipt.releasedAt,
    );
    expect(isChildRuntimeAuthorityRecord(forged)).toBe(false);
  });

  it("rejects foreign canonical stream IDs and unknown sensitive stream fields", () => {
    const claimed = claimedRecord();
    const { recordDigest: _foreignDigest, ...claimedBody } = claimed;
    const foreignStreamBody = {
      ...claimedBody,
      parentGraphCursor: {
        ...claimed.parentGraphCursor,
        stream: createSessionEventStreamRef(
          {
            authorityId: createRuntimeId("authority", "foreign-stream"),
            tenantId,
          },
          parentSessionId,
        ),
      },
    };
    const foreignStreamRecord = {
      ...foreignStreamBody,
      recordDigest: childRuntimeAuthorityRecordDigest(foreignStreamBody),
    };

    const fence = claimed.ownerParentWriterFence;
    const {
      receiptId,
      receiptDigest: _receiptDigest,
      ...fenceDigestBody
    } = fence;
    const extendedFenceBody = {
      ...fenceDigestBody,
      stream: {
        ...fence.stream,
        fencingToken: "must-not-be-accepted",
      },
    };
    const extendedFence = {
      ...extendedFenceBody,
      receiptId,
      receiptDigest: canonicalDigest(extendedFenceBody),
    };
    const { recordDigest: _extendedDigest, ...extendedClaimedBody } = claimed;
    const extendedStreamBody = {
      ...extendedClaimedBody,
      ownerParentWriterFence: extendedFence,
    };
    const extendedStreamRecord = {
      ...extendedStreamBody,
      recordDigest: childRuntimeAuthorityRecordDigest(extendedStreamBody),
    };

    expect(isChildRuntimeAuthorityRecord(foreignStreamRecord)).toBe(false);
    expect(isChildRuntimeAuthorityRecord(extendedStreamRecord)).toBe(false);
  });

  it("begins only an exact claimed identity and rejects a changed request digest", async () => {
    const store = new MemoryChildRuntimeAuthorityStore();
    const claimed = claimedRecord();
    expect(await store.begin(claimed)).toBe("applied");
    expect(await store.begin(structuredClone(claimed))).toBe("replay");
    expect(await store.read(agentId)).toEqual(claimed);
    expect(await store.begin(claimedRecord("changed-digest"))).toBe("conflict");
    await expect(store.begin(residentRecord())).rejects.toThrow(
      /claimed|begin|initial/u,
    );
    expect(await store.read(agentId)).toEqual(claimed);
  });

  it("uses revision plus record digest CAS and forbids skipped or terminal transitions", async () => {
    const store = new MemoryChildRuntimeAuthorityStore();
    const claimed = claimedRecord();
    const resident = residentRecord();
    const pending = releasePendingRecord();
    const released = releasedRecord();
    await store.begin(claimed);

    await expect(
      store.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        pending,
      ),
    ).rejects.toThrow(/transition|revision|previous/u);
    expect(
      await store.compareAndSwap(agentId, 0, claimed.recordDigest, resident),
    ).toBe("conflict");
    expect(
      await store.compareAndSwap(agentId, 1, "f".repeat(64), resident),
    ).toBe("conflict");
    expect(
      await store.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        resident,
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwap(
        agentId,
        resident.revision,
        resident.recordDigest,
        pending,
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwap(
        agentId,
        resident.revision,
        resident.recordDigest,
        pending,
      ),
    ).toBe("replay");
    expect(
      await store.compareAndSwap(
        agentId,
        pending.revision,
        pending.recordDigest,
        released,
      ),
    ).toBe("applied");

    const quarantineAfterPending = createQuarantinedChildRuntimeAuthorityRecord(
      {
        previous: pending,
        reason: "cold_recovery_unsupported",
        evidenceDigest: canonicalDigest("late quarantine"),
        updatedAt: "2026-07-23T01:00:04.000Z",
      },
    );
    const { recordDigest: _quarantineDigest, ...quarantineBody } =
      quarantineAfterPending;
    const terminalAdvanceBody = {
      ...quarantineBody,
      revision: released.revision + 1,
      previousRecordDigest: released.recordDigest,
    };
    const terminalAdvance = {
      ...terminalAdvanceBody,
      recordDigest: childRuntimeAuthorityRecordDigest(terminalAdvanceBody),
    };
    expect(isChildRuntimeAuthorityRecord(terminalAdvance)).toBe(true);
    await expect(
      store.compareAndSwap(
        agentId,
        released.revision,
        released.recordDigest,
        terminalAdvance,
      ),
    ).rejects.toThrow(/terminal|released|transition/u);

    const quarantinedStore = new MemoryChildRuntimeAuthorityStore();
    const quarantined = quarantinedRecord();
    await quarantinedStore.begin(claimed);
    expect(
      await quarantinedStore.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        quarantined,
      ),
    ).toBe("applied");
    await expect(
      quarantinedStore.compareAndSwap(
        agentId,
        quarantined.revision,
        quarantined.recordDigest,
        terminalAdvance,
      ),
    ).rejects.toThrow(/terminal|quarantined|transition/u);
  });

  it("checks the expected CAS tuple before replaying an identical next record", async () => {
    const parent = await temporaryRoot("stale-cas");
    const stores = [
      new MemoryChildRuntimeAuthorityStore(),
      new FileChildRuntimeAuthorityStore(join(parent, "state")),
    ] as const;
    const claimed = claimedRecord();
    const resident = residentRecord();
    const results: string[] = [];

    for (const store of stores) {
      expect(await store.begin(claimed)).toBe("applied");
      expect(
        await store.compareAndSwap(
          agentId,
          claimed.revision,
          claimed.recordDigest,
          resident,
        ),
      ).toBe("applied");
      expect(
        await store.compareAndSwap(
          agentId,
          claimed.revision,
          claimed.recordDigest,
          structuredClone(resident),
        ),
      ).toBe("replay");
      results.push(
        await store.compareAndSwap(
          agentId,
          resident.revision + 1,
          "f".repeat(64),
          structuredClone(resident),
        ),
      );
    }

    expect(results).toEqual(["conflict", "conflict"]);
  });

  it("recovers only one interrupted hard-link publish for the exact final record", async () => {
    const parent = await temporaryRoot("publish-crash");
    const root = join(parent, "state");
    const claimed = claimedRecord();
    expect(await new FileChildRuntimeAuthorityStore(root).begin(claimed)).toBe(
      "applied",
    );
    const files = await regularFiles(root);
    expect(files).toHaveLength(1);
    const finalPath = files[0]!;
    const interruptedPublish = join(root, `.${randomUUID()}.tmp`);
    await link(finalPath, interruptedPublish);
    expect((await lstat(finalPath)).nlink).toBe(2);

    expect(
      await new FileChildRuntimeAuthorityStore(root).read(agentId),
    ).toEqual(claimed);
    expect((await lstat(finalPath)).nlink).toBe(1);
    await expect(lstat(interruptedPublish)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const firstAmbiguousPublish = join(root, `.${randomUUID()}.tmp`);
    const secondAmbiguousPublish = join(root, `.${randomUUID()}.tmp`);
    await link(finalPath, firstAmbiguousPublish);
    await link(finalPath, secondAmbiguousPublish);
    expect((await lstat(finalPath)).nlink).toBe(3);
    await expect(
      new FileChildRuntimeAuthorityStore(root).read(agentId),
    ).rejects.toThrow(/ambiguous|identity|link|publish|unsafe/u);
    expect((await lstat(finalPath)).nlink).toBe(3);
  });

  it("does not publish a final record when the initial file write fails", async () => {
    const parent = await temporaryRoot("failed-begin");
    const root = join(parent, "state");
    await mkdir(root, { mode: 0o700 });
    const probe = join(root, "probe");
    await writeFile(probe, "probe", { mode: 0o600 });
    const prototype = await fileHandlePrototype(probe);
    await rm(probe);
    const write = vi
      .spyOn(prototype, "writeFile")
      .mockRejectedValueOnce(new Error("injected authority write failure"));

    await expect(
      new FileChildRuntimeAuthorityStore(root).begin(claimedRecord()),
    ).rejects.toThrow(/injected authority write failure/u);
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      (await readdir(root)).filter(
        (name) => name.endsWith(".json") || name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("rejects an oversized opened record before reading its contents", async () => {
    const parent = await temporaryRoot("oversized");
    const root = join(parent, "state");
    const store = new FileChildRuntimeAuthorityStore(root);
    expect(await store.begin(claimedRecord())).toBe("applied");
    const files = await regularFiles(root);
    expect(files).toHaveLength(1);
    await writeFile(files[0]!, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20), {
      mode: 0o600,
    });
    const prototype = await fileHandlePrototype(files[0]!);
    const read = vi.spyOn(prototype, "readFile");

    await expect(store.read(agentId)).rejects.toThrow(/byte|bound|large|size/u);
    expect(read).not.toHaveBeenCalled();
  });

  it("bounds reads when an opened record grows concurrently", async () => {
    const parent = await temporaryRoot("growing-record");
    const root = join(parent, "state");
    const store = new FileChildRuntimeAuthorityStore(root);
    const claimed = claimedRecord();
    expect(await store.begin(claimed)).toBe("applied");
    const files = await regularFiles(root);
    expect(files).toHaveLength(1);
    const finalPath = files[0]!;
    const prototype = await fileHandlePrototype(finalPath);
    const originalRead = prototype.read as unknown as (
      this: FileHandle,
      ...args: unknown[]
    ) => Promise<unknown>;
    const requestedLengths: number[] = [];
    let grew = false;
    const read = vi.spyOn(prototype, "read");
    const boundedRead = async function (
      this: FileHandle,
      ...args: unknown[]
    ): Promise<unknown> {
      requestedLengths.push(requestedReadLength(args));
      if (!grew) {
        grew = true;
        await appendFile(
          finalPath,
          Buffer.alloc(MAX_AUTHORITY_RECORD_BYTES, 0x20),
        );
      }
      return Reflect.apply(originalRead, this, args);
    };
    read.mockImplementation(boundedRead as unknown as typeof prototype.read);
    const unboundedRead = vi.spyOn(prototype, "readFile");

    let rejection: unknown;
    try {
      await store.read(agentId);
    } catch (error) {
      rejection = error;
    }

    expect.soft(rejection).toBeInstanceOf(Error);
    expect.soft(String(rejection)).toMatch(/bound|byte|changed|large|size/u);
    expect.soft(grew).toBe(true);
    expect.soft(unboundedRead).not.toHaveBeenCalled();
    expect.soft(requestedLengths.length).toBeGreaterThan(0);
    expect
      .soft(requestedLengths.reduce((sum, length) => sum + length, 0))
      .toBeLessThanOrEqual(MAX_AUTHORITY_RECORD_BYTES + 1);
  });

  it("rejects an opened record handle whose link count is unsafe", async () => {
    const parent = await temporaryRoot("opened-handle");
    const root = join(parent, "state");
    const store = new FileChildRuntimeAuthorityStore(root);
    const claimed = claimedRecord();
    expect(await store.begin(claimed)).toBe("applied");
    const files = await regularFiles(root);
    expect(files).toHaveLength(1);
    const prototype = await fileHandlePrototype(files[0]!);
    const unsafeStats = await stat(files[0]!);
    Object.defineProperty(unsafeStats, "nlink", { value: 2 });
    const openedStat = vi
      .spyOn(prototype, "stat")
      .mockResolvedValueOnce(unsafeStats);

    await expect(store.read(agentId)).rejects.toThrow(/identity|link|unsafe/u);
    expect(openedStat).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed UTF-8 instead of accepting replacement decoding", async () => {
    const parent = await temporaryRoot("malformed-utf8");
    const root = join(parent, "state");
    const store = new FileChildRuntimeAuthorityStore(root);
    const claimed = claimedRecord();
    const quarantined = createQuarantinedChildRuntimeAuthorityRecord({
      previous: claimed,
      reason: "\uFFFD",
      evidenceDigest: canonicalDigest("malformed UTF-8 evidence"),
      updatedAt: RELEASE_PENDING_AT,
    });
    expect(await store.begin(claimed)).toBe("applied");
    expect(
      await store.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        quarantined,
      ),
    ).toBe("applied");
    const files = await regularFiles(root);
    expect(files).toHaveLength(1);
    const original = await readFile(files[0]!);
    const replacement = Buffer.from("\uFFFD", "utf8");
    const marker = original.indexOf(replacement);
    expect(marker).toBeGreaterThanOrEqual(0);
    const malformed = Buffer.concat([
      original.subarray(0, marker),
      Buffer.from([0xff]),
      original.subarray(marker + replacement.length),
    ]);
    expect(malformed.byteLength).toBe(original.byteLength - 2);
    await writeFile(files[0]!, malformed, { mode: 0o600 });

    await expect(
      new FileChildRuntimeAuthorityStore(root).read(agentId),
    ).rejects.toThrow(/corrupt|encoding|invalid|malformed|utf/iu);
  });

  it("reopens exact released evidence privately and fails closed on corruption, symlinks, and broad permissions", async () => {
    const parent = await temporaryRoot("file");
    const root = join(parent, "state");
    await mkdir(root, { mode: 0o700 });
    const claimed = claimedRecord();
    const resident = residentRecord();
    const pending = releasePendingRecord();
    const released = releasedRecord();
    const first = new FileChildRuntimeAuthorityStore(root);
    expect(await first.begin(claimed)).toBe("applied");
    expect(
      await first.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        resident,
      ),
    ).toBe("applied");
    expect(
      await first.compareAndSwap(
        agentId,
        resident.revision,
        resident.recordDigest,
        pending,
      ),
    ).toBe("applied");
    expect(
      await first.compareAndSwap(
        agentId,
        pending.revision,
        pending.recordDigest,
        released,
      ),
    ).toBe("applied");
    expect(
      await new FileChildRuntimeAuthorityStore(root).read(agentId),
    ).toEqual(released);

    const files = await regularFiles(root);
    expect(files).toHaveLength(1);
    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(files[0]!)).mode & 0o777).toBe(0o600);
    }
    const original = await readFile(files[0]!, "utf8");
    const corrupted = original.replace(released.recordDigest, "0".repeat(64));
    expect(corrupted).not.toBe(original);
    await writeFile(files[0]!, corrupted, { mode: 0o600 });
    await expect(
      new FileChildRuntimeAuthorityStore(root).read(agentId),
    ).rejects.toThrow(/corrupt|digest|invalid/u);
    expect(await readFile(files[0]!, "utf8")).toBe(corrupted);

    if (process.platform !== "win32") {
      await writeFile(files[0]!, original, { mode: 0o600 });
      await chmod(files[0]!, 0o644);
      await expect(
        new FileChildRuntimeAuthorityStore(root).read(agentId),
      ).rejects.toThrow(/private|permission|unsafe/u);
      expect((await stat(files[0]!)).mode & 0o077).not.toBe(0);
    }

    const target = join(parent, "target");
    const alias = join(parent, "alias");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, alias);
    await expect(
      new FileChildRuntimeAuthorityStore(alias).begin(claimed),
    ).rejects.toThrow();
    expect(await readdir(target)).toEqual([]);

    if (process.platform !== "win32") {
      const broad = join(parent, "broad");
      await mkdir(broad, { mode: 0o700 });
      await chmod(broad, 0o755);
      await expect(
        new FileChildRuntimeAuthorityStore(broad).begin(claimed),
      ).rejects.toThrow(/private|permission|unsafe/u);
      expect((await lstat(broad)).mode & 0o077).not.toBe(0);
      expect(await readdir(broad)).toEqual([]);
    }
  });
});
