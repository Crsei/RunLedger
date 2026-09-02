/** CLI compatibility export for the shared workspace admission service. */

export {
	assertSessionWorkspaceMatches,
	resolveSessionWorkspaceIdentity,
	SessionWorkspaceAdmission,
	sessionWorkspaceMatches,
} from "../workspace/session-identity.ts";
export type {
	SessionWorkspaceAdmissionStatus,
	SessionWorkspaceBindingRecord,
	SessionWorkspaceIdentity,
} from "../workspace/session-identity.ts";
