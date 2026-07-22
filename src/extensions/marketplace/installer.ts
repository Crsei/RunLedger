/** exact locator + staging + digest/signature + sandbox probe + atomic activation。 */

import semver from "semver";
import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type {
	MarketplaceActivationReceipt,
	MarketplaceApprovalPort,
	MarketplaceDownloadPort,
	MarketplaceLocator,
	MarketplaceProbePort,
	MarketplaceSignaturePort,
	PluginVersionStorePort,
} from "./types.ts";

export type MarketplaceResult<T> = { ok: true; value: T } | { ok: false; code: "invalid_locator" | "download_failed" | "digest_mismatch" | "publisher_untrusted" | "probe_failed" | "approval_required" | "cooldown" | "store_failed"; message: string };

function validLocator(locator: MarketplaceLocator): boolean {
	if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(locator.packageName)) return false;
	if (!semver.valid(locator.version, { loose: false })) return false;
	if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(locator.publisherId)) return false;
	if (!/^[a-f0-9]{64}$/u.test(locator.expectedDigest) || locator.expectedSignature.length < 16) return false;
	try {
		return new URL(locator.sourceUrl).protocol === "https:";
	} catch {
		return false;
	}
}

export class MarketplaceInstaller {
	readonly #download: MarketplaceDownloadPort;
	readonly #signatures: MarketplaceSignaturePort;
	readonly #probe: MarketplaceProbePort;
	readonly #approvals: MarketplaceApprovalPort;
	readonly #store: PluginVersionStorePort;
	readonly #cooldownMs: number;

	public constructor(options: { download: MarketplaceDownloadPort; signatures: MarketplaceSignaturePort; probe: MarketplaceProbePort; approvals: MarketplaceApprovalPort; store: PluginVersionStorePort; cooldownMs?: number }) {
		this.#download = options.download;
		this.#signatures = options.signatures;
		this.#probe = options.probe;
		this.#approvals = options.approvals;
		this.#store = options.store;
		this.#cooldownMs = Math.max(0, options.cooldownMs ?? 60_000);
	}

	public async install(locator: MarketplaceLocator, operation: "install" | "update" = "install", signal?: AbortSignal): Promise<MarketplaceResult<MarketplaceActivationReceipt>> {
		if (!validLocator(locator)) return { ok: false, code: "invalid_locator", message: "marketplace install requires exact package/version/publisher/source/digest/signature" };
		let download;
		try {
			download = await this.#download.downloadToStaging(locator, { maxBytes: DEFAULT_EXTENSION_LIMITS.maxDirectoryBytes, requireHttps: true }, signal);
		} catch {
			return { ok: false, code: "download_failed", message: "marketplace download failed" };
		}
		if (download.sourceUrl !== locator.sourceUrl || download.digest !== locator.expectedDigest || download.bytes > DEFAULT_EXTENSION_LIMITS.maxDirectoryBytes) return { ok: false, code: "digest_mismatch", message: "marketplace package digest/source/size mismatch" };
		const verification = await this.#signatures.verify(locator, download, signal);
		if (!verification.signatureValid || !verification.publisherTrusted) return { ok: false, code: "publisher_untrusted", message: "package signature or publisher trust root is invalid" };
		const probe = await this.#probe.probe(download.stagedRoot, { maxFiles: DEFAULT_EXTENSION_LIMITS.maxFiles, maxBytes: DEFAULT_EXTENSION_LIMITS.maxDirectoryBytes, sandboxProfile: "strict" }, signal);
		if (!probe.ok) return { ok: false, code: "probe_failed", message: "staged plugin failed bounded sandbox probe" };
		const approval = await this.#approvals.authorize({ locator, probe, operation }, signal);
		if (!approval || approval.packageName !== locator.packageName || approval.version !== locator.version || approval.digest !== locator.expectedDigest || approval.capabilityDigest !== probe.capabilityDigest || new Date(approval.expiresAt).getTime() <= Date.now()) return { ok: false, code: "approval_required", message: "exact marketplace approval is missing or stale" };
		if (probe.containsExecutableResources && approval.profile !== "execute-enabled") return { ok: false, code: "approval_required", message: "execute/code resources require explicit execute-enabled profile" };
		if (operation === "update" && Date.now() - new Date(approval.approvedAt).getTime() < this.#cooldownMs) return { ok: false, code: "cooldown", message: "plugin update cooling period has not elapsed" };
		try {
			await this.#store.stageVerified({ locator, download, verification, probe }, signal);
			return { ok: true, value: await this.#store.activate(locator.packageName, locator.version, locator.expectedDigest, signal) };
		} catch {
			return { ok: false, code: "store_failed", message: "verified plugin could not be atomically activated" };
		}
	}

	public uninstall(packageName: string, expectedVersion: string, signal?: AbortSignal): Promise<boolean> {
		return this.#store.uninstall(packageName, expectedVersion, signal);
	}

	public rollback(packageName: string, expectedCurrentVersion: string, signal?: AbortSignal): Promise<MarketplaceResult<MarketplaceActivationReceipt>> {
		return this.#store.rollback(packageName, expectedCurrentVersion, signal).then((receipt) => receipt ? { ok: true, value: receipt } : { ok: false, code: "store_failed", message: "no verified rollback target is available" });
	}
}
