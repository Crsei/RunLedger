/** CLI marketplace privileged port 的 exact locator/digest adapter。 */

import type {
	ExtensionConfirmationDetails,
	ExtensionMarketplaceControlPort,
} from "../control-plane/control-plane.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import type { MarketplaceInstaller } from "./installer.ts";
import { parseMarketplaceLocator } from "./node-marketplace.ts";
import type { PluginVersionStorePort } from "./types.ts";

export class MarketplaceControlService implements ExtensionMarketplaceControlPort {
	readonly #storage: ExtensionStoragePort;
	readonly #installer: MarketplaceInstaller;
	readonly #store: PluginVersionStorePort;

	public constructor(options: {
		storage: ExtensionStoragePort;
		installer: MarketplaceInstaller;
		store: PluginVersionStorePort;
	}) {
		this.#storage = options.storage;
		this.#installer = options.installer;
		this.#store = options.store;
	}

	public async confirmationDetails(
		command:
			| { operation: "install" | "update"; locatorPath: string }
			| { operation: "uninstall"; packageName: string; version: string }
			| { operation: "rollback"; packageName: string; fromVersion: string },
	): Promise<ExtensionConfirmationDetails | undefined> {
		if ("locatorPath" in command) {
			const read = await this.#storage.readFile(command.locatorPath, 1024 * 1024);
			if (!read.ok) return undefined;
			let value: unknown;
			try {
				value = JSON.parse(Buffer.from(read.value).toString("utf8"));
			} catch {
				return undefined;
			}
			const locator = parseMarketplaceLocator(value);
			if (!locator) return undefined;
			return {
				operation: `plugin-${command.operation}`,
				identity: `${locator.packageName}@${locator.version} by ${locator.publisherId}`,
				digest: locator.expectedDigest,
				capabilities: ["derived by bounded metadata-only probe before activation"],
			};
		}
		const active = await this.#store.active(command.packageName);
		const expectedVersion = "version" in command ? command.version : command.fromVersion;
		if (!active || active.version !== expectedVersion) return undefined;
		return {
			operation: `plugin-${command.operation}`,
			identity: `${command.packageName}@${expectedVersion}`,
			digest: active.digest,
			capabilities: ["active verified plugin; component capabilities are revalidated on reload"],
		};
	}

	public async install(
		locatorPath: string,
		operation: "install" | "update",
		confirmationDigest: string,
	): Promise<unknown> {
		const read = await this.#storage.readFile(locatorPath, 1024 * 1024);
		if (!read.ok) return { ok: false, code: "locator_unavailable", message: read.message };
		let value: unknown;
		try {
			value = JSON.parse(Buffer.from(read.value).toString("utf8"));
		} catch {
			return { ok: false, code: "invalid_locator", message: "locator is not valid JSON" };
		}
		const locator = parseMarketplaceLocator(value);
		if (!locator) return { ok: false, code: "invalid_locator", message: "locator does not match schemaVersion 1" };
		if (locator.expectedDigest !== confirmationDigest) {
			return { ok: false, code: "digest_mismatch", message: "confirmation digest does not match locator expectedDigest" };
		}
		return this.#installer.install(locator, operation);
	}

	public async uninstall(
		packageName: string,
		version: string,
		confirmationDigest: string,
	): Promise<unknown> {
		const active = await this.#store.active(packageName);
		if (!active || active.version !== version || active.digest !== confirmationDigest) {
			return { ok: false, code: "digest_mismatch", message: "active plugin identity/version/digest does not match confirmation" };
		}
		return { ok: await this.#installer.uninstall(packageName, version) };
	}

	public async rollback(
		packageName: string,
		fromVersion: string,
		confirmationDigest: string,
	): Promise<unknown> {
		const active = await this.#store.active(packageName);
		if (!active || active.version !== fromVersion || active.digest !== confirmationDigest) {
			return { ok: false, code: "digest_mismatch", message: "active rollback source does not match confirmation" };
		}
		return this.#installer.rollback(packageName, fromVersion);
	}
}
