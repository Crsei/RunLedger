/** Runtime 公共 contract 的机器可读盘点。 */

export type ContractPersistenceClass =
	| "canonical_durable"
	| "external_authority_ref"
	| "reconstructible_passive"
	| "ephemeral"
	| "forbidden";

export interface ContractInventoryEntry {
	readonly id: string;
	readonly owner: string;
	readonly modules: readonly string[];
	readonly types: readonly string[];
	readonly schemas: readonly string[];
	readonly events: readonly string[];
	readonly ports: readonly string[];
	readonly fixtures: readonly string[];
	readonly persistence: readonly ContractPersistenceClass[];
	readonly gaps: readonly string[];
}

export interface ContractHandoff {
	readonly behavior: string;
	readonly owner: string;
	readonly contracts: readonly string[];
	readonly availability: "external_plan" | "existing_behavior" | "unavailable";
}

export const PERSISTENCE_CLASSES = [
	"canonical_durable",
	"external_authority_ref",
	"reconstructible_passive",
	"ephemeral",
	"forbidden",
] as const satisfies readonly ContractPersistenceClass[];

export const CONTRACT_DIRECTORY_ALLOWLIST = [
	"src/runtime/contracts",
	"src/runtime/protocol",
	"src/runtime/identity",
	"src/runtime/resources",
	"src/runtime/model-routing",
	"src/runtime/modes",
	"src/runtime/context",
] as const;

