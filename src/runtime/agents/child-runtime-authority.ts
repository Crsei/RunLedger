/** Child runtime 外部 effect 的私有 authority sidecar 合同。 */

import { isAbsolute, resolve } from "node:path";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import type {
  AgentId,
  AuthorityId,
  CommandId,
  LeaseId,
  PrincipalId,
  RuntimeInstanceId,
  SessionId,
  TenantId,
  WorkspaceId,
} from "../protocol/v3/ids.ts";
import {
  createSessionEventStreamRef,
  type EventCursor,
  type RuntimeEventStreamRef,
} from "../protocol/v3/events.ts";
import type {
  AgentLaunchReceiptRef,
  AgentResidencyReceiptRef,
  AgentRuntimeReleaseReceiptRef,
  AgentRuntimeReleaseRequest,
} from "./types.ts";

const DIGEST = /^[a-f0-9]{64}$/u;

export type ChildRuntimeAuthorityState =
  "claimed" | "resident" | "release_pending" | "released" | "quarantined";

export interface ChildRuntimeWriterFenceReceipt {
  authorityId: AuthorityId;
  tenantId: TenantId;
  sessionId: SessionId;
  runtimeId: RuntimeInstanceId;
  stream: RuntimeEventStreamRef;
  leaseId: LeaseId;
  writerEpoch: number;
  fencingTokenDigest: string;
  acquiredAt: string;
  expiresAt: string;
  receiptId: AgentLaunchReceiptRef["receiptId"];
  receiptDigest: string;
}

export interface ChildRuntimeWriterLeaseReleasedEvidence {
  authorityId: AuthorityId;
  tenantId: TenantId;
  sessionId: SessionId;
  runtimeInstanceId: RuntimeInstanceId;
  leaseId: LeaseId;
  writerEpoch: number;
  fencingTokenDigest: string;
  releasedAt: string;
  evidenceDigest: string;
}

interface ChildRuntimeAuthorityCommon {
  schemaVersion: 1;
  kind: "child_runtime_authority";
  state: ChildRuntimeAuthorityState;
  revision: number;
  previousRecordDigest?: string;
  authorityId: AuthorityId;
  tenantId: TenantId;
  principalId: PrincipalId;
  parentSessionId: SessionId;
  parentAgentId: AgentId;
  parentGraphRevision: number;
  parentGraphCursor: EventCursor;
  parentNodeDigest: string;
  agentId: AgentId;
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  runtimeInstanceId: RuntimeInstanceId;
  launchRequestId: CommandId;
  launchRequestDigest: string;
  delegationReceiptDigest: string;
  workspaceReceiptDigest: string;
  budgetReservationDigest: string;
  artifactContractDigest: string;
  ownerParentRuntimeId: RuntimeInstanceId;
  ownerParentWriterFence: ChildRuntimeWriterFenceReceipt;
  updatedAt: string;
}

export interface ClaimedChildRuntimeAuthorityRecord extends ChildRuntimeAuthorityCommon {
  state: "claimed";
  recordDigest: string;
}

interface ChildRuntimeResidentFields {
  sessionFilePath: string;
  genesisCursor: EventCursor;
  launchReceipt: AgentLaunchReceiptRef;
  residencyReceipt: AgentResidencyReceiptRef;
  childWriterFence: ChildRuntimeWriterFenceReceipt;
}

export interface ResidentChildRuntimeAuthorityRecord
  extends ChildRuntimeAuthorityCommon, ChildRuntimeResidentFields {
  state: "resident";
  previousRecordDigest: string;
  recordDigest: string;
}

interface ChildRuntimeReleasePendingFields {
  releaseRequest: AgentRuntimeReleaseRequest;
  preStopWriterFence: ChildRuntimeWriterFenceReceipt;
}

export interface ReleasePendingChildRuntimeAuthorityRecord
  extends
    ChildRuntimeAuthorityCommon,
    ChildRuntimeResidentFields,
    ChildRuntimeReleasePendingFields {
  state: "release_pending";
  previousRecordDigest: string;
  recordDigest: string;
}

