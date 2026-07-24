/** inspect/trust/plugin/skill/hook/MCP 的无 TTY 控制面。 */

import type { ResourceApprovalScope } from "../../runtime/resources/types.ts";
import type { ExtensionDiscoverySnapshot, ExtensionManager } from "../extension-manager.ts";
import type { ExtensionStateStore } from "../state-store.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionRuntimeScope } from "../types.ts";
import type { ExtensionCommand } from "./commands.ts";

export interface ExtensionControlPlaneResponse {
	schemaVersion: 1;
	ok: boolean;
	exitCode: number;
	data?: unknown;
	error?: { code: string; message: string };
}

export interface ExtensionConfirmationDetails {
	operation: string;
	identity: string;
	digest: string;
	capabilities: readonly string[];
}

function resources(snapshot: ExtensionDiscoverySnapshot) {
	return snapshot.snapshot.descriptors.map((descriptor) => ({ id: descriptor.identity.qualifiedId, kind: descriptor.kind, source: descriptor.identity.source, displayName: descriptor.displayName, enabled: descriptor.enabled, trust: descriptor.trust, activation: descriptor.activation, digest: descriptor.manifest.combinedDigest, diagnostics: descriptor.diagnostics }));
}

function descriptorConfirmation(
	operation: string,
	descriptor: ExtensionDiscoverySnapshot["snapshot"]["descriptors"][number],
): ExtensionConfirmationDetails {
	return {
		operation,
		identity: descriptor.identity.qualifiedId,
		digest: descriptor.manifest.combinedDigest,
		capabilities: descriptor.capabilities.map((capability) =>
			`${capability.required ? "required" : "optional"}:${JSON.stringify(capability.claim)}`
		),
	};
}

function operationResponse(data: unknown): ExtensionControlPlaneResponse {
	if (
		typeof data === "object" &&
		data !== null &&
		"ok" in data &&
		data.ok === false
	) {
		const code = "code" in data && typeof data.code === "string"
			? data.code
			: "extension_operation_rejected";
		const message = "message" in data && typeof data.message === "string"
			? data.message
			: "Extension operation was rejected";
		return {
			schemaVersion: 1,
			ok: false,
			exitCode: 1,
			error: { code, message },
		};
	}
	return { schemaVersion: 1, ok: true, exitCode: 0, data };
}

export interface ExtensionDiscoveryControlPort {
	inspect(): Promise<ExtensionDiscoverySnapshot>;
}

export interface ExtensionPrivilegedControlPorts {
	manager: ExtensionManager;
	state: ExtensionStateStore;
	trust: TrustStore;
	scope: ExtensionRuntimeScope;
	trustScope?: ResourceApprovalScope;
}

export interface ExtensionMarketplaceControlPort {
	confirmationDetails?(
		command:
			| { operation: "install" | "update"; locatorPath: string }
			| { operation: "uninstall"; packageName: string; version: string }
			| { operation: "rollback"; packageName: string; fromVersion: string },
	): Promise<ExtensionConfirmationDetails | undefined>;
	install(locatorPath: string, operation: "install" | "update", confirmationDigest: string): Promise<unknown>;
	uninstall(packageName: string, version: string, confirmationDigest: string): Promise<unknown>;
	rollback(packageName: string, fromVersion: string, confirmationDigest: string): Promise<unknown>;
}

export interface ExtensionOAuthControlPort {
	login(serverId: string, confirmationDigest: string): Promise<unknown>;
	logout(serverId: string, confirmationDigest: string): Promise<unknown>;
}

export class ExtensionControlPlane {
	readonly #discovery: ExtensionDiscoveryControlPort;
	readonly #privileged?: ExtensionPrivilegedControlPorts;
	readonly #trustReader?: TrustStore;
	readonly #marketplace?: ExtensionMarketplaceControlPort;
	readonly #oauth?: ExtensionOAuthControlPort;
	readonly #trustScope: ResourceApprovalScope;