export const CONTRACT_INVENTORY = [
	{
		id: "foundation",
		owner: "development-doc/runtime/04-governed-agent-harness-runtime-plan.md#contract-foundation",
		modules: [
			"src/runtime/protocol/ids.ts",
			"src/runtime/protocol/canonical-json.ts",
			"src/runtime/protocol/foundation.ts",
			"src/runtime/protocol/foundation-schemas.ts",
			"src/runtime/protocol/errors.ts",
		],
		types: [
			"RuntimeId",
			"RuntimeIdKind",
			"CanonicalJsonValue",
			"RuntimeDigest",
			"RuntimeContentRef",
			"RuntimeRevisionRef",
			"RuntimeStreamHead",
			"RuntimeErrorShape",
			"RuntimeContractError",
		],
		schemas: [
			"parseRuntimeId",
			"isRuntimeId",
			"canonicalJson",
			"canonicalDigest",
			"RuntimeIdSchema",
			"RuntimeDigestSchema",
			"RuntimeContentRefSchema",
			"RuntimeRevisionRefSchema",
			"RuntimeStreamHeadSchema",
			"RuntimeErrorShapeSchema",
		],
		events: [],
		ports: [],
		fixtures: ["tests/runtime-contracts/canonical-json.test.ts", "tests/runtime-contracts/schema.test.ts"],
		persistence: ["canonical_durable", "external_authority_ref"],
		gaps: [],
	},
	{
		id: "identity",
		owner: "development-doc/runtime/04-governed-agent-harness-runtime-plan.md#contract-foundation",
		modules: ["src/runtime/identity/types.ts", "src/runtime/identity/schemas.ts"],
		types: ["IdentityContext"],
		schemas: ["IdentityContextSchema", "isIdentityContext"],
		events: [],
		ports: [],
		fixtures: ["tests/runtime-contracts/schema.test.ts"],
		persistence: ["canonical_durable", "external_authority_ref", "forbidden"],
		gaps: [],
	},
	{
		id: "events",
		owner: "development-doc/runtime/04-governed-agent-harness-runtime-plan.md#contract-events",
		modules: ["src/runtime/protocol/events.ts", "src/runtime/protocol/schemas.ts"],
		types: [
			"RuntimeEventType",
			"RuntimeEventPayloadByType",
			"RuntimeEventEnvelope",
			"RuntimeEvent",
			"RuntimeStreamRef",
			"RuntimeEventRangeRef",
			"DurableEventReceipt",
			"AppendEventOutcome",
		],
		schemas: [
			"RUNTIME_EVENT_PAYLOAD_SCHEMAS",
			"RuntimeEventEnvelopeSchema",
			"DurableEventReceiptSchema",
			"AppendEventOutcomeSchema",
			"RuntimeEventRangeRefSchema",
			"validateRuntimeEvent",
			"assertRuntimeEvent",
		],
		events: ["RUNTIME_EVENT_TYPES"],
		ports: [],
		fixtures: [
			"tests/runtime-contracts/schema.test.ts",
			"tests/runtime-contracts/event-contracts.test.ts",
			"tests/runtime-contracts/event-durability.test.ts",
		],
		persistence: ["canonical_durable", "ephemeral", "forbidden"],
		gaps: [],
	},
	{
		id: "passive-state",
		owner: "development-doc/runtime/04-governed-agent-harness-runtime-plan.md#contract-session",
		modules: [
			"src/runtime/contracts/passive-state.ts",
			"src/runtime/contracts/passive-state-schemas.ts",
		],
		types: [
			"SessionProjection",
			"GoalProjection",
			"TaskProjection",
			"QueueProjection",
			"AgentGraphProjection",
			"RuntimeSnapshotDescriptor",
		],
		schemas: ["RUNTIME_PROJECTION_SCHEMAS", "RuntimeSnapshotDescriptorSchema"],
		events: [],
		ports: [],
		fixtures: ["tests/runtime-contracts/passive-state-contracts.test.ts"],
		persistence: ["reconstructible_passive", "external_authority_ref", "forbidden"],
		gaps: [],
	},
	{
		id: "workspace-security",
		owner: "development-doc/worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md",
		modules: ["src/runtime/protocol/workspace.ts", "src/runtime/protocol/capability.ts"],
		types: [
			"WorkspaceExecutionEnvelope",
			"WorkspaceBindingRef",
			"WorkspaceLeaseRef",
			"WorkspaceValidationReceiptRef",
			"WorkspaceCheckpointDescriptor",
			"CapabilityClaim",
			"CapabilityRequestRef",
			"ApprovalTicket",
			"ApprovalReceiptRef",
			"CredentialGrantRef",
			"SandboxProfileRef",
			"SandboxExecutionReceiptRef",
			"ArtifactRef",
		],
		schemas: ["isWorkspaceExecutionEnvelope"],
		events: ["workspace.*", "permission.*", "sandbox.*", "lease.*"],
		ports: ["WorkspaceServicePort", "CapabilityGatewayPort", "ApprovalCoordinatorPort", "SandboxExecutionPort"],
		fixtures: ["tests/security/current-runtime-boundary.test.ts"],
		persistence: ["canonical_durable", "external_authority_ref", "reconstructible_passive", "forbidden"],
		gaps: ["exact schemas and neutral port DTOs are missing", "absolute workspace paths remain in baseline DTOs"],
	},
	{
		id: "resources",
		owner: "development-doc/plugin-mcp-skill-hooks/01-implementation-plan.md",
		modules: [
			"src/runtime/resources/types.ts",
			"src/runtime/resources/schemas.ts",
			"src/runtime/resources/events.ts",
			"src/runtime/resources/ports.ts",
		],
		types: [
			"ResourceIdentity",
			"ResourceProvenance",
			"ResourceApprovalReceipt",
			"RuntimeToolDescriptor",
			"RuntimeToolInvocation",
			"RuntimeToolResult",
			"ResourceContent",
			"RuntimeResourceSnapshot",
		],
		schemas: ["isResourceIdentity", "isRuntimeToolInvocation"],
		events: ["ResourceLifecycleEvent"],
		ports: [
			"RuntimeResourceCatalogPort",
			"RuntimeResourceInvocationPort",
			"RuntimeResourceEventSink",
			"RuntimeResourceSnapshotProvider",
		],
		fixtures: ["tests/runtime-contracts/resource-contracts/contracts.test.ts"],
		persistence: ["canonical_durable", "external_authority_ref", "reconstructible_passive", "ephemeral", "forbidden"],
		gaps: ["resource guards are not exact", "content and search results are not bounded", "ports expose non-uniform outcomes"],
	},
	{
		id: "model-routing",
		owner: "development-doc/plan-compact-memory/01-implementation-plan.md",
		modules: ["src/runtime/model-routing/types.ts", "src/runtime/model-routing/schema.ts"],
		types: ["ModelCapabilityProfile", "ModelRouteRequest", "ModelRouteDecision"],
		schemas: ["isModelRouteDecision"],
		events: ["model.routed"],
		ports: ["ModelStreamPort"],
		fixtures: ["tests/runtime-contracts/plan-context-memory/contract-consumer.test.ts"],
		persistence: ["canonical_durable", "external_authority_ref", "reconstructible_passive"],
		gaps: ["profile, request, and decision exact schemas are missing", "route correlation refs are incomplete"],
	},
	{
		id: "plan-mode",
		owner: "development-doc/plan-compact-memory/01-implementation-plan.md",
		modules: ["src/runtime/modes/plan/types.ts", "src/runtime/modes/plan/schema.ts"],
		types: ["PlanArtifactRef", "PlanApprovalRef", "PlanModeState"],
		schemas: ["isPlanModeState"],
		events: ["plan lifecycle catalog pending"],
		ports: [],
		fixtures: ["tests/runtime-contracts/plan-context-memory/contract-consumer.test.ts"],
		persistence: ["canonical_durable", "external_authority_ref", "reconstructible_passive"],
		gaps: ["plan refs and state exact schemas are missing", "event names are not frozen"],
	},
	{
		id: "context",
		owner: "development-doc/plan-compact-memory/01-implementation-plan.md",
		modules: ["src/runtime/context/types.ts", "src/runtime/context/schema.ts"],
		types: ["ContextFragment", "ContextAssemblyRequest", "ContextAssemblyReceipt"],
		schemas: ["isContextAssemblyReceipt"],
		events: ["context.assembled"],
		ports: [],
		fixtures: ["tests/runtime-contracts/plan-context-memory/contract-consumer.test.ts"],
		persistence: ["canonical_durable", "reconstructible_passive", "ephemeral", "forbidden"],
		gaps: ["context DTO schemas and content bounds are missing", "raw fragment content is still inline"],
	},
	{
		id: "compaction",
		owner: "development-doc/plan-compact-memory/01-implementation-plan.md",
		modules: ["src/runtime/context/compaction/types.ts", "src/runtime/context/compaction/schema.ts"],
		types: ["CompactionCheckpoint"],
		schemas: ["isCompactionCheckpoint"],
		events: ["compaction.started", "compaction.completed", "compaction.failed"],
		ports: [],
		fixtures: ["tests/runtime-contracts/plan-context-memory/contract-consumer.test.ts"],
		persistence: ["canonical_durable", "reconstructible_passive", "external_authority_ref"],
		gaps: ["checkpoint schema is not exact", "source event range and terminal receipt are missing"],
	},
	{
		id: "memory",
		owner: "development-doc/plan-compact-memory/01-implementation-plan.md",
		modules: ["src/runtime/context/memory/types.ts", "src/runtime/context/memory/schema.ts"],
		types: ["MemoryRecord", "MemoryProposal", "MemorySearchReceipt"],
		schemas: ["isMemoryRecord", "isMemorySearchReceipt"],
		events: ["memory.proposed", "memory.approved", "memory.revoked"],
		ports: [],
		fixtures: ["tests/runtime-contracts/plan-context-memory/contract-consumer.test.ts"],
		persistence: ["canonical_durable", "reconstructible_passive", "forbidden"],
		gaps: ["memory schemas are not exact", "body content remains inline and unbounded"],
	},
	{
		id: "user-home-layout",
		owner: "development-doc/runtime/04-governed-agent-harness-runtime-plan.md#contract-persistence",
		modules: ["src/runtime/contracts/storage-layout.ts"],
		types: ["RunledgerHomeResolution", "RunledgerLayout", "RuntimeLocator"],
		schemas: ["RuntimeLocatorSchema", "isRuntimeLocator"],
		events: [],
		ports: [],
		fixtures: ["tests/runtime-contracts/storage-layout-contracts.test.ts"],
		persistence: ["canonical_durable", "external_authority_ref", "reconstructible_passive", "ephemeral", "forbidden"],
		gaps: [],
	},
	{
		id: "control-telemetry",
		owner: "development-doc/runtime/04-governed-agent-harness-runtime-plan.md#contract-control-telemetry",
		modules: [],
		types: [],
		schemas: [],
		events: [
			"command.*",
			"runtime.*",
			"policy.*",
			"cost.*",
			"telemetry.*",
		],
		ports: ["RuntimeEventStorePort", "RuntimeEventSubscriptionPort", "TelemetryExporterPort", "RemoteExecutorPort"],
		fixtures: [],
		persistence: ["canonical_durable", "external_authority_ref", "reconstructible_passive", "ephemeral", "forbidden"],
		gaps: ["passive DTOs, event payloads, ports, and fixtures are missing"],
	},
] as const satisfies readonly ContractInventoryEntry[];

