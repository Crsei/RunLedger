/** 分层安全配置解析为 canonical SecuritySnapshot。 */

import { resolve } from "node:path";
import { runtimeDigest } from "../../runtime/contracts/public.ts";
import type { SandboxProfileName } from "../../runtime/contracts/public.ts";
import { PERMISSION_PROFILE_NAMES } from "../types.ts";
import type {
	ApprovalPolicyName,
	FilesystemPolicy,
	ManagedSecurityConstraints,
	PermissionProfileDefinition,
	PermissionProfileName,
	SecurityConfigLayer,
	SecurityProfile,
	SecurityResult,
	SecurityRule,
	SecuritySnapshot,
} from "../types.ts";

const SANDBOX_STRENGTH: Readonly<Record<SandboxProfileName, number>> = {
	off: 0,
	external: 1,
	"workspace-write": 2,
	"read-only": 3,
	strict: 4,
};

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_config", message, retryable: false } };
}

function firstValue<T>(layers: readonly SecurityConfigLayer[], read: (layer: SecurityConfigLayer) => T | undefined): T | undefined {
	for (const layer of layers) {
		const value = read(layer);
		if (value !== undefined) return value;
	}
	return undefined;
}

function defaultProfile(name: PermissionProfileName): SecurityProfile {
	switch (name) {
		case "read-only":
			return { name, approvalPolicy: "on-request", filesystemMode: "read-only", network: { mode: "deny", allowedHosts: [] }, sandbox: "read-only" };
		case "headless-workspace":
			return { name, approvalPolicy: "never", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" };
		case "danger-full-access":
			return { name, approvalPolicy: "never", filesystemMode: "unrestricted", network: { mode: "allow", allowedHosts: [] }, sandbox: "off" };
		case "custom":
		case "workspace-write":
			return { name, approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" };
	}
}

interface NamedProfileRecord {
	readonly definition: PermissionProfileDefinition;
	readonly source: SecurityConfigLayer["source"];
}

interface ResolvedProfile {
	readonly profile: SecurityProfile;
	readonly filesystemDefinitions: readonly Partial<FilesystemPolicy>[];
}

type FilesystemPathListKey = "readRoots" | "writeRoots" | "denyRead" | "denyWrite" | "protectedPaths";

function namedProfiles(layers: readonly SecurityConfigLayer[]): ReadonlyMap<string, NamedProfileRecord> {
	const profiles = new Map<string, NamedProfileRecord>();
	for (const layer of layers) {
		for (const [id, definition] of Object.entries(layer.document.profiles ?? {})) {
			if (!profiles.has(id)) profiles.set(id, { definition, source: layer.source });
		}
	}
	return profiles;
}

function resolveProfile(
	id: string,
	profiles: ReadonlyMap<string, NamedProfileRecord>,
	stack: readonly string[] = [],
): SecurityResult<ResolvedProfile> {
	if ((PERMISSION_PROFILE_NAMES as readonly string[]).includes(id)) {
		return { ok: true, value: { profile: defaultProfile(id as PermissionProfileName), filesystemDefinitions: [] } };
	}
	if (stack.includes(id)) return failure(`invalid_config: permission profile inheritance cycle: ${[...stack, id].join(" -> ")}`);
	const record = profiles.get(id);
	if (record === undefined) return failure(`invalid_config: permission profile is undefined: ${id}`);
	const base = resolveProfile(record.definition.extends ?? "workspace-write", profiles, [...stack, id]);
	if (!base.ok) return base;
	const definition = record.definition;
	const profile: SecurityProfile = {
		...base.value.profile,
		name: id,
		profileSource: record.source,
		...(definition.approvalPolicy === undefined ? {} : { approvalPolicy: definition.approvalPolicy }),
		...(definition.granularApproval === undefined ? {} : { granularApproval: definition.granularApproval }),
		...(definition.filesystemMode === undefined ? {} : { filesystemMode: definition.filesystemMode }),
		...(definition.network === undefined ? {} : { network: definition.network }),
		...(definition.sandbox === undefined ? {} : { sandbox: definition.sandbox }),
	};
	return {
		ok: true,
		value: {
			profile,
			filesystemDefinitions: [definition.filesystem ?? {}, ...base.value.filesystemDefinitions],
		},
	};
}

function resolveToken(value: string, workspaceRoot: string, tempRoot: string): SecurityResult<string> {
	if (value === ":workspace") return { ok: true, value: workspaceRoot };
	if (value === ":tmp" || value === ":runledger-temp") return { ok: true, value: tempRoot };
	if (value.startsWith(":")) return failure(`unknown security path token: ${value}`);
	return { ok: true, value: resolve(workspaceRoot, value) };
}

function collectPaths(
	layers: readonly SecurityConfigLayer[],
	profileDefinitions: readonly Partial<FilesystemPolicy>[],
	key: FilesystemPathListKey,
	workspaceRoot: string,
	tempRoot: string,
): SecurityResult<readonly string[]> {
	const resolved: string[] = [];
	const documents = [...layers.map((layer) => layer.document.filesystem ?? {}), ...profileDefinitions];
	for (const document of documents) {
		for (const value of document[key] ?? []) {
			const path = resolveToken(value, workspaceRoot, tempRoot);
			if (!path.ok) return path;
			resolved.push(path.value);
		}
	}
	return { ok: true, value: [...new Set(resolved)].sort() };
}

function minimumSandboxSatisfied(requested: SandboxProfileName, minimum: SandboxProfileName): boolean {
	if (requested === "external" || minimum === "external") return requested === minimum;
	return SANDBOX_STRENGTH[requested] >= SANDBOX_STRENGTH[minimum];
}

export interface ResolveSecuritySnapshotOptions {
	readonly layers: readonly SecurityConfigLayer[];
	readonly workspaceRoot: string;
	readonly tempRoot: string;
	readonly createdAt: string;
	readonly constraints?: ManagedSecurityConstraints;
}

export function resolveSecuritySnapshot(options: ResolveSecuritySnapshotOptions): SecurityResult<SecuritySnapshot> {
	const selectedName = firstValue(options.layers, (layer) => layer.document.profile) ?? "workspace-write";
	const resolvedProfile = resolveProfile(selectedName, namedProfiles(options.layers));
	if (!resolvedProfile.ok) return resolvedProfile;
	const defaults = resolvedProfile.value.profile;
	const approvalPolicy = firstValue(options.layers, (layer) => layer.document.approvalPolicy) ?? defaults.approvalPolicy;
	const granularApproval = firstValue(options.layers, (layer) => layer.document.granularApproval) ?? defaults.granularApproval;
	if (approvalPolicy === "granular" && granularApproval === undefined) return failure("granular approval policy requires granularApproval");
	const sandbox = firstValue(options.layers, (layer) => layer.document.sandbox) ?? defaults.sandbox;
	const network = firstValue(options.layers, (layer) => layer.document.network) ?? defaults.network;
	const constraints = options.constraints;
	if (constraints) {
		if (!constraints.allowedProfiles.includes(selectedName)) return failure(`profile is forbidden by managed policy: ${selectedName}`);
		if (!constraints.allowedApprovalPolicies.includes(approvalPolicy)) return failure(`approval policy is forbidden by managed policy: ${approvalPolicy}`);
		if (!minimumSandboxSatisfied(sandbox, constraints.minimumSandbox)) return failure(`sandbox profile is weaker than managed minimum: ${sandbox}`);
		if (constraints.forceNetworkDeny && network.mode !== "deny") return failure("managed policy requires network deny");
	}
	const profileDefinitions = resolvedProfile.value.filesystemDefinitions;
	const readRoots = collectPaths(options.layers, profileDefinitions, "readRoots", options.workspaceRoot, options.tempRoot);
	const writeRoots = collectPaths(options.layers, profileDefinitions, "writeRoots", options.workspaceRoot, options.tempRoot);
	const denyRead = collectPaths(options.layers, profileDefinitions, "denyRead", options.workspaceRoot, options.tempRoot);
	const denyWrite = collectPaths(options.layers, profileDefinitions, "denyWrite", options.workspaceRoot, options.tempRoot);
	const protectedPaths = collectPaths(options.layers, profileDefinitions, "protectedPaths", options.workspaceRoot, options.tempRoot);
	if (readRoots.ok === false) return readRoots;
	if (writeRoots.ok === false) return writeRoots;
	if (denyRead.ok === false) return denyRead;
	if (denyWrite.ok === false) return denyWrite;
	if (protectedPaths.ok === false) return protectedPaths;
	const filesystem: FilesystemPolicy = {
		readRoots: readRoots.value.length > 0 ? readRoots.value : [options.workspaceRoot, options.tempRoot],
		writeRoots: defaults.filesystemMode === "read-only" ? [options.tempRoot] : writeRoots.value.length > 0 ? writeRoots.value : [options.workspaceRoot, options.tempRoot],
		denyRead: denyRead.value,
		denyWrite: denyWrite.value,
		protectedPaths: [...new Set([resolve(options.workspaceRoot, ".git"), resolve(options.workspaceRoot, ".runledger"), ...protectedPaths.value])].sort(),
	};
	const rules: SecurityRule[] = options.layers.flatMap((layer) => (layer.document.rules ?? []).map((rule) => ({ ...rule, source: layer.source })));
	const profile: SecurityProfile = {
		...defaults,
		approvalPolicy: approvalPolicy as ApprovalPolicyName,
		...(granularApproval === undefined ? {} : { granularApproval }),
		network,
		sandbox,
	};
	const body = {
		profile,
		filesystem,
		rules,
		sources: [...new Set(options.layers.map((layer) => layer.source))],
		workspaceRoot: options.workspaceRoot,
		tempRoot: options.tempRoot,
		createdAt: options.createdAt,
	};
	return { ok: true, value: { ...body, policyDigest: runtimeDigest(body) } };
}
