/** inspect/trust/plugin/skill/hook/MCP 的无 TTY 控制面。 */

import type { ResourceApprovalScope } from "../../runtime/resources/types.ts";
import type { ExtensionManager } from "../extension-manager.ts";
import type { ExtensionManagerSnapshot } from "../extension-manager.ts";
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

function resources(snapshot: ExtensionManagerSnapshot) {
	return snapshot.snapshot.descriptors.map((descriptor) => ({ id: descriptor.identity.qualifiedId, kind: descriptor.kind, source: descriptor.identity.source, displayName: descriptor.displayName, enabled: descriptor.enabled, trust: descriptor.trust, activation: descriptor.activation, digest: descriptor.manifest.combinedDigest, diagnostics: descriptor.diagnostics }));
}

export class ExtensionControlPlane {
	readonly #manager: ExtensionManager;
	readonly #state: ExtensionStateStore;
	readonly #trust: TrustStore;
	readonly #scope: ExtensionRuntimeScope;
	readonly #trustScope: ResourceApprovalScope;

	public constructor(options: { manager: ExtensionManager; state: ExtensionStateStore; trust: TrustStore; scope: ExtensionRuntimeScope; trustScope?: ResourceApprovalScope }) {
		this.#manager = options.manager;
		this.#state = options.state;
		this.#trust = options.trust;
		this.#scope = options.scope;
		this.#trustScope = options.trustScope ?? "project";
	}

	#current(): ExtensionManagerSnapshot | undefined { return this.#manager.current(); }

	public async execute(command: ExtensionCommand): Promise<ExtensionControlPlaneResponse> {
		const current = this.#current();
		if (command.kind === "inspect") return { schemaVersion: 1, ok: true, exitCode: 0, data: current ? { snapshot: current.snapshot, resources: resources(current), mcp: current.mcp.status() } : { snapshot: null, resources: [], diagnostics: [{ code: "extensions.unavailable", severity: "warning", message: "extension manager is not initialized" }] } };
		if (command.kind === "trust-list") return { schemaVersion: 1, ok: true, exitCode: 0, data: await this.#trust.load() };
		if (!current) return { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "extensions_unavailable", message: "extension manager is not initialized" } };
		const resourceId = "resourceId" in command ? command.resourceId : undefined;
		const descriptor = resourceId ? current.snapshot.descriptors.find((item) => item.identity.qualifiedId === resourceId) : undefined;
		if (resourceId && !descriptor) return { schemaVersion: 1, ok: false, exitCode: 3, error: { code: "not_found", message: "exact extension resource identity was not found" } };
		if (command.kind === "trust-grant" || command.kind === "plugin-trust") {
			if (!descriptor) return { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "identity_required", message: "trust grant requires an exact resource identity" } };
			const canonicalPath = descriptor.kind === "plugin"
				? current.plugins.find((plugin) => plugin.descriptor.identity.qualifiedId === descriptor.identity.qualifiedId)?.rootPath ?? descriptor.sourcePath
				: descriptor.kind === "skill"
					? current.skills.find((skill) => skill.descriptor.identity.qualifiedId === descriptor.identity.qualifiedId)?.trustBinding.canonicalPath ?? descriptor.sourcePath
					: descriptor.sourcePath;
			const record = await this.#trust.grant({ identity: descriptor.identity, canonicalPath, binding: descriptor.manifest, principalId: this.#scope.principalId, scope: this.#trustScope });
			this.#manager.requestReload();
			return { schemaVersion: 1, ok: true, exitCode: 0, data: { resourceId: descriptor.identity.qualifiedId, digest: descriptor.manifest.combinedDigest, receiptId: record.receiptId, reload: "pending" } };
		}
		if (command.kind === "trust-revoke" || command.kind === "plugin-untrust") {
			if (!resourceId) return { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "identity_required", message: "trust revoke requires an exact resource identity" } };
			const revoked = await this.#trust.revoke(resourceId);
			if (!revoked) return { schemaVersion: 1, ok: false, exitCode: 3, error: { code: "not_found", message: "trust record not found" } };
			this.#manager.requestReload();
			return { schemaVersion: 1, ok: true, exitCode: 0, data: { resourceId, revocationRevision: revoked.revocationRevision, reload: "pending" } };
		}
		if (command.kind.endsWith("-enable") || command.kind.endsWith("-disable")) {
			if (!resourceId) return { schemaVersion: 1, ok: false, exitCode: 2, error: { code: "identity_required", message: "enable/disable requires an exact resource identity" } };
			await this.#state.setEnabled(resourceId, command.kind.endsWith("-enable"));
			this.#manager.requestReload();
			return { schemaVersion: 1, ok: true, exitCode: 0, data: { resourceId, enabled: command.kind.endsWith("-enable"), reload: "pending" } };
		}
		if (command.kind === "mcp-doctor") return { schemaVersion: 1, ok: true, exitCode: 0, data: await current.mcp.doctor(resourceId) };
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
