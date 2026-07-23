/** Child runtime 外部 effect 的私有 authority sidecar 合同。 */

import { isAbsolute, resolve } from "node:path";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId } from "../protocol/v3/ids.ts";
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
  | "claimed"
  | "creating"
  | "provisional"
  | "resident"
  | "release_pending"
  | "released"
  | "quarantined";

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

interface ChildRuntimeActivationEvidenceCommon {
  activationType: "launch" | "resume";
  requestId: CommandId;
  requestDigest: string;
  parentGraphRevision: number;
  parentGraphCursor: EventCursor;
  parentNodeDigest: string;
  delegationReceiptDigest: string;
  workspaceReceiptDigest: string;
  budgetReservationDigest: string;
  ownerParentWriterFence: ChildRuntimeWriterFenceReceipt;
  evidenceDigest: string;
}

export interface ChildRuntimeLaunchActivationEvidence
  extends ChildRuntimeActivationEvidenceCommon {
  activationType: "launch";
}

export interface ChildRuntimeResumeActivationEvidence
  extends ChildRuntimeActivationEvidenceCommon {
  activationType: "resume";
}

export type ChildRuntimeActivationEvidence =
  | ChildRuntimeLaunchActivationEvidence
  | ChildRuntimeResumeActivationEvidence;

type WithoutEvidenceDigest<T> = T extends unknown
  ? Omit<T, "evidenceDigest">
  : never;

export type ChildRuntimeActivationEvidenceBody =
  WithoutEvidenceDigest<ChildRuntimeActivationEvidence>;

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
  agentId: AgentId;
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  runtimeInstanceId: RuntimeInstanceId;
  sessionFilePath: string;
  claimAttemptId: CommandId;
  launchRequestId: CommandId;
  launchRequestDigest: string;
  artifactContractDigest: string;
  ownerParentRuntimeId: RuntimeInstanceId;
  initialActivationEvidence: ChildRuntimeLaunchActivationEvidence;
  activationEvidence: ChildRuntimeActivationEvidence;
  updatedAt: string;
}

export interface ClaimedChildRuntimeAuthorityRecord extends ChildRuntimeAuthorityCommon {
  state: "claimed";
  recordDigest: string;
}

interface ChildRuntimeCreatingFields {
  createStartedAt: string;
}

export interface CreatingChildRuntimeAuthorityRecord
  extends ChildRuntimeAuthorityCommon, ChildRuntimeCreatingFields {
  state: "creating";
  previousRecordDigest: string;
  recordDigest: string;
}

interface ChildRuntimeProvisionalFields {
  launchReceipt: AgentLaunchReceiptRef;
  residencyReceipt: AgentResidencyReceiptRef;
  childWriterFence: ChildRuntimeWriterFenceReceipt;
}

export interface ProvisionalChildRuntimeAuthorityRecord
  extends
    ChildRuntimeAuthorityCommon,
    ChildRuntimeCreatingFields,
    ChildRuntimeProvisionalFields {
  state: "provisional";
  previousRecordDigest: string;
  recordDigest: string;
}