	public constructor(options: {
		discovery?: ExtensionDiscoveryControlPort;
		manager?: ExtensionManager;
		state?: ExtensionStateStore;
		trust?: TrustStore;
		scope?: ExtensionRuntimeScope;
		trustScope?: ResourceApprovalScope;
		marketplace?: ExtensionMarketplaceControlPort;
		oauth?: ExtensionOAuthControlPort;
	}) {
		const discovery = options.discovery ?? options.manager;
		if (!discovery) throw new TypeError("Extension control plane requires a discovery port");
		this.#discovery = discovery;
		this.#trustReader = options.trust;
		this.#marketplace = options.marketplace;
		this.#oauth = options.oauth;
		if (options.manager && options.state && options.trust && options.scope) {
			this.#privileged = {
				manager: options.manager,
				state: options.state,
				trust: options.trust,
				scope: options.scope,
				...(options.trustScope ? { trustScope: options.trustScope } : {}),
			};
		}
		this.#trustScope = options.trustScope ?? "project";
	}

	#unavailable(operation: string): ExtensionControlPlaneResponse {
		return {
			schemaVersion: 1,
			ok: false,
			exitCode: 4,
			error: {
				code: "privileged_ports_unavailable",
				message: `${operation} requires Runtime Gateway, approval, durable audit, and writable state ports`,
			},
		};
	}

	#confirmation(
		command: ExtensionCommand,
		expectedDigest?: string,
		details?: ExtensionConfirmationDetails,
	): ExtensionControlPlaneResponse | undefined {
		if (!command.yes || !command.digest) {
			return {
				schemaVersion: 1,
				ok: false,
				exitCode: 5,
				...(details ? { data: { confirmation: details } } : {}),
				error: {
					code: "confirmation_required",
					message: "non-interactive privileged operations require --yes --digest <sha256>",
				},
			};
		}
		if (expectedDigest && command.digest !== expectedDigest) {
			return {
				schemaVersion: 1,
				ok: false,
				exitCode: 5,
				error: {
					code: "digest_mismatch",
					message: "confirmation digest does not match the current exact resource identity",
				},
			};
		}
		return undefined;
	}

	public async execute(command: ExtensionCommand): Promise<ExtensionControlPlaneResponse> {
		try {
			return await this.#execute(command);
		} catch (error) {
			return {
				schemaVersion: 1,
				ok: false,
				exitCode: 1,
				error: {
					code: "extension_operation_failed",
					message: error instanceof Error ? error.message : "Extension operation failed",
				},
			};
		}
	}

	async #execute(command: ExtensionCommand): Promise<ExtensionControlPlaneResponse> {
		let current: ExtensionDiscoverySnapshot;
		try {
			current = await this.#discovery.inspect();
		} catch (error) {
			return {
				schemaVersion: 1,
				ok: false,
				exitCode: 1,
				error: {
					code: "extension_discovery_failed",
					message: error instanceof Error ? error.message : "extension discovery failed",
				},
			};
		}
		if (command.kind === "inspect") return { schemaVersion: 1, ok: true, exitCode: 0, data: { snapshot: current.snapshot, resources: resources(current) } };
		if (command.kind === "trust-list") {
			if (!this.#trustReader) return this.#unavailable("trust list");
			return { schemaVersion: 1, ok: true, exitCode: 0, data: await this.#trustReader.load() };
		}
		if (command.kind === "plugin-install" || command.kind === "plugin-update") {
			if (!this.#marketplace) return this.#unavailable(command.kind);
			const details = !command.yes
				? await this.#marketplace.confirmationDetails?.({
					operation: command.kind === "plugin-install" ? "install" : "update",
					locatorPath: command.locatorPath,
				})
				: undefined;
			const confirmation = this.#confirmation(command, details?.digest, details);
			if (confirmation) return confirmation;
			return operationResponse(
				await this.#marketplace.install(
					command.locatorPath,
					command.kind === "plugin-install" ? "install" : "update",
					command.digest!,
				),
			);
		}
		if (command.kind === "plugin-uninstall") {
			if (!this.#marketplace) return this.#unavailable(command.kind);
			const details = !command.yes
				? await this.#marketplace.confirmationDetails?.({
					operation: "uninstall",
					packageName: command.packageName,
					version: command.version,
				})
				: undefined;
			const confirmation = this.#confirmation(command, details?.digest, details);
			if (confirmation) return confirmation;
			return operationResponse(
				await this.#marketplace.uninstall(command.packageName, command.version, command.digest!),
			);
		}
		if (command.kind === "plugin-rollback") {
			if (!this.#marketplace) return this.#unavailable(command.kind);
			const details = !command.yes
				? await this.#marketplace.confirmationDetails?.({
					operation: "rollback",
					packageName: command.packageName,
					fromVersion: command.fromVersion,
				})
				: undefined;
			const confirmation = this.#confirmation(command, details?.digest, details);
			if (confirmation) return confirmation;
			return operationResponse(
				await this.#marketplace.rollback(command.packageName, command.fromVersion, command.digest!),
			);
		}
		const privilegedOperation =
			command.kind === "trust-grant" ||
			command.kind === "trust-revoke" ||
			command.kind === "plugin-trust" ||
			command.kind === "plugin-untrust" ||
			command.kind.endsWith("-enable") ||
			command.kind.endsWith("-disable") ||
			command.kind === "mcp-doctor";
		if (privilegedOperation && !this.#privileged) {
			return this.#unavailable(command.kind);
		}
		const resourceId = "resourceId" in command ? command.resourceId : undefined;
		const descriptor = resourceId ? current.snapshot.descriptors.find((item) => item.identity.qualifiedId === resourceId) : undefined;
		if (resourceId && !descriptor) return { schemaVersion: 1, ok: false, exitCode: 3, error: { code: "not_found", message: "exact extension resource identity was not found" } };
		if (command.kind === "mcp-login" || command.kind === "mcp-logout") {
			if (!this.#oauth) return this.#unavailable(command.kind);
			if (!descriptor || descriptor.kind !== "mcp-server") return { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "identity_required", message: "MCP OAuth requires an exact server identity" } };
			const confirmation = this.#confirmation(
				command,
				descriptor.manifest.combinedDigest,
				descriptorConfirmation(command.kind, descriptor),
			);
			if (confirmation) return confirmation;
			return operationResponse(
				command.kind === "mcp-login"
					? await this.#oauth.login(descriptor.identity.qualifiedId, command.digest!)
					: await this.#oauth.logout(descriptor.identity.qualifiedId, command.digest!),
			);
		}
		if (command.kind === "trust-grant" || command.kind === "plugin-trust") {
			if (!this.#privileged) return this.#unavailable("trust grant");
			if (!descriptor) return { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "identity_required", message: "trust grant requires an exact resource identity" } };
			const confirmation = this.#confirmation(
				command,
				descriptor.manifest.combinedDigest,
				descriptorConfirmation(command.kind, descriptor),
			);
			if (confirmation) return confirmation;
			const canonicalPath = descriptor.kind === "plugin"
				? current.plugins.find((plugin) => plugin.descriptor.identity.qualifiedId === descriptor.identity.qualifiedId)?.rootPath ?? descriptor.sourcePath
				: descriptor.kind === "skill"
					? current.skills.find((skill) => skill.descriptor.identity.qualifiedId === descriptor.identity.qualifiedId)?.trustBinding.canonicalPath ?? descriptor.sourcePath
					: descriptor.sourcePath;
			const record = await this.#privileged.trust.grant({ identity: descriptor.identity, canonicalPath, binding: descriptor.manifest, principalId: this.#privileged.scope.principalId, scope: this.#trustScope });
			this.#privileged.manager.requestReload();
			return { schemaVersion: 1, ok: true, exitCode: 0, data: { resourceId: descriptor.identity.qualifiedId, digest: descriptor.manifest.combinedDigest, receiptId: record.receiptId, reload: "pending" } };
		}
		if (command.kind === "trust-revoke" || command.kind === "plugin-untrust") {
			if (!this.#privileged) return this.#unavailable("trust revoke");
			if (!resourceId) return { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "identity_required", message: "trust revoke requires an exact resource identity" } };
			const confirmation = this.#confirmation(
				command,
				descriptor?.manifest.combinedDigest,
				descriptor ? descriptorConfirmation(command.kind, descriptor) : undefined,
			);
			if (confirmation) return confirmation;
			const revoked = await this.#privileged.trust.revoke(resourceId);
			if (!revoked) return { schemaVersion: 1, ok: false, exitCode: 3, error: { code: "not_found", message: "trust record not found" } };
			this.#privileged.manager.requestReload();
			return { schemaVersion: 1, ok: true, exitCode: 0, data: { resourceId, revocationRevision: revoked.revocationRevision, reload: "pending" } };
		}
		if (command.kind.endsWith("-enable") || command.kind.endsWith("-disable")) {
			if (!this.#privileged) return this.#unavailable("enable/disable");
			if (!resourceId) return { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "identity_required", message: "enable/disable requires an exact resource identity" } };
			const confirmation = this.#confirmation(
				command,
				descriptor?.manifest.combinedDigest,
				descriptor ? descriptorConfirmation(command.kind, descriptor) : undefined,
			);
			if (confirmation) return confirmation;
			await this.#privileged.state.setEnabled(resourceId, command.kind.endsWith("-enable"));
			this.#privileged.manager.requestReload();
			return { schemaVersion: 1, ok: true, exitCode: 0, data: { resourceId, enabled: command.kind.endsWith("-enable"), reload: "pending" } };
		}
		if (command.kind === "mcp-doctor") {
			if (!this.#privileged) return this.#unavailable("MCP doctor");
			const active = this.#privileged.manager.current();
			if (!active) return this.#unavailable("MCP doctor");
			return { schemaVersion: 1, ok: true, exitCode: 0, data: await active.mcp.doctor(resourceId) };
		}
		const domain = command.kind.split("-")[0];
		const selected = resources(current).filter((item) => domain === "mcp" ? item.kind === "mcp-server" : item.kind === domain);
		if (command.kind.endsWith("-list")) return { schemaVersion: 1, ok: true, exitCode: 0, data: selected };
		if (command.kind.endsWith("-show")) return descriptor ? { schemaVersion: 1, ok: true, exitCode: 0, data: descriptor } : { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "identity_required", message: "show requires an exact resource identity" } };
		if (command.kind.endsWith("-validate")) return { schemaVersion: 1, ok: !selected.some((item) => item.activation === "failed"), exitCode: selected.some((item) => item.activation === "failed") ? 1 : 0, data: selected };
		return { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "unsupported", message: "extension command is not implemented" } };
	}
}

export function renderExtensionControlPlane(response: ExtensionControlPlaneResponse, json: boolean): string {
	if (json) return JSON.stringify(response);
	if (!response.ok) return `error: ${response.error?.message ?? "extension operation failed"}`;
	return typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);
}