export interface ReleasedChildRuntimeAuthorityRecord
  extends
    ChildRuntimeAuthorityCommon,
    ChildRuntimeResidentFields,
    ChildRuntimeReleasePendingFields {
  state: "released";
  previousRecordDigest: string;
  releaseReceipt: AgentRuntimeReleaseReceiptRef;
  writerLeaseReleasedEvidence: ChildRuntimeWriterLeaseReleasedEvidence;
  recordDigest: string;
}

export interface QuarantinedChildRuntimeAuthorityRecord extends ChildRuntimeAuthorityCommon {
  state: "quarantined";
  previousRecordDigest: string;
  reason: string;
  evidenceDigest: string;
  sessionFilePath?: string;
  genesisCursor?: EventCursor;
  launchReceipt?: AgentLaunchReceiptRef;
  residencyReceipt?: AgentResidencyReceiptRef;
  childWriterFence?: ChildRuntimeWriterFenceReceipt;
  releaseRequest?: AgentRuntimeReleaseRequest;
  preStopWriterFence?: ChildRuntimeWriterFenceReceipt;
  recordDigest: string;
}

export type ChildRuntimeAuthorityRecord =
  | ClaimedChildRuntimeAuthorityRecord
  | ResidentChildRuntimeAuthorityRecord
  | ReleasePendingChildRuntimeAuthorityRecord
  | ReleasedChildRuntimeAuthorityRecord
  | QuarantinedChildRuntimeAuthorityRecord;

type WithoutRecordDigest<T> = T extends unknown
  ? Omit<T, "recordDigest">
  : never;
export type ChildRuntimeAuthorityRecordBody =
  WithoutRecordDigest<ChildRuntimeAuthorityRecord>;

export interface ChildRuntimeAuthorityStorePort {
  read(agentId: AgentId): Promise<ChildRuntimeAuthorityRecord | undefined>;
  begin(
    record: ChildRuntimeAuthorityRecord,
  ): Promise<"applied" | "replay" | "conflict">;
  compareAndSwap(
    agentId: AgentId,
    expectedRevision: number,
    expectedRecordDigest: string,
    next: ChildRuntimeAuthorityRecord,
  ): Promise<"applied" | "replay" | "conflict">;
}

export type CreateClaimedChildRuntimeAuthorityRecordInput = Omit<
  ClaimedChildRuntimeAuthorityRecord,
  "schemaVersion" | "kind" | "state" | "recordDigest"
>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function validSessionStream(
  value: unknown,
  expected: {
    authorityId: AuthorityId;
    tenantId: TenantId;
    sessionId: SessionId;
  },
): value is RuntimeEventStreamRef {
  if (!isObject(value) || !exactKeys(value, ["scope", "streamId", "sessionId"]))
    return false;
  const canonical = createSessionEventStreamRef(expected, expected.sessionId);
  return (
    value.scope === canonical.scope &&
    value.streamId === canonical.streamId &&
    value.sessionId === canonical.sessionId
  );
}

function validCursor(
  value: unknown,
  expected: {
    authorityId: AuthorityId;
    tenantId: TenantId;
    sessionId: SessionId;
  },
): value is EventCursor {
  if (
    !isObject(value) ||
    !exactKeys(value, ["stream", "sequence", "eventId", "eventHash"])
  )
    return false;
  return (
    validSessionStream(value.stream, expected) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 0 &&
    isRuntimeId(value.eventId, "event") &&
    validDigest(value.eventHash)
  );
}

function validWriterFence(
  value: unknown,
  expected: {
    authorityId: AuthorityId;
    tenantId: TenantId;
    sessionId: SessionId;
    runtimeId: RuntimeInstanceId;
  },
): value is ChildRuntimeWriterFenceReceipt {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "authorityId",
      "tenantId",
      "sessionId",
      "runtimeId",
      "stream",
      "leaseId",
      "writerEpoch",
      "fencingTokenDigest",
      "acquiredAt",
      "expiresAt",
      "receiptId",
      "receiptDigest",
    ]) ||
    value.authorityId !== expected.authorityId ||
    value.tenantId !== expected.tenantId ||
    value.sessionId !== expected.sessionId ||
    value.runtimeId !== expected.runtimeId ||
    !isRuntimeId(value.leaseId, "lease") ||
    !Number.isSafeInteger(value.writerEpoch) ||
    Number(value.writerEpoch) < 1 ||
    !validDigest(value.fencingTokenDigest) ||
    !validTimestamp(value.acquiredAt) ||
    !validTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt) ||
    !isRuntimeId(value.receiptId, "receipt") ||
    !validDigest(value.receiptDigest) ||
    !validSessionStream(value.stream, expected)
  )
    return false;
  const { receiptId: _receiptId, receiptDigest, ...body } = value;
  return receiptDigest === canonicalDigest(body);
}

