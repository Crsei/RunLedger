/** Artifact 加密/keyed receipt 的 OS keyring-only 端口。 */

import type { ArtifactError, ArtifactKeyState, ArtifactResult } from "./types.ts";

export type ArtifactKeyPurpose = "source_receipt" | "forensic_encrypt" | "forensic_decrypt";

export interface ArtifactKeyProviderStatus {
	state: ArtifactKeyState;
	activeVersion?: string;
	availableVersions: readonly string[];
	backend: "os_keyring" | "unavailable";
}

export interface ArtifactKeyDescriptor {
	version: string;
	backend: "os_keyring";
	key: Uint8Array;
}

export interface ArtifactKeyRequest {
	purpose: ArtifactKeyPurpose;
	version?: string;
}

export interface ArtifactKeyProvider {
	status(): Promise<ArtifactKeyProviderStatus>;
	withKey<T>(
		request: ArtifactKeyRequest,
		operation: (descriptor: Readonly<ArtifactKeyDescriptor>) => Promise<T> | T,
	): Promise<ArtifactResult<T>>;
}

export type OsKeyringReadResult =
	| { status: "available"; version: string; key: Uint8Array }
	| { status: "unavailable" | "lost" | "rotating"; activeVersion?: string; availableVersions?: readonly string[] };

/** 具体系统 keyring 适配器必须实现这个端口；Artifact 模块不读取 key 文件或环境变量。 */
export interface OsKeyringPort {
	readonly backend: "os_keyring";
	readArtifactKey(version?: string): Promise<OsKeyringReadResult>;
	status(): Promise<ArtifactKeyProviderStatus>;
}

function keyError(result: Exclude<OsKeyringReadResult, { status: "available" }>): ArtifactError {
	return {
		code: "key_unavailable",
		message: `artifact key is ${result.status}`,
		retryable: result.status !== "lost",
		details: { keyState: result.status },
	};
}

export class OsKeyringArtifactKeyProvider implements ArtifactKeyProvider {
	readonly #keyring: OsKeyringPort;

	public constructor(keyring: OsKeyringPort) {
		if (keyring.backend !== "os_keyring") {
			throw new TypeError("artifact key provider requires an OS keyring backend");
		}
		this.#keyring = keyring;
	}

	public async status(): Promise<ArtifactKeyProviderStatus> {
		const status = await this.#keyring.status();
		if (status.backend !== "os_keyring") {
			return { state: "unavailable", availableVersions: [], backend: "unavailable" };
		}
		return status;
	}

	public async withKey<T>(
		request: ArtifactKeyRequest,
		operation: (descriptor: Readonly<ArtifactKeyDescriptor>) => Promise<T> | T,
	): Promise<ArtifactResult<T>> {
		let result: OsKeyringReadResult;
		try {
			result = await this.#keyring.readArtifactKey(request.version);
		} catch {
			return {
				ok: false,
				error: {
					code: "key_unavailable",
					message: "OS keyring read failed",
					retryable: true,
				},
			};
		}
		if (result.status !== "available") return { ok: false, error: keyError(result) };
		if (!result.version || result.key.byteLength !== 32) {
			result.key.fill(0);
			return {
				ok: false,
				error: { code: "key_unavailable", message: "OS keyring returned an invalid AES-256 key", retryable: false },
			};
		}

		const key = Uint8Array.from(result.key);
		result.key.fill(0);
		try {
			return { ok: true, value: await operation({ version: result.version, backend: "os_keyring", key }) };
		} catch {
			return {
				ok: false,
				error: {
					code: "key_unavailable",
					message: "artifact key operation failed",
					retryable: false,
				},
			};
		} finally {
			key.fill(0);
		}
	}
}

/** 显式降级端口；不会从文件、环境变量或固定值生成替代密钥。 */
export class UnavailableArtifactKeyProvider implements ArtifactKeyProvider {
	readonly #state: Exclude<ArtifactKeyState, "available">;

	public constructor(state: Exclude<ArtifactKeyState, "available"> = "unavailable") {
		this.#state = state;
	}

	public async status(): Promise<ArtifactKeyProviderStatus> {
		return { state: this.#state, availableVersions: [], backend: "unavailable" };
	}

	public async withKey<T>(
		_request: ArtifactKeyRequest,
		_operation: (descriptor: Readonly<ArtifactKeyDescriptor>) => Promise<T> | T,
	): Promise<ArtifactResult<T>> {
		return {
			ok: false,
			error: {
				code: "key_unavailable",
				message: `artifact key is ${this.#state}`,
				retryable: this.#state !== "lost",
			},
		};
	}
}
