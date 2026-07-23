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
  createChildRuntimeActivationEvidence,
  createClaimedChildRuntimeAuthorityRecord,
  createCreatingChildRuntimeAuthorityRecord,
  createProvisionalChildRuntimeAuthorityRecord,
  createQuarantinedChildRuntimeAuthorityRecord,
  createReleasePendingChildRuntimeAuthorityRecord,
  createReleasedChildRuntimeAuthorityRecord,
  createResidentChildRuntimeAuthorityRecord,
  createResumedChildRuntimeAuthorityRecord,
  isChildRuntimeAuthorityRecord,
  validateChildRuntimeAuthorityTransition,
} from "../../../src/runtime/agents/child-runtime-authority.ts";
import type {
  ChildRuntimeActivationEvidence,
  CreatingChildRuntimeAuthorityRecord,
  ProvisionalChildRuntimeAuthorityRecord,
  ResidentChildRuntimeAuthorityRecord,
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
const CREATE_STARTED_AT = "2026-07-23T01:00:00.250Z";
const PROVISIONAL_AT = "2026-07-23T01:00:00.750Z";
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
  expiresAt = "2026-07-23T01:05:00.000Z",
  acquiredAt = NOW,
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
    acquiredAt,
    expiresAt,
  };
  const receiptDigest = canonicalDigest(body);
  return {
    ...body,
    receiptId: createRuntimeId("receipt", `child-runtime-fence-${seed}`),
    receiptDigest,
  };
}

function renewedWriterFence(
  previous: V3SessionWriterFenceReceipt,
  expiresAt: string,
): V3SessionWriterFenceReceipt {
  const {
    receiptId: _receiptId,
    receiptDigest: _receiptDigest,
    ...previousBody
  } = previous;
  const body = { ...previousBody, expiresAt };
  return {
    ...body,
    receiptId: createRuntimeId(
      "receipt",
      `renewed-${canonicalDigest(body).slice(0, 32)}`,
    ),
    receiptDigest: canonicalDigest(body),
  };
}

function launchReceipt(
  revision = 1,
  launchedAt = RESIDENT_AT,
): AgentLaunchReceiptRef {
  const body: Omit<AgentLaunchReceiptRef, "receiptDigest"> = {
    receiptId: createRuntimeId("receipt", `child-runtime-launch-${revision}`),
    agentId,
    sessionId,
    launchRevision: revision,
    launchedAt,
  };
  return { ...body, receiptDigest: canonicalDigest(body) };
}

function activationEvidence(
  activationType: ChildRuntimeActivationEvidence["activationType"] = "launch",
  seed = "one",
  parentGraphRevision = 7,
  parentGraphSequence = 12,
  parentFence = writerFence("parent", parentSessionId, parentRuntimeId),
): ChildRuntimeActivationEvidence {
  const requestId =
    activationType === "launch"
      ? launchRequestId
      : createRuntimeId("command", `child-runtime-resume-${seed}`);
  const requestDigest =
    activationType === "launch" && seed === "one"
      ? launchRequestDigest
      : canonicalDigest(`${activationType}-${seed}`);
  return createChildRuntimeActivationEvidence({
    activationType,
    requestId,
    requestDigest,
    parentGraphRevision,
    parentGraphCursor: cursor(
      `parent-graph-${activationType}-${seed}`,
      parentSessionId,
      parentGraphSequence,
    ),
    parentNodeDigest: canonicalDigest({
      activationType,
      seed,
      parentGraphRevision,
    }),
    delegationReceiptDigest: canonicalDigest(`delegation-${seed}`),
    workspaceReceiptDigest: canonicalDigest(`workspace-${seed}`),
    budgetReservationDigest: canonicalDigest(`budget-${seed}`),
    ownerParentWriterFence: parentFence,
  });
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
  const launchActivation = activationEvidence("launch", seed);
  return createClaimedChildRuntimeAuthorityRecord({
    authorityId,
    tenantId,
    principalId,
    parentSessionId,
    parentAgentId,
    agentId,
    sessionId,
    workspaceId,
    runtimeInstanceId,
    sessionFilePath,
    launchRequestId,
    launchRequestDigest:
      seed === "one" ? launchRequestDigest : canonicalDigest(`launch-${seed}`),
    artifactContractDigest: canonicalDigest("artifact contract"),
    ownerParentRuntimeId: parentRuntimeId,
    initialActivationEvidence: launchActivation,
    activationEvidence: launchActivation,
    revision: 1,
    updatedAt: NOW,
  });
}

