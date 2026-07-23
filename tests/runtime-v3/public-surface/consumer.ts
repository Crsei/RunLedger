import {
	controlPlane,
	daemon,
	enterpriseIdentity,
	governedAgents,
	lifecycle,
	MODEL_ROUTING_CONTRACT_VERSION,
	ModelSwitchConversionReceiptSchema,
	orchestrator,
	remoteExecutors,
	telemetry,
	verification,
	verificationRunner,
	CompactionRecoveryAssessmentSchema,
	type CompactionRecoveryAssessment,
	type ModelSwitchConversionReceipt,
} from "runledger";
import { AgentSupervisor } from "runledger/runtime/agents";
import { ControlPlaneCommandBus } from "runledger/runtime/control-plane";
import type { RemoteExecutorPort } from "runledger/runtime/executors";
import { EnterprisePrincipalRefSchema } from "runledger/runtime/identity/enterprise";
import type { RuntimeDependencyReadinessReceipt } from "runledger/runtime/integration/dependency-readiness";
import { RuntimeShutdownCoordinator } from "runledger/runtime/lifecycle";
import {
	DurableGoalStateMachine,
	SessionDurableOrchestratorJournal,
} from "runledger/runtime/orchestrator";
import { projectRuntimeActivity } from "runledger/runtime/telemetry";
import {
	VERIFICATION_REPORT_MEDIA_TYPE,
	VerificationPipeline,
	VerificationSessionRuntime,
	type VerificationSessionRuntimeOptions,
	verificationReportArtifactIdentity,
} from "runledger/runtime/verification";
import {
	startHeadlessDaemonCore,
	V3SessionRuntimeFactoryAdapter,
} from "runledger/daemon";
import { PortBackedVerificationRunner } from "runledger/verification-runner";

export interface PublicConsumerBindings {
	executor: RemoteExecutorPort;
	goal: orchestrator.GoalState;
	agent: governedAgents.AgentNode;
	report: verification.VerificationReport;
	activity: telemetry.RuntimeActivityState;
	principal: enterpriseIdentity.EnterprisePrincipalRef;
	shutdown: lifecycle.RuntimeShutdownReceipt;
	request: controlPlane.ControlPlaneRequest;
	verificationRuntime: VerificationSessionRuntimeOptions;
	modelConversion: ModelSwitchConversionReceipt;
	compactionRecovery: CompactionRecoveryAssessment;
	readiness: RuntimeDependencyReadinessReceipt;
}

// 本文件由 public-surface 测试编译；这些值引用同时证明根命名空间和稳定子路径可消费。
export const PUBLIC_RUNTIME_VALUES = [
	DurableGoalStateMachine,
	SessionDurableOrchestratorJournal,
	VerificationPipeline,
	VerificationSessionRuntime,
	VERIFICATION_REPORT_MEDIA_TYPE,
	verificationReportArtifactIdentity,
	AgentSupervisor,
	ControlPlaneCommandBus,
	RuntimeShutdownCoordinator,
	PortBackedVerificationRunner,
	EnterprisePrincipalRefSchema,
	projectRuntimeActivity,
	startHeadlessDaemonCore,
	V3SessionRuntimeFactoryAdapter,
	MODEL_ROUTING_CONTRACT_VERSION,
	ModelSwitchConversionReceiptSchema,
	CompactionRecoveryAssessmentSchema,
	daemon.startHeadlessDaemonCore,
	remoteExecutors.FailClosedRemoteExecutorGateway,
	verificationRunner.handleVerificationRunnerRequest,
] as const;
