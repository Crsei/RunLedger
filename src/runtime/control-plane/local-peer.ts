/** Phase 10 只接受本地 peer；远程身份与 tenant auth 默认关闭。 */

import type { PrincipalId } from "../protocol/v3/ids.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import type { ControlPlaneTransport, LocalPeerIdentity } from "./types.ts";

export interface PeerConnectionEvidence {
	transport: ControlPlaneTransport;
	remoteAddress?: string;
	pid?: number;
	uid?: number;
	peerCredentialsVerified: boolean;
}

export interface LocalPeerIdentityResolverPort {
	resolve(evidence: PeerConnectionEvidence): Promise<ControlPlaneResult<LocalPeerIdentity>>;
}

export function isLoopbackAddress(address: string | undefined): boolean {
	if (!address) return false;
	const normalized = address.toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized.startsWith("127.") ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized === "::ffff:127.0.0.1"
	);
}

export class LocalPeerIdentityResolver implements LocalPeerIdentityResolverPort {
	readonly #principalId: PrincipalId;

	public constructor(principalId: PrincipalId) {
		this.#principalId = principalId;
	}

	public resolve(evidence: PeerConnectionEvidence): Promise<ControlPlaneResult<LocalPeerIdentity>> {
		if (evidence.transport === "local_socket" || evidence.transport === "named_pipe") {
			return Promise.resolve(controlPlaneFailure(
				"unsupported_feature",
				"local socket and named-pipe peer credential verification is not implemented",
			));
		}
		if (evidence.transport === "sse" && !isLoopbackAddress(evidence.remoteAddress)) {
			return Promise.resolve(controlPlaneFailure("remote_disabled", "SSE Control Plane accepts loopback peers only"));
		}
		if (evidence.transport === "jsonl" && !evidence.peerCredentialsVerified) {
			return Promise.resolve(controlPlaneFailure("unauthorized_peer", "stdio parent identity was not verified"));
		}
		const pid = evidence.pid ?? process.ppid;
		if (!Number.isSafeInteger(pid) || pid < 1) {
			return Promise.resolve(controlPlaneFailure("unauthorized_peer", "local peer pid is unavailable"));
		}
		const processUid = typeof process.getuid === "function" ? process.getuid() : null;
		const uid = evidence.uid ?? processUid;
		if (uid !== null && (!Number.isSafeInteger(uid) || uid < 0)) {
			return Promise.resolve(controlPlaneFailure("unauthorized_peer", "local peer uid is invalid"));
		}
		const authenticatedVia: LocalPeerIdentity["authenticatedVia"] =
			evidence.transport === "jsonl"
					? "stdio_parent"
					: "loopback_process";
		return Promise.resolve({
			ok: true,
			value: {
				kind: "local",
				transport: evidence.transport,
				pid,
				uid,
				principalId: this.#principalId,
				authenticatedVia,
			},
		});
	}
}