function creatingRecord(previous = claimedRecord()) {
  return createCreatingChildRuntimeAuthorityRecord({
    previous,
    createStartedAt: CREATE_STARTED_AT,
    updatedAt: CREATE_STARTED_AT,
  });
}

function provisionalRecord(
  previous: CreatingChildRuntimeAuthorityRecord = creatingRecord(),
  childWriterFence = writerFence("child"),
) {
  return createProvisionalChildRuntimeAuthorityRecord({
    previous,
    launchReceipt: launchReceipt(),
    residencyReceipt: residencyReceipt(),
    childWriterFence,
    updatedAt: PROVISIONAL_AT,
  });
}

function residentRecord(
  claimed = claimedRecord(),
  childWriterFence = writerFence("child"),
) {
  const provisional = provisionalRecord(creatingRecord(claimed), childWriterFence);
  return createResidentChildRuntimeAuthorityRecord({
    previous: provisional,
    genesisCursor: cursor("genesis"),
    updatedAt: RESIDENT_AT,
  });
}

function resumedRecord(
  previous: ResidentChildRuntimeAuthorityRecord = residentRecord(),
  seed = "one",
  parentGraphRevision = 8,
  parentGraphSequence = 13,
  childWriterFence = renewedWriterFence(
    previous.childWriterFence,
    "2026-07-23T01:10:00.000Z",
  ),
) {
  return createResumedChildRuntimeAuthorityRecord({
    previous,
    activationEvidence: activationEvidence(
      "resume",
      seed,
      parentGraphRevision,
      parentGraphSequence,
      renewedWriterFence(
        previous.activationEvidence.ownerParentWriterFence,
        "2026-07-23T01:10:00.000Z",
      ),
    ),
    launchReceipt: launchReceipt(
      previous.launchReceipt.launchRevision + 1,
      RELEASE_PENDING_AT,
    ),
    residencyReceipt: residencyReceipt(
      "resident",
      previous.residencyReceipt.revision + 1,
      RELEASE_PENDING_AT,
    ),
    childWriterFence,
    updatedAt: RELEASE_PENDING_AT,
  });
}