function validLaunchReceipt(
  value: unknown,
  record: ChildRuntimeAuthorityCommon,
): value is AgentLaunchReceiptRef {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "receiptId",
      "agentId",
      "sessionId",
      "launchRevision",
      "launchedAt",
      "receiptDigest",
    ])
  )
    return false;
  const { receiptDigest, ...body } = value;
  return (
    isRuntimeId(value.receiptId, "receipt") &&
    value.agentId === record.agentId &&
    value.sessionId === record.sessionId &&
    Number.isSafeInteger(value.launchRevision) &&
    Number(value.launchRevision) >= 1 &&
    validTimestamp(value.launchedAt) &&
    validDigest(receiptDigest) &&
    receiptDigest === canonicalDigest(body)
  );
}

function validResidencyReceipt(
  value: unknown,
  record: ChildRuntimeAuthorityCommon,
  state: "resident" | "nonresident",
): value is AgentResidencyReceiptRef {
  if (
    !isObject(value) ||
    !exactKeys(
      value,
      [
        "receiptId",
        "agentId",
        "sessionId",
        "runtimeInstanceId",
        "state",
        "revision",
        "observedAt",
        "receiptDigest",
      ],
      ["reasonDigest"],
    )
  )
    return false;
  const { receiptDigest, ...body } = value;
  return (
    isRuntimeId(value.receiptId, "receipt") &&
    value.agentId === record.agentId &&
    value.sessionId === record.sessionId &&
    value.runtimeInstanceId === record.runtimeInstanceId &&
    value.state === state &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    validTimestamp(value.observedAt) &&
    (value.reasonDigest === undefined || validDigest(value.reasonDigest)) &&
    validDigest(receiptDigest) &&
    receiptDigest === canonicalDigest(body)
  );
}

function validReleaseRequest(
  value: unknown,
  record: ChildRuntimeAuthorityCommon & ChildRuntimeResidentFields,
): value is AgentRuntimeReleaseRequest {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "requestId",
      "agentId",
      "sessionId",
      "launchReceipt",
      "previousResidencyReceipt",
      "reason",
      "requestDigest",
    ])
  )
    return false;
  const { requestDigest, ...body } = value;
  return (
    isRuntimeId(value.requestId, "command") &&
    value.agentId === record.agentId &&
    value.sessionId === record.sessionId &&
    ["completed", "failed", "stopped"].includes(String(value.reason)) &&
    validDigest(requestDigest) &&
    requestDigest === canonicalDigest(body) &&
    canonicalDigest(value.launchReceipt) ===
      canonicalDigest(record.launchReceipt) &&
    canonicalDigest(value.previousResidencyReceipt) ===
      canonicalDigest(record.residencyReceipt)
  );
}

function validReleaseReceipt(
  value: unknown,
  record: ChildRuntimeAuthorityCommon &
    ChildRuntimeResidentFields &
    ChildRuntimeReleasePendingFields,
): value is AgentRuntimeReleaseReceiptRef {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "receiptId",
      "requestId",
      "requestDigest",
      "agentId",
      "sessionId",
      "runtimeInstanceId",
      "launchReceiptId",
      "launchRevision",
      "writerFenceReceiptId",
      "writerFenceReceiptDigest",
      "finalCursor",
      "residencyReceipt",
      "releasedAt",
      "receiptDigest",
    ])
  )
    return false;
  const { receiptDigest, ...body } = value;
  return (
    isRuntimeId(value.receiptId, "receipt") &&
    value.requestId === record.releaseRequest.requestId &&
    value.requestDigest === record.releaseRequest.requestDigest &&
    value.agentId === record.agentId &&
    value.sessionId === record.sessionId &&
    value.runtimeInstanceId === record.runtimeInstanceId &&
    value.launchReceiptId === record.launchReceipt.receiptId &&
    value.launchRevision === record.launchReceipt.launchRevision &&
    value.writerFenceReceiptId === record.preStopWriterFence.receiptId &&
    value.writerFenceReceiptDigest ===
      record.preStopWriterFence.receiptDigest &&
    validCursor(value.finalCursor, {
      authorityId: record.authorityId,
      tenantId: record.tenantId,
      sessionId: record.sessionId,
    }) &&
    validResidencyReceipt(value.residencyReceipt, record, "nonresident") &&
    value.residencyReceipt.revision === record.residencyReceipt.revision + 1 &&
    validTimestamp(value.releasedAt) &&
    value.residencyReceipt.observedAt === value.releasedAt &&
    validDigest(receiptDigest) &&
    receiptDigest === canonicalDigest(body)
  );
}

