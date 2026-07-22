/** protocol/schema/features 的确定性协商。 */

import type { RuntimeInstanceId } from "../protocol/v3/ids.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import {
	CONTROL_PLANE_FEATURES,
	CONTROL_PLANE_PROTOCOL_MAJOR,
	CONTROL_PLANE_PROTOCOL_MINOR,
	CONTROL_PLANE_RUNTIME_SCHEMA_VERSIONS,
	CONTROL_PLANE_SCHEMA_VERSION,
	type ControlPlaneClientHello,
	type ControlPlaneFeature,
	type ControlPlaneServerHello,
	validateControlPlaneHello,
} from "./types.ts";

export interface HandshakeServerCapabilities {
	serverInstanceId: RuntimeInstanceId;
	protocolMajor?: number;
	protocolMinor?: number;
	controlPlaneSchemaVersions?: readonly number[];
	runtimeSchemaVersions?: readonly number[];
	features?: readonly ControlPlaneFeature[];
}

export function negotiateControlPlaneHandshake(
	input: unknown,
	capabilities: HandshakeServerCapabilities,
): ControlPlaneResult<ControlPlaneServerHello> {
	const validated = validateControlPlaneHello(input);
	if (!validated.ok) return { ok: false, error: validated.error, effect: "none" };
	const hello: ControlPlaneClientHello = validated.value;
	const protocolMajor = capabilities.protocolMajor ?? CONTROL_PLANE_PROTOCOL_MAJOR;
	const protocolMinor = capabilities.protocolMinor ?? CONTROL_PLANE_PROTOCOL_MINOR;
	if (
		hello.protocol.major !== protocolMajor ||
		hello.protocol.minMinor > protocolMinor ||
		hello.protocol.maxMinor < 0
	) {
		return controlPlaneFailure("unsupported_protocol", "no compatible Control Plane protocol version", false, {
			serverMajor: protocolMajor,
			serverMinor: protocolMinor,
			clientMajor: hello.protocol.major,
			clientMinMinor: hello.protocol.minMinor,
			clientMaxMinor: hello.protocol.maxMinor,
		});
	}
	const negotiatedMinor = Math.min(protocolMinor, hello.protocol.maxMinor);
	if (negotiatedMinor < hello.protocol.minMinor) {
		return controlPlaneFailure("unsupported_protocol", "no overlapping protocol minor version", false);
	}
	const serverControlPlaneSchemas = capabilities.controlPlaneSchemaVersions ?? [CONTROL_PLANE_SCHEMA_VERSION];
	const controlPlaneSchemaVersion = [...hello.controlPlaneSchemaVersions]
		.filter((version) => serverControlPlaneSchemas.includes(version))
		.sort((left, right) => right - left)[0];
	if (controlPlaneSchemaVersion === undefined) {
		return controlPlaneFailure("unsupported_schema", "no compatible Control Plane request schema version", false);
	}

	const serverSchemas = capabilities.runtimeSchemaVersions ?? CONTROL_PLANE_RUNTIME_SCHEMA_VERSIONS;
	const runtimeSchemaVersion = [...hello.runtimeSchemaVersions]
		.filter((version) => serverSchemas.includes(version))
		.sort((left, right) => right - left)[0];
	if (runtimeSchemaVersion === undefined) {
		return controlPlaneFailure("unsupported_schema", "no compatible Runtime event schema version", false);
	}

	const supportedFeatures = capabilities.features ?? CONTROL_PLANE_FEATURES;
	const missing = hello.requiredFeatures.filter((feature) => !supportedFeatures.includes(feature));
	if (missing.length > 0) {
		return controlPlaneFailure("unsupported_feature", "required Control Plane feature is unavailable", false, {
			feature: missing[0] ?? "unknown",
		});
	}
	const features = hello.requestedFeatures.filter((feature) => supportedFeatures.includes(feature));
	return {
		ok: true,
		value: {
			kind: "handshake_result",
			requestId: hello.requestId,
			protocol: { major: protocolMajor, minor: negotiatedMinor },
			controlPlaneSchemaVersion,
			runtimeSchemaVersion,
			features,
			serverInstanceId: capabilities.serverInstanceId,
			remoteAccess: "disabled",
			deliveryGuarantee: "at_least_once",
		},
	};
}
