/** 本地、受管和远程部署的明确威胁模型与 fail-closed 声明。 */

import type { AttestationStatus, IntegrityStatus } from "./events.ts";

export type RuntimeDeploymentMode = "local" | "managed" | "remote";

export interface RuntimeThreatModel {
	mode: RuntimeDeploymentMode;
	trustedComponents: readonly string[];
	untrustedActors: readonly string[];
	trustRoot: string;
	signer: string;
	anchor: string;
	failClosedWhen: readonly string[];
	defaultIntegrity: IntegrityStatus;
	defaultAttestation: AttestationStatus;
}

export const RUNTIME_THREAT_MODELS: Readonly<Record<RuntimeDeploymentMode, RuntimeThreatModel>> = {
	local: {
		mode: "local",
		trustedComponents: ["runtime process", "local filesystem permissions", "optional OS key provider"],
		untrustedActors: ["model output", "repository content", "tools", "same-user concurrent runtime"],
		trustRoot: "known genesis or head supplied by the local operator",
		signer: "optional OS-backed local signer",
		anchor: "local receipt or explicit external export",
		failClosedWhen: ["event chain is corrupted", "writer fencing is stale", "required capability receipt is unavailable"],
		defaultIntegrity: "valid",
		defaultAttestation: "unattested",
	},
	managed: {
		mode: "managed",
		trustedComponents: ["managed runtime binary", "organization identity service", "organization signer"],
		untrustedActors: ["model output", "repository content", "tools", "unmanaged local policy", "stale organization principal"],
		trustRoot: "organization policy and identity authority",
		signer: "organization-managed versioned signer",
		anchor: "organization audit or SIEM receipt",
		failClosedWhen: ["managed policy cannot be resolved", "signer receipt is invalid", "tenant correlation fails"],
		defaultIntegrity: "valid",
		defaultAttestation: "attested",
	},
	remote: {
		mode: "remote",
		trustedComponents: ["control-plane trust root", "attested remote executor", "signed transport identity"],
		untrustedActors: ["local client", "network", "model output", "repository content", "unattested executor"],
		trustRoot: "pinned control-plane and executor attestation authorities",
		signer: "remote workload signer with short-lived identity",
		anchor: "control-plane durable audit receipt",
		failClosedWhen: ["handshake is incompatible", "executor attestation is missing", "receipt tenant or workload does not match"],
		defaultIntegrity: "valid",
		defaultAttestation: "attested",
	},
};

export function describeIntegrityClaim(integrity: IntegrityStatus, attestation: AttestationStatus): string {
	return `${integrity}/${attestation}`;
}