function validReleasedEvidence(
  value: unknown,
  record: ChildRuntimeAuthorityCommon & ChildRuntimeResidentFields,
  releasedAt: string,
): value is ChildRuntimeWriterLeaseReleasedEvidence {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "authorityId",
      "tenantId",
      "sessionId",
      "runtimeInstanceId",
      "leaseId",
      "writerEpoch",
      "fencingTokenDigest",
      "releasedAt",
      "evidenceDigest",
    ])
  )
    return false;
  const { evidenceDigest, ...body } = value;
  return (
    value.authorityId === record.authorityId &&
    value.tenantId === record.tenantId &&
    value.sessionId === record.sessionId &&
    value.runtimeInstanceId === record.runtimeInstanceId &&
    value.leaseId === record.childWriterFence.leaseId &&
    value.writerEpoch === record.childWriterFence.writerEpoch &&
    value.fencingTokenDigest === record.childWriterFence.fencingTokenDigest &&
    value.releasedAt === releasedAt &&
    validTimestamp(value.releasedAt) &&
    validDigest(evidenceDigest) &&
    evidenceDigest === canonicalDigest(body)
  );
}

const COMMON_KEYS = [
  "schemaVersion",
  "kind",
  "state",
  "revision",
  "authorityId",
  "tenantId",
  "principalId",
  "parentSessionId",
  "parentAgentId",
  "parentGraphRevision",
  "parentGraphCursor",
  "parentNodeDigest",
  "agentId",
  "sessionId",
  "workspaceId",
  "runtimeInstanceId",
  "launchRequestId",
  "launchRequestDigest",
  "delegationReceiptDigest",
  "workspaceReceiptDigest",
  "budgetReservationDigest",
  "artifactContractDigest",
  "ownerParentRuntimeId",
  "ownerParentWriterFence",
  "updatedAt",
  "recordDigest",
] as const;

const RESIDENT_KEYS = [
  "sessionFilePath",
  "genesisCursor",
  "launchReceipt",
  "residencyReceipt",
  "childWriterFence",
] as const;

const RELEASE_PENDING_KEYS = ["releaseRequest", "preStopWriterFence"] as const;