interface ChildRuntimeResidentFields
  extends ChildRuntimeCreatingFields, ChildRuntimeProvisionalFields {
  genesisCursor: EventCursor;
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
  createStartedAt?: string;
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
  | CreatingChildRuntimeAuthorityRecord
  | ProvisionalChildRuntimeAuthorityRecord
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
  /**
   * 在 authority root 排他 fence 内完成有界全量审计与同步判定。
   * audit 不得重入同一 store 的 read/list/begin/CAS。
   */
  withExclusiveRootAudit<T>(
    audit: (
      records: readonly ChildRuntimeAuthorityRecord[],
    ) => T | Promise<T>,
  ): Promise<T>;
  /** 有界 authority root 的便利只读视图。 */
  list(): Promise<readonly ChildRuntimeAuthorityRecord[]>;
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
  | "schemaVersion"
  | "kind"
  | "state"
  | "claimAttemptId"
  | "recordDigest"
>;

/** activation evidence 自带完整 canonical seal，外层 record digest 再覆盖一次。 */
export function createChildRuntimeActivationEvidence(
  input: ChildRuntimeActivationEvidenceBody,
): ChildRuntimeActivationEvidence {
  return {
    ...input,
    evidenceDigest: canonicalDigest(input),
  } as ChildRuntimeActivationEvidence;
}

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

function validActivationEvidence(
  value: unknown,
  expected: {
    authorityId: AuthorityId;
    tenantId: TenantId;
    parentSessionId: SessionId;
    ownerParentRuntimeId: RuntimeInstanceId;
  },
): value is ChildRuntimeActivationEvidence {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "activationType",
      "requestId",
      "requestDigest",
      "parentGraphRevision",
      "parentGraphCursor",
      "parentNodeDigest",
      "delegationReceiptDigest",
      "workspaceReceiptDigest",
      "budgetReservationDigest",
      "ownerParentWriterFence",
      "evidenceDigest",
    ])
  )
    return false;
  const { evidenceDigest, ...body } = value;
  return (
    (value.activationType === "launch" ||
      value.activationType === "resume") &&
    isRuntimeId(value.requestId, "command") &&
    validDigest(value.requestDigest) &&
    Number.isSafeInteger(value.parentGraphRevision) &&
    Number(value.parentGraphRevision) >= 1 &&
    validCursor(value.parentGraphCursor, {
      authorityId: expected.authorityId,
      tenantId: expected.tenantId,
      sessionId: expected.parentSessionId,
    }) &&
    validDigest(value.parentNodeDigest) &&
    validDigest(value.delegationReceiptDigest) &&
    validDigest(value.workspaceReceiptDigest) &&
    validDigest(value.budgetReservationDigest) &&
    validWriterFence(value.ownerParentWriterFence, {
      authorityId: expected.authorityId,
      tenantId: expected.tenantId,
      sessionId: expected.parentSessionId,
      runtimeId: expected.ownerParentRuntimeId,
    }) &&
    validDigest(evidenceDigest) &&
    evidenceDigest === canonicalDigest(body)
  );
}

function writerFenceIsFreshAt(
  fence: ChildRuntimeWriterFenceReceipt,
  timestamp: string,
): boolean {
  return Date.parse(fence.expiresAt) > Date.parse(timestamp);
}

function sameWriterFenceIdentity(
  left: ChildRuntimeWriterFenceReceipt,
  right: ChildRuntimeWriterFenceReceipt,
): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.tenantId === right.tenantId &&
    left.sessionId === right.sessionId &&
    left.runtimeId === right.runtimeId &&
    canonicalDigest(left.stream) === canonicalDigest(right.stream) &&
    left.leaseId === right.leaseId &&
    left.writerEpoch === right.writerEpoch &&
    left.fencingTokenDigest === right.fencingTokenDigest &&
    left.acquiredAt === right.acquiredAt
  );
}

function writerFenceMonotonicallyRefreshes(
  previous: ChildRuntimeWriterFenceReceipt,
  next: ChildRuntimeWriterFenceReceipt,
): boolean {
  return (
    sameWriterFenceIdentity(previous, next) &&
    Date.parse(next.expiresAt) >= Date.parse(previous.expiresAt)
  );
}

function validActivationProgression(
  initial: ChildRuntimeLaunchActivationEvidence,
  current: ChildRuntimeActivationEvidence,
): boolean {
  if (current.activationType === "launch")
    return canonicalDigest(current) === canonicalDigest(initial);
  return (
    current.requestId !== initial.requestId &&
    current.parentGraphRevision > initial.parentGraphRevision &&
    canonicalDigest(current.parentGraphCursor.stream) ===
      canonicalDigest(initial.parentGraphCursor.stream) &&
    current.parentGraphCursor.sequence > initial.parentGraphCursor.sequence &&
    writerFenceMonotonicallyRefreshes(
      initial.ownerParentWriterFence,
      current.ownerParentWriterFence,
    )
  );
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
  "agentId",
  "sessionId",
  "workspaceId",
  "runtimeInstanceId",
  "sessionFilePath",
  "claimAttemptId",
  "launchRequestId",
  "launchRequestDigest",
  "artifactContractDigest",
  "ownerParentRuntimeId",
  "initialActivationEvidence",
  "activationEvidence",
  "updatedAt",
  "recordDigest",
] as const;