function releasePendingRecord(
  seed = "one",
  previous: ResidentChildRuntimeAuthorityRecord = residentRecord(),
  preStopWriterFence = previous.childWriterFence,
) {
  return createReleasePendingChildRuntimeAuthorityRecord({
    previous,
    releaseRequest: releaseRequest(seed),
    preStopWriterFence,
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

function releasedRecord(seed = "one", previous = releasePendingRecord(seed)) {
  return createReleasedChildRuntimeAuthorityRecord({
    previous,
    releaseReceipt: releaseReceipt(seed),
    writerLeaseReleasedEvidence: writerLeaseReleasedEvidence(),
    updatedAt: RELEASED_AT,
  });
}

function quarantinedRecord(previous = claimedRecord()) {
  return createQuarantinedChildRuntimeAuthorityRecord({
    previous,
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
      creatingRecord(),
      provisionalRecord(),
      residentRecord(),
      releasePendingRecord(),
      releasedRecord(),
      quarantinedRecord(),
    ] as const;
    expect(records.map((record) => record.state)).toEqual([
      "claimed",
      "creating",
      "provisional",
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
    expect(claimedRecord()).toMatchObject({
      sessionFilePath,
    });
    expect(creatingRecord()).toMatchObject({
      sessionFilePath,
      createStartedAt: CREATE_STARTED_AT,
    });
    expect(provisionalRecord()).toMatchObject({
      sessionFilePath,
      createStartedAt: CREATE_STARTED_AT,
      launchReceipt: { agentId, sessionId },
      residencyReceipt: { runtimeInstanceId, state: "resident" },
      childWriterFence: { runtimeId: runtimeInstanceId },
    });
    expect(residentRecord()).toMatchObject({
      sessionFilePath,
      createStartedAt: CREATE_STARTED_AT,
      genesisCursor: { sequence: 0 },
      initialActivationEvidence: {
        activationType: "launch",
        requestId: launchRequestId,
      },
      activationEvidence: {
        activationType: "launch",
        requestId: launchRequestId,
      },
    });
    expect(claimedRecord().claimAttemptId).toMatch(
      /^command_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(claimedRecord().claimAttemptId).not.toBe(launchRequestId);
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
      creatingRecord(),
      provisionalRecord(),
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

  it("seals activation evidence and rejects unknown, forged, or foreign authority fields", () => {
    const claimed = claimedRecord();
    const { recordDigest: _recordDigest, ...claimedBody } = claimed;
    const { evidenceDigest: _evidenceDigest, ...activationBody } =
      claimed.activationEvidence;

    const unknownActivationBody = {
      ...activationBody,
      rawWriterToken: "must-not-persist",
    };
    const unknownActivation = {
      ...unknownActivationBody,
      evidenceDigest: canonicalDigest(unknownActivationBody),
    };
    const unknownBody = {
      ...claimedBody,
      initialActivationEvidence: unknownActivation,
      activationEvidence: unknownActivation,
    };
    expect(
      isChildRuntimeAuthorityRecord({
        ...unknownBody,
        recordDigest: childRuntimeAuthorityRecordDigest(unknownBody),
      }),
    ).toBe(false);

    const forgedEvidence = {
      ...claimed.activationEvidence,
      parentNodeDigest: canonicalDigest("changed without resealing"),
    };
    const forgedBody = {
      ...claimedBody,
      initialActivationEvidence: forgedEvidence,
      activationEvidence: forgedEvidence,
    };
    expect(
      isChildRuntimeAuthorityRecord({
        ...forgedBody,
        recordDigest: childRuntimeAuthorityRecordDigest(forgedBody),
      }),
    ).toBe(false);

    const foreignFence = writerFence(
      "foreign-parent-runtime",
      parentSessionId,
      createRuntimeId("runtime", "foreign-parent-runtime"),
    );
    const foreignFenceActivationBody = {
      ...activationBody,
      ownerParentWriterFence: foreignFence,
    };
    const foreignFenceActivation = {
      ...foreignFenceActivationBody,
      evidenceDigest: canonicalDigest(foreignFenceActivationBody),
    };
    const foreignFenceBody = {
      ...claimedBody,
      initialActivationEvidence: foreignFenceActivation,
      activationEvidence: foreignFenceActivation,
    };
    expect(
      isChildRuntimeAuthorityRecord({
        ...foreignFenceBody,
        recordDigest: childRuntimeAuthorityRecordDigest(foreignFenceBody),
      }),
    ).toBe(false);
  });

  it("rejects a parent writer fence that is stale at claim or create authorization", () => {
    const staleAtClaim = activationEvidence(
      "launch",
      "one",
      7,
      12,
      writerFence(
        "parent-stale-at-claim",
        parentSessionId,
        parentRuntimeId,
        NOW,
        "2026-07-23T00:59:59.000Z",
      ),
    );
    expect(() =>
      createClaimedChildRuntimeAuthorityRecord({
        authorityId,
        tenantId,
        principalId,
        parentSessionId,
        parentAgentId,
        agentId,
        sessionId,
        workspaceId,
        runtimeInstanceId,
        sessionFilePath,
        launchRequestId,
        launchRequestDigest,
        artifactContractDigest: canonicalDigest("artifact contract"),
        ownerParentRuntimeId: parentRuntimeId,
        initialActivationEvidence: staleAtClaim,
        activationEvidence: staleAtClaim,
        revision: 1,
        updatedAt: NOW,
      }),
    ).toThrow(/invalid/u);

    const expiresAtCreate = activationEvidence(
      "launch",
      "one",
      7,
      12,
      writerFence(
        "parent-stale-at-create",
        parentSessionId,
        parentRuntimeId,
        CREATE_STARTED_AT,
      ),
    );
    const claimed = createClaimedChildRuntimeAuthorityRecord({
      authorityId,
      tenantId,
      principalId,
      parentSessionId,
      parentAgentId,
      agentId,
      sessionId,
      workspaceId,
      runtimeInstanceId,
      sessionFilePath,
      launchRequestId,
      launchRequestDigest,
      artifactContractDigest: canonicalDigest("artifact contract"),
      ownerParentRuntimeId: parentRuntimeId,
      initialActivationEvidence: expiresAtCreate,
      activationEvidence: expiresAtCreate,
      revision: 1,
      updatedAt: NOW,
    });
    expect(() =>
      createCreatingChildRuntimeAuthorityRecord({
        previous: claimed,
        createStartedAt: CREATE_STARTED_AT,
        updatedAt: CREATE_STARTED_AT,
      }),
    ).toThrow(/invalid/u);
  });

  it("uses a random immutable claim attempt to distinguish competing creators", async () => {
    const first = claimedRecord();
    const competitor = claimedRecord();
    expect(competitor.launchRequestId).toBe(first.launchRequestId);
    expect(competitor.launchRequestDigest).toBe(first.launchRequestDigest);
    expect(competitor.claimAttemptId).not.toBe(first.claimAttemptId);
    expect(competitor.recordDigest).not.toBe(first.recordDigest);

    const store = new MemoryChildRuntimeAuthorityStore();
    await expect(store.begin(first)).resolves.toBe("applied");
    await expect(store.begin(structuredClone(first))).resolves.toBe("replay");
    await expect(store.begin(competitor)).resolves.toBe("conflict");

    const { recordDigest: _recordDigest, ...firstBody } = first;
    const reusedRequestAttemptBody = {
      ...firstBody,
      claimAttemptId: launchRequestId,
    };
    expect(
      isChildRuntimeAuthorityRecord({
        ...reusedRequestAttemptBody,
        recordDigest: childRuntimeAuthorityRecordDigest(
          reusedRequestAttemptBody,
        ),
      }),
    ).toBe(false);
  });

  it("durably fences every pre-resident effect boundary without allowing a skipped state", async () => {
    const claimed = claimedRecord();
    const creating = creatingRecord(claimed);
    const provisional = provisionalRecord(creating);
    const resident = createResidentChildRuntimeAuthorityRecord({
      previous: provisional,
      genesisCursor: cursor("pre-resident-genesis"),
      updatedAt: RESIDENT_AT,
    });
    const store = new MemoryChildRuntimeAuthorityStore();

    await expect(store.begin(claimed)).resolves.toBe("applied");
    await expect(
      store.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        provisional,
      ),
    ).rejects.toThrow(/transition|previous|revision|skip/u);
    await expect(
      store.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        creating,
      ),
    ).resolves.toBe("applied");
    await expect(
      store.compareAndSwap(
        agentId,
        creating.revision,
        creating.recordDigest,
        resident,
      ),
    ).rejects.toThrow(/transition|previous|revision|skip/u);
    await expect(
      store.compareAndSwap(
        agentId,
        creating.revision,
        creating.recordDigest,
        provisional,
      ),
    ).resolves.toBe("applied");
    await expect(
      store.compareAndSwap(
        agentId,
        provisional.revision,
        provisional.recordDigest,
        resident,
      ),
    ).resolves.toBe("applied");

    expect(resident).toMatchObject({
      sessionFilePath,
      createStartedAt: CREATE_STARTED_AT,
      launchReceipt: provisional.launchReceipt,
      residencyReceipt: provisional.residencyReceipt,
      childWriterFence: provisional.childWriterFence,
      genesisCursor: { sequence: 0 },
    });
    expect(resident.activationEvidence).toEqual(claimed.activationEvidence);
  });

  it("keeps the planned path immutable and quarantines with all accumulated evidence", () => {
    const claimed = claimedRecord();
    const creating = creatingRecord(claimed);
    const provisional = provisionalRecord(creating);
    const resident = createResidentChildRuntimeAuthorityRecord({
      previous: provisional,
      genesisCursor: cursor("quarantine-genesis"),
      updatedAt: RESIDENT_AT,
    });
    const stages = [claimed, creating, provisional, resident] as const;

    for (const previous of stages) {
      const quarantined = createQuarantinedChildRuntimeAuthorityRecord({
        previous,
        reason: "operator_review",
        evidenceDigest: canonicalDigest({
          previousRecordDigest: previous.recordDigest,
        }),
        updatedAt: RELEASED_AT,
      });
      expect(quarantined.sessionFilePath).toBe(sessionFilePath);
      expect(Object.hasOwn(quarantined, "createStartedAt")).toBe(
        Object.hasOwn(previous, "createStartedAt"),
      );
      expect(Object.hasOwn(quarantined, "childWriterFence")).toBe(
        Object.hasOwn(previous, "childWriterFence"),
      );
      expect(Object.hasOwn(quarantined, "genesisCursor")).toBe(
        Object.hasOwn(previous, "genesisCursor"),
      );
    }
    const quarantineAfterCreateEffect =
      createQuarantinedChildRuntimeAuthorityRecord({
        previous: creating,
        reason: "provisional_cas_uncertain",
        evidenceDigest: canonicalDigest("provisional CAS evidence"),
        provisionalEvidence: {
          launchReceipt: provisional.launchReceipt,
          residencyReceipt: provisional.residencyReceipt,
          childWriterFence: provisional.childWriterFence,
        },
        updatedAt: RELEASED_AT,
      });
    expect(quarantineAfterCreateEffect).toMatchObject({
      state: "quarantined",
      sessionFilePath,
      launchReceipt: provisional.launchReceipt,
      residencyReceipt: provisional.residencyReceipt,
      childWriterFence: provisional.childWriterFence,
    });
    const genesisCursor = cursor("quarantine-provisional-genesis");
    const quarantineAfterGenesis =
      createQuarantinedChildRuntimeAuthorityRecord({
        previous: provisional,
        reason: "resident_cas_uncertain",
        evidenceDigest: canonicalDigest("resident CAS evidence"),
        genesisCursor,
        updatedAt: RELEASED_AT,
      });
    expect(quarantineAfterGenesis).toMatchObject({
      state: "quarantined",
      sessionFilePath,
      childWriterFence: provisional.childWriterFence,
      genesisCursor,
    });
    expect(() =>
      createQuarantinedChildRuntimeAuthorityRecord({
        previous: claimed,
        reason: "invalid_evidence_skip",
        evidenceDigest: canonicalDigest("invalid skipped evidence"),
        provisionalEvidence: {
          launchReceipt: provisional.launchReceipt,
          residencyReceipt: provisional.residencyReceipt,
          childWriterFence: provisional.childWriterFence,
        },
        updatedAt: RELEASED_AT,
      }),
    ).toThrow(/evidence|transition|invalid/u);

    const { recordDigest: _recordDigest, ...creatingBody } = creating;
    const changedPathBody = {
      ...creatingBody,
      sessionFilePath: "/tmp/runledger-child-runtime-authority/other.jsonl",
    };
    const changedPath = {
      ...changedPathBody,
      recordDigest: childRuntimeAuthorityRecordDigest(changedPathBody),
    };
    expect(isChildRuntimeAuthorityRecord(changedPath)).toBe(true);
    expect(() =>
      validateChildRuntimeAuthorityTransition(claimed, changedPath),
    ).toThrow(/identity|path|immutable/u);
    expect(() =>
      createResidentChildRuntimeAuthorityRecord({
        previous:
          claimed as unknown as ProvisionalChildRuntimeAuthorityRecord,
        genesisCursor: cursor("invalid-direct-resident"),
        updatedAt: RESIDENT_AT,
      }),
    ).toThrow(/provisional|resident|invalid/u);
  });

  it("advances only to a newer sealed resume activation and refreshed child fence", async () => {
    const claimed = claimedRecord();
    const creating = creatingRecord(claimed);
    const provisional = provisionalRecord(creating);
    const resident = createResidentChildRuntimeAuthorityRecord({
      previous: provisional,
      genesisCursor: cursor("resume-genesis"),
      updatedAt: RESIDENT_AT,
    });
    const resumed = resumedRecord(resident);

    expect(resumed.claimAttemptId).toBe(claimed.claimAttemptId);
    expect(resumed.launchRequestId).toBe(claimed.launchRequestId);
    expect(resumed.launchRequestDigest).toBe(claimed.launchRequestDigest);
    expect(resumed.initialActivationEvidence).toEqual(
      claimed.initialActivationEvidence,
    );
    expect(resumed.activationEvidence).toMatchObject({
      activationType: "resume",
      parentGraphRevision: 8,
      parentGraphCursor: { sequence: 13 },
    });
    expect(Date.parse(resumed.childWriterFence.expiresAt)).toBeGreaterThan(
      Date.parse(resident.childWriterFence.expiresAt),
    );

    const store = new MemoryChildRuntimeAuthorityStore();
    await expect(store.begin(claimed)).resolves.toBe("applied");
    await expect(
      store.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        creating,
      ),
    ).resolves.toBe("applied");
    await expect(
      store.compareAndSwap(
        agentId,
        creating.revision,
        creating.recordDigest,
        provisional,
      ),
    ).resolves.toBe("applied");
    await expect(
      store.compareAndSwap(
        agentId,
        provisional.revision,
        provisional.recordDigest,
        resident,
      ),
    ).resolves.toBe("applied");
    await expect(
      store.compareAndSwap(
        agentId,
        resident.revision,
        resident.recordDigest,
        resumed,
      ),
    ).resolves.toBe("applied");
  });

  it("rejects resume activation replay, graph rollback, and fence identity changes", async () => {
    const cases = [
      () => resumedRecord(residentRecord(), "one", 7, 13),
      () => resumedRecord(residentRecord(), "one", 8, 12),
      () => {
        const resident = residentRecord();
        return createResumedChildRuntimeAuthorityRecord({
          previous: resident,
          activationEvidence: {
            ...resident.activationEvidence,
            activationType: "resume",
          },
          launchReceipt: launchReceipt(2, RELEASE_PENDING_AT),
          residencyReceipt: residencyReceipt(
            "resident",
            2,
            RELEASE_PENDING_AT,
          ),
          childWriterFence: renewedWriterFence(
            resident.childWriterFence,
            "2026-07-23T01:10:00.000Z",
          ),
          updatedAt: RELEASE_PENDING_AT,
        });
      },
      () =>
        resumedRecord(
          residentRecord(),
          "changed-child-lease",
          8,
          13,
          writerFence(
            "changed-child-lease",
            sessionId,
            runtimeInstanceId,
            "2026-07-23T01:10:00.000Z",
          ),
        ),
      () =>
        resumedRecord(
          residentRecord(),
          "expired-child-fence",
          8,
          13,
          renewedWriterFence(
            residentRecord().childWriterFence,
            "2026-07-23T01:04:00.000Z",
          ),
        ),
    ];

    for (const createInvalidResume of cases) {
      expect(createInvalidResume).toThrow(
        /activation|cursor|graph|request|fence|lease|resume|invalid/u,
      );
    }
  });

  it("accepts heartbeat-refreshed pre-stop fences and preserves latest activation", () => {
    const resumed = resumedRecord();
    const preStopWriterFence = renewedWriterFence(
      resumed.childWriterFence,
      "2026-07-23T01:15:00.000Z",
    );
    const requestBody: Omit<AgentRuntimeReleaseRequest, "requestDigest"> = {
      requestId: createRuntimeId("command", "child-runtime-release-resumed"),
      agentId,
      sessionId,
      launchReceipt: resumed.launchReceipt,
      previousResidencyReceipt: resumed.residencyReceipt,
      reason: "completed",
    };
    const request = {
      ...requestBody,
      requestDigest: canonicalDigest(requestBody),
    };
    const pending = createReleasePendingChildRuntimeAuthorityRecord({
      previous: resumed,
      releaseRequest: request,
      preStopWriterFence,
      updatedAt: RELEASED_AT,
    });
    const quarantined = createQuarantinedChildRuntimeAuthorityRecord({
      previous: resumed,
      reason: "operator_review",
      evidenceDigest: canonicalDigest("operator review"),
      updatedAt: RELEASED_AT,
    });

    expect(pending.preStopWriterFence).toEqual(preStopWriterFence);
    expect(pending.preStopWriterFence.receiptDigest).not.toBe(
      pending.childWriterFence.receiptDigest,
    );
    expect(pending.activationEvidence).toEqual(resumed.activationEvidence);
    expect(quarantined.activationEvidence).toEqual(resumed.activationEvidence);
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
    const {
      evidenceDigest: _foreignEvidenceDigest,
      ...activationBody
    } = claimed.activationEvidence;
    const foreignActivationBody = {
      ...activationBody,
      parentGraphCursor: {
        ...claimed.activationEvidence.parentGraphCursor,
        stream: createSessionEventStreamRef(
          {
            authorityId: createRuntimeId("authority", "foreign-stream"),
            tenantId,
          },
          parentSessionId,
        ),
      },
    };
    const foreignActivation = {
      ...foreignActivationBody,
      evidenceDigest: canonicalDigest(foreignActivationBody),
    };
    const foreignStreamBody = {
      ...claimedBody,
      initialActivationEvidence: foreignActivation,
      activationEvidence: foreignActivation,
    };
    const foreignStreamRecord = {
      ...foreignStreamBody,
      recordDigest: childRuntimeAuthorityRecordDigest(foreignStreamBody),
    };

    const fence = claimed.activationEvidence.ownerParentWriterFence;
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
    const {
      evidenceDigest: _extendedEvidenceDigest,
      ...extendedActivationBody
    } = claimed.activationEvidence;
    const extendedEvidenceBody = {
      ...extendedActivationBody,
      ownerParentWriterFence: extendedFence,
    };
    const extendedEvidence = {
      ...extendedEvidenceBody,
      evidenceDigest: canonicalDigest(extendedEvidenceBody),
    };
    const extendedStreamBody = {
      ...extendedClaimedBody,
      initialActivationEvidence: extendedEvidence,
      activationEvidence: extendedEvidence,
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
    const creating = creatingRecord(claimed);
    const provisional = provisionalRecord(creating);
    const resident = createResidentChildRuntimeAuthorityRecord({
      previous: provisional,
      genesisCursor: cursor("cas-genesis"),
      updatedAt: RESIDENT_AT,
    });
    const pending = releasePendingRecord("one", resident);
    const released = releasedRecord("one", pending);
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
      await store.compareAndSwap(agentId, 0, claimed.recordDigest, creating),
    ).toBe("conflict");
    expect(
      await store.compareAndSwap(agentId, 1, "f".repeat(64), creating),
    ).toBe("conflict");
    expect(
      await store.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        creating,
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwap(
        agentId,
        creating.revision,
        creating.recordDigest,
        provisional,
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwap(
        agentId,
        provisional.revision,
        provisional.recordDigest,
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
    const quarantined = quarantinedRecord(claimed);
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
    const creating = creatingRecord(claimed);
    const results: string[] = [];

    for (const store of stores) {
      expect(await store.begin(claimed)).toBe("applied");
      expect(
        await store.compareAndSwap(
          agentId,
          claimed.revision,
          claimed.recordDigest,
          creating,
        ),
      ).toBe("applied");
      expect(
        await store.compareAndSwap(
          agentId,
          claimed.revision,
          claimed.recordDigest,
          structuredClone(creating),
        ),
      ).toBe("replay");
      results.push(
        await store.compareAndSwap(
          agentId,
          creating.revision + 1,
          "f".repeat(64),
          structuredClone(creating),
        ),
      );
    }

    expect(results).toEqual(["conflict", "conflict"]);
  });

  it("serializes an in-memory root audit with begin", async () => {
    const store = new MemoryChildRuntimeAuthorityStore();
    let enteredAudit!: () => void;
    let releaseAudit!: () => void;
    const auditEntered = new Promise<void>((resolve) => {
      enteredAudit = resolve;
    });
    const auditGate = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    const auditing = store.withExclusiveRootAudit(async (records) => {
      expect(records).toEqual([]);
      enteredAudit();
      await auditGate;
      return "audited";
    });
    await auditEntered;

    let beginSettled = false;
    const beginning = store.begin(claimedRecord()).finally(() => {
      beginSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(beginSettled).toBe(false);

    releaseAudit();
    await expect(auditing).resolves.toBe("audited");
    await expect(beginning).resolves.toBe("applied");
  });

  it("serializes a cross-instance file root audit with begin", async () => {
    const parent = await temporaryRoot("root-fence");
    const root = join(parent, "state");
    const auditor = new FileChildRuntimeAuthorityStore(root);
    const writer = new FileChildRuntimeAuthorityStore(root);
    let enteredAudit!: () => void;
    let releaseAudit!: () => void;
    const auditEntered = new Promise<void>((resolve) => {
      enteredAudit = resolve;
    });
    const auditGate = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    const auditing = auditor.withExclusiveRootAudit(async (records) => {
      expect(records).toEqual([]);
      enteredAudit();
      await auditGate;
      return "audited";
    });
    await auditEntered;

    let beginSettled = false;
    const beginning = writer.begin(claimedRecord()).finally(() => {
      beginSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(beginSettled).toBe(false);

    releaseAudit();
    await expect(auditing).resolves.toBe("audited");
    await expect(beginning).resolves.toBe("applied");
  });

  it("fails closed on .json symlinks and non-regular directory entries", async () => {
    const parent = await temporaryRoot("non-regular-json");
    const root = join(parent, "state");
    await mkdir(root, { mode: 0o700 });
    const target = join(parent, "target.json");
    const suspicious = join(root, `${"a".repeat(64)}.json`);
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, suspicious);

    const store = new FileChildRuntimeAuthorityStore(root);
    await expect(store.list()).rejects.toThrow(/entry|file|identity|unsafe/u);

    await rm(suspicious);
    await mkdir(suspicious, { mode: 0o700 });
    await expect(store.list()).rejects.toThrow(/entry|file|identity|unsafe/u);
  });

  it("removes one private orphaned publish temporary under the root fence", async () => {
    const parent = await temporaryRoot("orphaned-publish-temp");
    const root = join(parent, "state");
    await mkdir(root, { mode: 0o700 });
    const temporary = join(root, `.${randomUUID()}.tmp`);
    await writeFile(temporary, "", { mode: 0o600 });

    await expect(
      new FileChildRuntimeAuthorityStore(root).list(),
    ).resolves.toEqual([]);
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds all authority-root entries, including safe publish temporaries", async () => {
    const parent = await temporaryRoot("root-entry-bound");
    const root = join(parent, "state");
    await mkdir(root, { mode: 0o700 });
    for (let index = 0; index < 1_025; index += 1) {
      await writeFile(join(root, `.${randomUUID()}.tmp`), "", {
        mode: 0o600,
      });
    }

    await expect(
      new FileChildRuntimeAuthorityStore(root).list(),
    ).rejects.toThrow(/bound|count|entries/u);
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
    const creating = creatingRecord(claimed);
    const provisional = provisionalRecord(creating);
    const resident = createResidentChildRuntimeAuthorityRecord({
      previous: provisional,
      genesisCursor: cursor("file-genesis"),
      updatedAt: RESIDENT_AT,
    });
    const pending = releasePendingRecord("one", resident);
    const released = releasedRecord("one", pending);
    const first = new FileChildRuntimeAuthorityStore(root);
    expect(await first.begin(claimed)).toBe("applied");
    expect(
      await first.compareAndSwap(
        agentId,
        claimed.revision,
        claimed.recordDigest,
        creating,
      ),
    ).toBe("applied");
    expect(
      await first.compareAndSwap(
        agentId,
        creating.revision,
        creating.recordDigest,
        provisional,
      ),
    ).toBe("applied");
    expect(
      await first.compareAndSwap(
        agentId,
        provisional.revision,
        provisional.recordDigest,
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