function validCommon(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ChildRuntimeAuthorityCommon {
  return (
    value.schemaVersion === 1 &&
    value.kind === "child_runtime_authority" &&
    [
      "claimed",
      "resident",
      "release_pending",
      "released",
      "quarantined",
    ].includes(String(value.state)) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    isRuntimeId(value.authorityId, "authority") &&
    isRuntimeId(value.tenantId, "tenant") &&
    isRuntimeId(value.principalId, "principal") &&
    isRuntimeId(value.parentSessionId, "session") &&
    isRuntimeId(value.parentAgentId, "agent") &&
    Number.isSafeInteger(value.parentGraphRevision) &&
    Number(value.parentGraphRevision) >= 1 &&
    validCursor(value.parentGraphCursor, {
      authorityId: value.authorityId as AuthorityId,
      tenantId: value.tenantId as TenantId,
      sessionId: value.parentSessionId as SessionId,
    }) &&
    validDigest(value.parentNodeDigest) &&
    isRuntimeId(value.agentId, "agent") &&
    isRuntimeId(value.sessionId, "session") &&
    value.sessionId !== value.parentSessionId &&
    isRuntimeId(value.workspaceId, "workspace") &&
    isRuntimeId(value.runtimeInstanceId, "runtime") &&
    isRuntimeId(value.launchRequestId, "command") &&
    validDigest(value.launchRequestDigest) &&
    validDigest(value.delegationReceiptDigest) &&
    validDigest(value.workspaceReceiptDigest) &&
    validDigest(value.budgetReservationDigest) &&
    validDigest(value.artifactContractDigest) &&
    isRuntimeId(value.ownerParentRuntimeId, "runtime") &&
    validTimestamp(value.updatedAt) &&
    validWriterFence(value.ownerParentWriterFence, {
      authorityId: value.authorityId as AuthorityId,
      tenantId: value.tenantId as TenantId,
      sessionId: value.parentSessionId as SessionId,
      runtimeId: value.ownerParentRuntimeId as RuntimeInstanceId,
    })
  );
}

function validResidentFields(
  value: Record<string, unknown> & ChildRuntimeAuthorityCommon,
): value is typeof value & ChildRuntimeResidentFields {
  return (
    typeof value.sessionFilePath === "string" &&
    isAbsolute(value.sessionFilePath) &&
    resolve(value.sessionFilePath) === value.sessionFilePath &&
    !value.sessionFilePath.includes("\0") &&
    validCursor(value.genesisCursor, {
      authorityId: value.authorityId,
      tenantId: value.tenantId,
      sessionId: value.sessionId,
    }) &&
    value.genesisCursor.sequence === 0 &&
    validLaunchReceipt(value.launchReceipt, value) &&
    validResidencyReceipt(value.residencyReceipt, value, "resident") &&
    value.residencyReceipt.revision === value.launchReceipt.launchRevision &&
    validWriterFence(value.childWriterFence, {
      authorityId: value.authorityId,
      tenantId: value.tenantId,
      sessionId: value.sessionId,
      runtimeId: value.runtimeInstanceId,
    })
  );
}

/** recordDigest 总是覆盖完整 state body，不允许忽略未知字段。 */
export function childRuntimeAuthorityRecordDigest(
  record: ChildRuntimeAuthorityRecordBody,
): string {
  return canonicalDigest(record);
}

export function isChildRuntimeAuthorityRecord(
  value: unknown,
): value is ChildRuntimeAuthorityRecord {
  if (
    !isObject(value) ||
    !validCommon(value) ||
    !validDigest(value.recordDigest)
  )
    return false;
  const { recordDigest, ...body } = value;
  if (
    recordDigest !==
    childRuntimeAuthorityRecordDigest(body as ChildRuntimeAuthorityRecordBody)
  )
    return false;
  const previousRequired = value.state !== "claimed";
  if (previousRequired !== Object.hasOwn(value, "previousRecordDigest"))
    return false;
  if (previousRequired && !validDigest(value.previousRecordDigest))
    return false;

  if (value.state === "claimed") {
    return value.revision === 1 && exactKeys(value, COMMON_KEYS);
  }
  if (value.state === "resident") {
    return (
      value.revision >= 2 &&
      exactKeys(value, [
        ...COMMON_KEYS,
        "previousRecordDigest",
        ...RESIDENT_KEYS,
      ]) &&
      validResidentFields(value)
    );
  }
  if (value.state === "release_pending") {
    return (
      value.revision >= 3 &&
      exactKeys(value, [
        ...COMMON_KEYS,
        "previousRecordDigest",
        ...RESIDENT_KEYS,
        ...RELEASE_PENDING_KEYS,
      ]) &&
      validResidentFields(value) &&
      validReleaseRequest(value.releaseRequest, value) &&
      validWriterFence(value.preStopWriterFence, {
        authorityId: value.authorityId,
        tenantId: value.tenantId,
        sessionId: value.sessionId,
        runtimeId: value.runtimeInstanceId,
      }) &&
      canonicalDigest(value.preStopWriterFence) ===
        canonicalDigest(value.childWriterFence)
    );
  }
  if (value.state === "released") {
    return (
      value.revision >= 4 &&
      exactKeys(value, [
        ...COMMON_KEYS,
        "previousRecordDigest",
        ...RESIDENT_KEYS,
        ...RELEASE_PENDING_KEYS,
        "releaseReceipt",
        "writerLeaseReleasedEvidence",
      ]) &&
      validResidentFields(value) &&
      validReleaseRequest(value.releaseRequest, value) &&
      validWriterFence(value.preStopWriterFence, {
        authorityId: value.authorityId,
        tenantId: value.tenantId,
        sessionId: value.sessionId,
        runtimeId: value.runtimeInstanceId,
      }) &&
      canonicalDigest(value.preStopWriterFence) ===
        canonicalDigest(value.childWriterFence) &&
      validReleaseReceipt(
        value.releaseReceipt,
        value as Record<string, unknown> &
          ChildRuntimeAuthorityCommon &
          ChildRuntimeResidentFields &
          ChildRuntimeReleasePendingFields,
      ) &&
      validReleasedEvidence(
        value.writerLeaseReleasedEvidence,
        value,
        value.releaseReceipt.releasedAt,
      ) &&
      value.updatedAt === value.releaseReceipt.releasedAt
    );
  }

  const hasResident = Object.hasOwn(value, "sessionFilePath");
  const hasPending = Object.hasOwn(value, "releaseRequest");
  const optional = [
    "previousRecordDigest",
    "reason",
    "evidenceDigest",
    ...(hasResident ? RESIDENT_KEYS : []),
    ...(hasPending ? RELEASE_PENDING_KEYS : []),
  ];
  return (
    value.revision >= 2 &&
    exactKeys(value, [...COMMON_KEYS, ...optional]) &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason.length <= 128 &&
    validDigest(value.evidenceDigest) &&
    (!hasResident || validResidentFields(value)) &&
    (!hasPending ||
      (hasResident &&
        validReleaseRequest(
          value.releaseRequest,
          value as Record<string, unknown> &
            ChildRuntimeAuthorityCommon &
            ChildRuntimeResidentFields,
        ) &&
        validWriterFence(value.preStopWriterFence, {
          authorityId: value.authorityId,
          tenantId: value.tenantId,
          sessionId: value.sessionId,
          runtimeId: value.runtimeInstanceId,
        }) &&
        canonicalDigest(value.preStopWriterFence) ===
          canonicalDigest(value.childWriterFence)))
  );
}

function seal<T extends ChildRuntimeAuthorityRecordBody>(
  body: T,
): T & { recordDigest: string } {
  const record = {
    ...body,
    recordDigest: childRuntimeAuthorityRecordDigest(body),
  };
  if (!isChildRuntimeAuthorityRecord(record))
    throw new TypeError("child runtime authority record is invalid");
  return record;
}

export function createClaimedChildRuntimeAuthorityRecord(
  input: CreateClaimedChildRuntimeAuthorityRecordInput,
): ClaimedChildRuntimeAuthorityRecord {
  return seal({
    schemaVersion: 1,
    kind: "child_runtime_authority",
    state: "claimed",
    ...input,
  });
}

export function createResidentChildRuntimeAuthorityRecord(input: {
  previous: ClaimedChildRuntimeAuthorityRecord;
  sessionFilePath: string;
  genesisCursor: EventCursor;
  launchReceipt: AgentLaunchReceiptRef;
  residencyReceipt: AgentResidencyReceiptRef;
  childWriterFence: ChildRuntimeWriterFenceReceipt;
  updatedAt: string;
}): ResidentChildRuntimeAuthorityRecord {
  if (
    !isChildRuntimeAuthorityRecord(input.previous) ||
    input.previous.state !== "claimed"
  ) {
    throw new TypeError(
      "resident child runtime requires a claimed authority record",
    );
  }
  const {
    recordDigest: previousRecordDigest,
    state: _state,
    ...common
  } = input.previous;
  return seal({
    ...common,
    state: "resident",
    revision: input.previous.revision + 1,
    previousRecordDigest,
    sessionFilePath: input.sessionFilePath,
    genesisCursor: input.genesisCursor,
    launchReceipt: input.launchReceipt,
    residencyReceipt: input.residencyReceipt,
    childWriterFence: input.childWriterFence,
    updatedAt: input.updatedAt,
  });
}

export function createReleasePendingChildRuntimeAuthorityRecord(input: {
  previous: ResidentChildRuntimeAuthorityRecord;
  releaseRequest: AgentRuntimeReleaseRequest;
  preStopWriterFence: ChildRuntimeWriterFenceReceipt;
  updatedAt: string;
}): ReleasePendingChildRuntimeAuthorityRecord {
  if (
    !isChildRuntimeAuthorityRecord(input.previous) ||
    input.previous.state !== "resident"
  ) {
    throw new TypeError(
      "runtime release intent requires a resident authority record",
    );
  }
  const {
    recordDigest: previousRecordDigest,
    state: _state,
    previousRecordDigest: _older,
    ...common
  } = input.previous;
  return seal({
    ...common,
    state: "release_pending",
    revision: input.previous.revision + 1,
    previousRecordDigest,
    releaseRequest: input.releaseRequest,
    preStopWriterFence: input.preStopWriterFence,
    updatedAt: input.updatedAt,
  });
}

export function createReleasedChildRuntimeAuthorityRecord(input: {
  previous: ReleasePendingChildRuntimeAuthorityRecord;
  releaseReceipt: AgentRuntimeReleaseReceiptRef;
  writerLeaseReleasedEvidence: ChildRuntimeWriterLeaseReleasedEvidence;
  updatedAt: string;
}): ReleasedChildRuntimeAuthorityRecord {
  if (
    !isChildRuntimeAuthorityRecord(input.previous) ||
    input.previous.state !== "release_pending"
  ) {
    throw new TypeError(
      "runtime release completion requires a pending authority record",
    );
  }
  const {
    recordDigest: previousRecordDigest,
    state: _state,
    previousRecordDigest: _older,
    ...common
  } = input.previous;
  return seal({
    ...common,
    state: "released",
    revision: input.previous.revision + 1,
    previousRecordDigest,
    releaseReceipt: input.releaseReceipt,
    writerLeaseReleasedEvidence: input.writerLeaseReleasedEvidence,
    updatedAt: input.updatedAt,
  });
}

export function createQuarantinedChildRuntimeAuthorityRecord(input: {
  previous: ChildRuntimeAuthorityRecord;
  reason: string;
  evidenceDigest: string;
  updatedAt: string;
}): QuarantinedChildRuntimeAuthorityRecord {
  const previous: ChildRuntimeAuthorityRecord = input.previous;
  if (
    !isChildRuntimeAuthorityRecord(previous) ||
    previous.state === "released" ||
    previous.state === "quarantined"
  ) {
    throw new TypeError(
      "terminal child runtime authority record cannot be quarantined again",
    );
  }
  const {
    recordDigest: previousRecordDigest,
    state: _state,
    previousRecordDigest: _older,
    ...common
  } = previous;
  return seal({
    ...common,
    state: "quarantined",
    revision: previous.revision + 1,
    previousRecordDigest,
    reason: input.reason,
    evidenceDigest: input.evidenceDigest,
    updatedAt: input.updatedAt,
  });
}

export type ChildRuntimeColdClassification =
  | { kind: "replay_released"; receipt: AgentRuntimeReleaseReceiptRef }
  | {
      kind: "quarantine";
      observedState: Exclude<ChildRuntimeAuthorityState, "released">;
      takeoverAllowed: false;
    };

/** 首切片只承认完整 released sidecar；partial/active 绝不自动 takeover。 */
export function classifyChildRuntimeColdRecord(
  record: ChildRuntimeAuthorityRecord,
): ChildRuntimeColdClassification {
  if (!isChildRuntimeAuthorityRecord(record))
    throw new TypeError("child runtime authority record is invalid");
  return record.state === "released"
    ? {
        kind: "replay_released",
        receipt: structuredClone(record.releaseReceipt),
      }
    : {
        kind: "quarantine",
        observedState: record.state,
        takeoverAllowed: false,
      };
}

function sameImmutableIdentity(
  left: ChildRuntimeAuthorityRecord,
  right: ChildRuntimeAuthorityRecord,
): boolean {
  const keys = [
    "authorityId",
    "tenantId",
    "principalId",
    "parentSessionId",
    "parentAgentId",
    "parentGraphRevision",
    "parentNodeDigest",
    "agentId",
    "sessionId",
    "workspaceId",
    "runtimeInstanceId",
    "launchRequestId",
    "launchRequestDigest",
    "delegationReceiptDigest",
    "workspaceReceiptDigest",
    "budgetReservationDigest",
    "artifactContractDigest",
    "ownerParentRuntimeId",
  ] as const;
  return (
    keys.every((key) => left[key] === right[key]) &&
    canonicalDigest(left.parentGraphCursor) ===
      canonicalDigest(right.parentGraphCursor) &&
    canonicalDigest(left.ownerParentWriterFence) ===
      canonicalDigest(right.ownerParentWriterFence)
  );
}

function transitionAllowed(
  from: ChildRuntimeAuthorityState,
  to: ChildRuntimeAuthorityState,
): boolean {
  if (from === "claimed") return to === "resident" || to === "quarantined";
  if (from === "resident")
    return to === "release_pending" || to === "quarantined";
  if (from === "release_pending")
    return to === "released" || to === "quarantined";
  return false;
}

export function validateChildRuntimeAuthorityTransition(
  current: ChildRuntimeAuthorityRecord,
  next: ChildRuntimeAuthorityRecord,
): void {
  if (
    !isChildRuntimeAuthorityRecord(current) ||
    !isChildRuntimeAuthorityRecord(next)
  ) {
    throw new TypeError("child runtime authority transition record is invalid");
  }
  if (!sameImmutableIdentity(current, next)) {
    throw new TypeError(
      "child runtime authority transition changed immutable identity",
    );
  }
  if (current.state === "released" || current.state === "quarantined") {
    throw new TypeError(
      `terminal ${current.state} child runtime authority record cannot advance`,
    );
  }
  if (
    !transitionAllowed(current.state, next.state) ||
    next.revision !== current.revision + 1 ||
    next.previousRecordDigest !== current.recordDigest
  ) {
    throw new TypeError(
      "child runtime authority transition skipped its exact previous record or revision",
    );
  }
}

export function matchesChildRuntimeAuthorityExpectation(
  expectedRevision: number,
  expectedRecordDigest: string,
  next: ChildRuntimeAuthorityRecord,
): boolean {
  return (
    next.state !== "claimed" &&
    next.revision === expectedRevision + 1 &&
    next.previousRecordDigest === expectedRecordDigest
  );
}

export class MemoryChildRuntimeAuthorityStore implements ChildRuntimeAuthorityStorePort {
  readonly #records = new Map<AgentId, ChildRuntimeAuthorityRecord>();

  public async read(
    agentId: AgentId,
  ): Promise<ChildRuntimeAuthorityRecord | undefined> {
    const record = this.#records.get(agentId);
    return record ? structuredClone(record) : undefined;
  }

  public async begin(
    record: ChildRuntimeAuthorityRecord,
  ): Promise<"applied" | "replay" | "conflict"> {
    if (!isChildRuntimeAuthorityRecord(record) || record.state !== "claimed") {
      throw new TypeError(
        "child runtime authority begin requires an initial claimed record",
      );
    }
    const current = this.#records.get(record.agentId);
    if (current)
      return current.recordDigest === record.recordDigest
        ? "replay"
        : "conflict";
    this.#records.set(record.agentId, structuredClone(record));
    return "applied";
  }

  public async compareAndSwap(
    agentId: AgentId,
    expectedRevision: number,
    expectedRecordDigest: string,
    next: ChildRuntimeAuthorityRecord,
  ): Promise<"applied" | "replay" | "conflict"> {
    if (
      !isRuntimeId(agentId, "agent") ||
      !Number.isSafeInteger(expectedRevision) ||
      !validDigest(expectedRecordDigest)
    ) {
      throw new TypeError("child runtime authority CAS expectation is invalid");
    }
    if (
      !isChildRuntimeAuthorityRecord(next) ||
      next.agentId !== agentId ||
      next.state === "claimed"
    ) {
      throw new TypeError("child runtime authority CAS candidate is invalid");
    }
    const current = this.#records.get(agentId);
    if (!current) return "conflict";
    if (current.recordDigest === next.recordDigest)
      return matchesChildRuntimeAuthorityExpectation(
        expectedRevision,
        expectedRecordDigest,
        next,
      )
        ? "replay"
        : "conflict";
    if (
      current.revision !== expectedRevision ||
      current.recordDigest !== expectedRecordDigest
    )
      return "conflict";
    validateChildRuntimeAuthorityTransition(current, next);
    this.#records.set(agentId, structuredClone(next));
    return "applied";
  }
}