export const CONTRACT_HANDOFFS = [
	{
		behavior: "Plugin, MCP, Skill, and Hook discovery, trust, process, and control",
		owner: "development-doc/plugin-mcp-skill-hooks/01-implementation-plan.md",
		contracts: ["resources"],
		availability: "external_plan",
	},
	{
		behavior: "Workspace, permission, approval, credential, gateway, and sandbox",
		owner: "development-doc/worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md",
		contracts: ["workspace-security"],
		availability: "external_plan",
	},
	{
		behavior: "Model routing, plan, context, compaction, and memory",
		owner: "development-doc/plan-compact-memory/01-implementation-plan.md",
		contracts: ["model-routing", "plan-mode", "context", "compaction", "memory"],
		availability: "external_plan",
	},
	{
		behavior: "Provider, API, authentication, and model catalog",
		owner: "development-doc/providers/01-pi-ai-migration-plan.md",
		contracts: ["model-routing", "context"],
		availability: "existing_behavior",
	},
	{
		behavior: "Agent loop, Agent, ledger, and standard tools",
		owner: "development-doc/runtime/01-minimum-runtime-scaffold-plan.md",
		contracts: ["events", "workspace-security", "resources"],
		availability: "existing_behavior",
	},
	{
		behavior: "User home creation, legacy import, and CLI option deprecation",
		owner: "development-doc/storage-cli/01-project-layout-cli-plan.md",
		contracts: ["user-home-layout"],
		availability: "external_plan",
	},
	{
		behavior: "Event store writer, replay, reducer, and recovery",
		owner: "no authorized behavior plan",
		contracts: ["events", "control-telemetry"],
		availability: "unavailable",
	},
	{
		behavior: "Artifact CAS, redaction, retention, and garbage collection",
		owner: "no authorized behavior plan",
		contracts: ["workspace-security", "control-telemetry"],
		availability: "unavailable",
	},
	{
		behavior: "Orchestration, verification, and multi-agent execution",
		owner: "no authorized behavior plan",
		contracts: ["events", "control-telemetry"],
		availability: "unavailable",
	},
	{
		behavior: "Daemon, control plane, forge, and human gates",
		owner: "no authorized behavior plan",
		contracts: ["control-telemetry"],
		availability: "unavailable",
	},
	{
		behavior: "Telemetry export, remote execution, and lifecycle services",
		owner: "no authorized behavior plan",
		contracts: ["control-telemetry"],
		availability: "unavailable",
	},
	{
		behavior: "TUI, CLI, IDE, and CI clients",
		owner: "product-specific plans",
		contracts: ["events", "resources", "control-telemetry"],
		availability: "external_plan",
	},
] as const satisfies readonly ContractHandoff[];