const CREATING_KEYS = ["createStartedAt"] as const;

const PROVISIONAL_KEYS = [
  "launchReceipt",
  "residencyReceipt",
  "childWriterFence",
] as const;

const RESIDENT_KEYS = ["genesisCursor"] as const;

const RELEASE_PENDING_KEYS = ["releaseRequest", "preStopWriterFence"] as const;

function validCommon(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ChildRuntimeAuthorityCommon {
  return (
    value.schemaVersion === 1 &&
    value.kind === "child_runtime_authority" &&
    [
      "claimed",
      "creating",
      "provisional",
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
    isRuntimeId(value.agentId, "agent") &&
    isRuntimeId(value.sessionId, "session") &&
    value.sessionId !== value.parentSessionId &&
    isRuntimeId(value.workspaceId, "workspace") &&
    isRuntimeId(value.runtimeInstanceId, "runtime") &&
    typeof value.sessionFilePath === "string" &&
    isAbsolute(value.sessionFilePath) &&
    resolve(value.sessionFilePath) === value.sessionFilePath &&
    !value.sessionFilePath.includes("\0") &&
    isRuntimeId(value.claimAttemptId, "command") &&
    isRuntimeId(value.launchRequestId, "command") &&
    value.claimAttemptId !== value.launchRequestId &&
    validDigest(value.launchRequestDigest) &&
    validDigest(value.artifactContractDigest) &&
    isRuntimeId(value.ownerParentRuntimeId, "runtime") &&
    validTimestamp(value.updatedAt) &&
    validActivationEvidence(value.initialActivationEvidence, {
      authorityId: value.authorityId as AuthorityId,
      tenantId: value.tenantId as TenantId,
      parentSessionId: value.parentSessionId as SessionId,
      ownerParentRuntimeId: value.ownerParentRuntimeId as RuntimeInstanceId,
    }) &&
    value.initialActivationEvidence.activationType === "launch" &&
    value.initialActivationEvidence.requestId === value.launchRequestId &&
    value.initialActivationEvidence.requestDigest === value.launchRequestDigest &&
    validActivationEvidence(value.activationEvidence, {
      authorityId: value.authorityId as AuthorityId,
      tenantId: value.tenantId as TenantId,
      parentSessionId: value.parentSessionId as SessionId,
      ownerParentRuntimeId: value.ownerParentRuntimeId as RuntimeInstanceId,
    }) &&
    validActivationProgression(
      value.initialActivationEvidence,
      value.activationEvidence,
    )
  );
}

function validCreatingFields(
  value: Record<string, unknown> & ChildRuntimeAuthorityCommon,
): value is typeof value & ChildRuntimeCreatingFields {
  return (
    validTimestamp(value.createStartedAt) &&
    Date.parse(value.createStartedAt) <= Date.parse(value.updatedAt) &&
    writerFenceIsFreshAt(
      value.activationEvidence.ownerParentWriterFence,
      value.createStartedAt,
    )
  );
}

function validProvisionalFields(
  value: Record<string, unknown> & ChildRuntimeAuthorityCommon,
): value is typeof value &
  ChildRuntimeCreatingFields &
  ChildRuntimeProvisionalFields {
  return (
    validCreatingFields(value) &&
    validLaunchReceipt(value.launchReceipt, value) &&
    validResidencyReceipt(value.residencyReceipt, value, "resident") &&
    value.residencyReceipt.revision === value.launchReceipt.launchRevision &&
    writerFenceIsFreshAt(
      value.activationEvidence.ownerParentWriterFence,
      value.launchReceipt.launchedAt,
    ) &&
    validWriterFence(value.childWriterFence, {
      authorityId: value.authorityId,
      tenantId: value.tenantId,
      sessionId: value.sessionId,
      runtimeId: value.runtimeInstanceId,
    })
  );
}

function validResidentFields(
  value: Record<string, unknown> & ChildRuntimeAuthorityCommon,
): value is typeof value & ChildRuntimeResidentFields {
  return (
    validProvisionalFields(value) &&
    validCursor(value.genesisCursor, {
      authorityId: value.authorityId,
      tenantId: value.tenantId,
      sessionId: value.sessionId,
    }) &&
    value.genesisCursor.sequence === 0
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
    return (
      value.revision === 1 &&
      exactKeys(value, COMMON_KEYS) &&
      value.activationEvidence.activationType === "launch" &&
      writerFenceIsFreshAt(
        value.activationEvidence.ownerParentWriterFence,
        value.updatedAt,
      ) &&
      canonicalDigest(value.activationEvidence) ===
        canonicalDigest(value.initialActivationEvidence)
    );
  }
  if (value.state === "creating") {
    return (
      value.revision === 2 &&
      exactKeys(value, [
        ...COMMON_KEYS,
        "previousRecordDigest",
        ...CREATING_KEYS,
      ]) &&
      value.activationEvidence.activationType === "launch" &&
      validCreatingFields(value)
    );
  }
  if (value.state === "provisional") {
    return (
      value.revision === 3 &&
      exactKeys(value, [
        ...COMMON_KEYS,
        "previousRecordDigest",
        ...CREATING_KEYS,
        ...PROVISIONAL_KEYS,
      ]) &&
      value.activationEvidence.activationType === "launch" &&
      validProvisionalFields(value)
    );
  }
  if (value.state === "resident") {
    return (
      value.revision >= 4 &&
      exactKeys(value, [
        ...COMMON_KEYS,
        "previousRecordDigest",
        ...CREATING_KEYS,
        ...PROVISIONAL_KEYS,
        ...RESIDENT_KEYS,
      ]) &&
      validResidentFields(value) &&
      (value.revision !== 4 ||
        value.activationEvidence.activationType === "launch")
    );
  }
  if (value.state === "release_pending") {
    return (
      value.revision >= 5 &&
      exactKeys(value, [
        ...COMMON_KEYS,
        "previousRecordDigest",
        ...CREATING_KEYS,
        ...PROVISIONAL_KEYS,
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
      writerFenceMonotonicallyRefreshes(
        value.childWriterFence,
        value.preStopWriterFence,
      )
    );
  }
  if (value.state === "released") {
    return (
      value.revision >= 6 &&
      exactKeys(value, [
        ...COMMON_KEYS,
        "previousRecordDigest",
        ...CREATING_KEYS,
        ...PROVISIONAL_KEYS,
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
      writerFenceMonotonicallyRefreshes(
        value.childWriterFence,
        value.preStopWriterFence,
      ) &&
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

  const hasCreating = Object.hasOwn(value, "createStartedAt");
  const hasProvisional = Object.hasOwn(value, "launchReceipt");
  const hasResident = Object.hasOwn(value, "genesisCursor");
  const hasPending = Object.hasOwn(value, "releaseRequest");
  const optional = [
    "previousRecordDigest",
    "reason",
    "evidenceDigest",
    ...(hasCreating ? CREATING_KEYS : []),
    ...(hasProvisional ? PROVISIONAL_KEYS : []),
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
    (!hasCreating || validCreatingFields(value)) &&
    (!hasProvisional ||
      (hasCreating && validProvisionalFields(value))) &&
    (!hasResident ||
      (hasProvisional && validResidentFields(value))) &&
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
        writerFenceMonotonicallyRefreshes(
          (
            value as Record<string, unknown> &
              ChildRuntimeAuthorityCommon &
              ChildRuntimeResidentFields
          ).childWriterFence,
          value.preStopWriterFence,
        )))
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
    ...input,
    schemaVersion: 1,
    kind: "child_runtime_authority",
    state: "claimed",
    claimAttemptId: createRuntimeId("command"),
  });
}

export function createCreatingChildRuntimeAuthorityRecord(input: {
  previous: ClaimedChildRuntimeAuthorityRecord;
  createStartedAt: string;
  updatedAt: string;
}): CreatingChildRuntimeAuthorityRecord {
  if (
    !isChildRuntimeAuthorityRecord(input.previous) ||
    input.previous.state !== "claimed"
  ) {
    throw new TypeError(
      "creating child runtime requires a claimed authority record",
    );
  }
  const {
    recordDigest: previousRecordDigest,
    state: _state,
    ...common
  } = input.previous;
  const creating = seal({
    ...common,
    state: "creating",
    revision: input.previous.revision + 1,
    previousRecordDigest,
    createStartedAt: input.createStartedAt,
    updatedAt: input.updatedAt,
  });
  validateChildRuntimeAuthorityTransition(input.previous, creating);
  return creating;
}

export function createProvisionalChildRuntimeAuthorityRecord(input: {
  previous: CreatingChildRuntimeAuthorityRecord;
  launchReceipt: AgentLaunchReceiptRef;
  residencyReceipt: AgentResidencyReceiptRef;
  childWriterFence: ChildRuntimeWriterFenceReceipt;
  updatedAt: string;
}): ProvisionalChildRuntimeAuthorityRecord {
  if (
    !isChildRuntimeAuthorityRecord(input.previous) ||
    input.previous.state !== "creating"
  ) {
    throw new TypeError(
      "provisional child runtime requires a creating authority record",
    );
  }
  const {
    recordDigest: previousRecordDigest,
    state: _state,
    previousRecordDigest: _older,
    ...common
  } = input.previous;
  const provisional = seal({
    ...common,
    state: "provisional",
    revision: input.previous.revision + 1,
    previousRecordDigest,
    launchReceipt: input.launchReceipt,
    residencyReceipt: input.residencyReceipt,
    childWriterFence: input.childWriterFence,
    updatedAt: input.updatedAt,
  });
  validateChildRuntimeAuthorityTransition(input.previous, provisional);
  return provisional;
}

export function createResidentChildRuntimeAuthorityRecord(input: {
  previous: ProvisionalChildRuntimeAuthorityRecord;
  genesisCursor: EventCursor;
  updatedAt: string;
}): ResidentChildRuntimeAuthorityRecord {
  if (
    !isChildRuntimeAuthorityRecord(input.previous) ||
    input.previous.state !== "provisional"
  ) {
    throw new TypeError(
      "resident child runtime requires a provisional authority record",
    );
  }
  const {
    recordDigest: previousRecordDigest,
    state: _state,
    previousRecordDigest: _older,
    ...common
  } = input.previous;
  const resident = seal({
    ...common,
    state: "resident",
    revision: input.previous.revision + 1,
    previousRecordDigest,
    genesisCursor: input.genesisCursor,
    updatedAt: input.updatedAt,
  });
  validateChildRuntimeAuthorityTransition(input.previous, resident);
  return resident;
}

/** 同一 runtime 的 resume 只推进 launch/residency revision，不改变 session/fence 身份。 */
export function createResumedChildRuntimeAuthorityRecord(input: {
  previous: ResidentChildRuntimeAuthorityRecord;
  activationEvidence: ChildRuntimeResumeActivationEvidence;
  launchReceipt: AgentLaunchReceiptRef;
  residencyReceipt: AgentResidencyReceiptRef;
  childWriterFence: ChildRuntimeWriterFenceReceipt;
  updatedAt: string;
}): ResidentChildRuntimeAuthorityRecord {
  if (
    !isChildRuntimeAuthorityRecord(input.previous) ||
    input.previous.state !== "resident"
  ) {
    throw new TypeError(
      "resumed child runtime requires a resident authority record",
    );
  }
  const {
    recordDigest: previousRecordDigest,
    previousRecordDigest: _older,
    ...common
  } = input.previous;
  const resumed = seal({
    ...common,
    revision: input.previous.revision + 1,
    previousRecordDigest,
    activationEvidence: input.activationEvidence,
    launchReceipt: input.launchReceipt,
    residencyReceipt: input.residencyReceipt,
    childWriterFence: input.childWriterFence,
    updatedAt: input.updatedAt,
  });
  validateChildRuntimeAuthorityTransition(input.previous, resumed);
  return resumed;
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
  provisionalEvidence?: {
    launchReceipt: AgentLaunchReceiptRef;
    residencyReceipt: AgentResidencyReceiptRef;
    childWriterFence: ChildRuntimeWriterFenceReceipt;
  };
  genesisCursor?: EventCursor;
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
  if (
    (input.provisionalEvidence !== undefined &&
      "launchReceipt" in previous) ||
    (input.genesisCursor !== undefined && "genesisCursor" in previous)
  ) {
    throw new TypeError(
      "child runtime quarantine evidence cannot replace durable evidence",
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
    ...(input.provisionalEvidence ?? {}),
    ...(input.genesisCursor
      ? { genesisCursor: input.genesisCursor }
      : {}),
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
    "agentId",
    "sessionId",
    "workspaceId",
    "runtimeInstanceId",
    "sessionFilePath",
    "claimAttemptId",
    "launchRequestId",
    "launchRequestDigest",
    "artifactContractDigest",
    "ownerParentRuntimeId",
  ] as const;
  return (
    keys.every((key) => left[key] === right[key]) &&
    canonicalDigest(left.initialActivationEvidence) ===
      canonicalDigest(right.initialActivationEvidence)
  );
}

function preservesAccumulatedRuntimeEvidence(
  current: ChildRuntimeAuthorityRecord,
  next: ChildRuntimeAuthorityRecord,
  isResume: boolean,
): boolean {
  if (next.state === "quarantined") {
    const currentHasCreating = Object.hasOwn(current, "createStartedAt");
    const nextHasCreating = Object.hasOwn(next, "createStartedAt");
    const currentHasProvisional = Object.hasOwn(current, "launchReceipt");
    const nextHasProvisional = Object.hasOwn(next, "launchReceipt");
    const currentHasGenesis = Object.hasOwn(current, "genesisCursor");
    const nextHasGenesis = Object.hasOwn(next, "genesisCursor");
    const currentHasRelease = Object.hasOwn(current, "releaseRequest");
    const nextHasRelease = Object.hasOwn(next, "releaseRequest");
    if (
      currentHasCreating !== nextHasCreating ||
      (currentHasProvisional !== nextHasProvisional &&
        !(current.state === "creating" && nextHasProvisional)) ||
      (currentHasGenesis !== nextHasGenesis &&
        !(current.state === "provisional" && nextHasGenesis)) ||
      currentHasRelease !== nextHasRelease
    ) {
      return false;
    }
  }
  if (
    "createStartedAt" in current &&
    (!("createStartedAt" in next) ||
      next.createStartedAt !== current.createStartedAt)
  ) {
    return false;
  }
  if (
    "launchReceipt" in current &&
    (!("launchReceipt" in next) ||
      (!isResume &&
        (canonicalDigest(next.launchReceipt) !==
          canonicalDigest(current.launchReceipt) ||
          canonicalDigest(next.residencyReceipt) !==
            canonicalDigest(current.residencyReceipt) ||
          canonicalDigest(next.childWriterFence) !==
            canonicalDigest(current.childWriterFence))))
  ) {
    return false;
  }
  if (
    "genesisCursor" in current &&
    (!("genesisCursor" in next) ||
      canonicalDigest(next.genesisCursor) !==
        canonicalDigest(current.genesisCursor))
  ) {
    return false;
  }
  if (
    "releaseRequest" in current &&
    (!("releaseRequest" in next) ||
      canonicalDigest(next.releaseRequest) !==
        canonicalDigest(current.releaseRequest) ||
      canonicalDigest(next.preStopWriterFence) !==
        canonicalDigest(current.preStopWriterFence))
  ) {
    return false;
  }
  return true;
}

function transitionAllowed(
  from: ChildRuntimeAuthorityState,
  to: ChildRuntimeAuthorityState,
): boolean {
  if (from === "claimed") return to === "creating" || to === "quarantined";
  if (from === "creating")
    return to === "provisional" || to === "quarantined";
  if (from === "provisional")
    return to === "resident" || to === "quarantined";
  if (from === "resident")
    return (
      to === "resident" ||
      to === "release_pending" ||
      to === "quarantined"
    );
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
  const isResume =
    current.state === "resident" && next.state === "resident";
  if (!preservesAccumulatedRuntimeEvidence(current, next, isResume)) {
    throw new TypeError(
      "child runtime authority transition changed accumulated runtime evidence",
    );
  }
  if (
    current.state === "claimed" &&
    next.state === "creating" &&
    (next.createStartedAt !== next.updatedAt ||
      Date.parse(next.createStartedAt) < Date.parse(current.updatedAt))
  ) {
    throw new TypeError(
      "child runtime create boundary has an invalid start timestamp",
    );
  }
  if (
    !isResume &&
    canonicalDigest(current.activationEvidence) !==
      canonicalDigest(next.activationEvidence)
  ) {
    throw new TypeError(
      "child runtime authority transition changed activation evidence",
    );
  }
  if (
    isResume &&
    (current.sessionFilePath !== next.sessionFilePath ||
      canonicalDigest(current.genesisCursor) !==
        canonicalDigest(next.genesisCursor) ||
      !writerFenceMonotonicallyRefreshes(
        current.childWriterFence,
        next.childWriterFence,
      ) ||
      next.activationEvidence.activationType !== "resume" ||
      next.activationEvidence.requestId ===
        current.activationEvidence.requestId ||
      next.activationEvidence.parentGraphRevision <=
        current.activationEvidence.parentGraphRevision ||
      canonicalDigest(next.activationEvidence.parentGraphCursor.stream) !==
        canonicalDigest(current.activationEvidence.parentGraphCursor.stream) ||
      next.activationEvidence.parentGraphCursor.sequence <=
        current.activationEvidence.parentGraphCursor.sequence ||
      !writerFenceMonotonicallyRefreshes(
        current.activationEvidence.ownerParentWriterFence,
        next.activationEvidence.ownerParentWriterFence,
      ) ||
      next.launchReceipt.launchRevision !==
        current.launchReceipt.launchRevision + 1 ||
      next.residencyReceipt.revision !==
        current.residencyReceipt.revision + 1)
  ) {
    throw new TypeError(
      "resumed child runtime changed its durable session or skipped its launch revision",
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
  #rootFence: Promise<void> = Promise.resolve();

  async #exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#rootFence;
    let release!: () => void;
    this.#rootFence = new Promise<void>((resolveFence) => {
      release = resolveFence;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #snapshot(): readonly ChildRuntimeAuthorityRecord[] {
    return [...this.#records.values()]
      .sort((left, right) => left.agentId.localeCompare(right.agentId))
      .map((record) => structuredClone(record));
  }

  public async read(
    agentId: AgentId,
  ): Promise<ChildRuntimeAuthorityRecord | undefined> {
    return this.#exclusive(() => {
      const record = this.#records.get(agentId);
      return record ? structuredClone(record) : undefined;
    });
  }

  public async withExclusiveRootAudit<T>(
    audit: (
      records: readonly ChildRuntimeAuthorityRecord[],
    ) => T | Promise<T>,
  ): Promise<T> {
    return this.#exclusive(() => audit(this.#snapshot()));
  }

  public async list(): Promise<readonly ChildRuntimeAuthorityRecord[]> {
    return this.withExclusiveRootAudit((records) => records);
  }

  public async begin(
    record: ChildRuntimeAuthorityRecord,
  ): Promise<"applied" | "replay" | "conflict"> {
    if (!isChildRuntimeAuthorityRecord(record) || record.state !== "claimed") {
      throw new TypeError(
        "child runtime authority begin requires an initial claimed record",
      );
    }
    return this.#exclusive(() => {
      const current = this.#records.get(record.agentId);
      if (current)
        return current.recordDigest === record.recordDigest
          ? "replay"
          : "conflict";
      this.#records.set(record.agentId, structuredClone(record));
      return "applied";
    });
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
    return this.#exclusive(() => {
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
    });
  }
}
