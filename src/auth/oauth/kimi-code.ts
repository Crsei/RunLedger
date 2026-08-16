/**
 * Kimi Code OAuth 设备码流程(device authorization grant)
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, release, version as osVersion } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../storage/paths.ts";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_CLI_VERSION = "1.0";
const DEVICE_ID_FILENAME = "kimi-device-id";
// 源实现:token 过期前 5 分钟提前刷新,避免请求中途失效
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// 源实现:服务端未返回 expires_in 时回退 15 分钟
const DEFAULT_DEVICE_FLOW_TTL_SECONDS = 15 * 60;

type JsonObject = Record<string, unknown>;

type OAuthHttpResponse = {
	ok: boolean;
	status: number;
	body: JsonObject;
};

type KimiDeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	intervalSeconds?: number;
	expiresInSeconds: number;
};

export interface KimiCodeOAuthOptions {
	fetch?: typeof fetch;
}

function resolveOAuthHost(): string {
	return process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST ?? DEFAULT_OAUTH_HOST;
}

function sanitizeHeaderValue(value: string, fallback = ""): string {
	const sanitized = value.replace(/[^\x20-\x7E]/gu, "").trim();
	return sanitized || fallback;
}

function formatDeviceModel(system: string, releaseName: string, archName: string): string {
	return [system, releaseName, archName].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
	const currentPlatform = platform();
	const currentRelease = release();
	const currentArch = arch();
	if (currentPlatform === "darwin") return formatDeviceModel("macOS", currentRelease, currentArch);
	if (currentPlatform === "win32") return formatDeviceModel("Windows", currentRelease, currentArch);
	const label = currentPlatform === "linux" ? "Linux" : currentPlatform;
	return formatDeviceModel(label, currentRelease, currentArch);
}

// 设备 id 标识本机安装;持久化尽力而为,目录缺失/不可写绝不能阻断请求头构造,退化为进程级临时 id
let getDeviceId = (): string => {
	const deviceIdPath = join(getAgentDir(), DEVICE_ID_FILENAME);
	try {
		const existing = readFileSync(deviceIdPath, "utf-8").trim();
		if (existing) {
			getDeviceId = () => existing;
			return existing;
		}
	} catch {
		// 读不到设备 id 文件:下方重新生成
	}

	const deviceId = randomUUID().replace(/-/gu, "");
	try {
		mkdirSync(dirname(deviceIdPath), { recursive: true });
		writeFileSync(deviceIdPath, `${deviceId}\n`, { mode: 0o600 });
	} catch {
		// 持久化失败 → 本次进程使用临时 id
	}
	getDeviceId = () => deviceId;
	return deviceId;
};

// Kimi 服务端要求的 CLI 设备元数据请求头(与源实现逐字段对齐)
function kimiHeaders(): Record<string, string> {
	return {
		"User-Agent": `KimiCLI/${KIMI_CLI_VERSION}`,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": KIMI_CLI_VERSION,
		"X-Msh-Device-Name": sanitizeHeaderValue(hostname(), "unknown"),
		"X-Msh-Device-Model": sanitizeHeaderValue(getDeviceModel(), "unknown"),
		"X-Msh-Os-Version": sanitizeHeaderValue(osVersion(), "unknown"),
		"X-Msh-Device-Id": sanitizeHeaderValue(getDeviceId(), "unknown"),
	};
}

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid Kimi OAuth response field: ${field}`);
	}
	return value;
}

function positiveNumber(body: JsonObject, field: string): number {
	const value = body[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid Kimi OAuth response field: ${field}`);
	}
	return value;
}

// 校验 URI 会被浏览器打开;强制 https,防止恶意响应让 open 启动可执行文件等
function validateVerificationUri(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Untrusted verification URI in Kimi OAuth response");
	}
	if (url.protocol !== "https:") {
		throw new Error("Untrusted verification URI in Kimi OAuth response");
	}
	return url.href;
}

async function postForm(
	fetchImpl: typeof fetch,
	url: string,
	fields: Record<string, string>,
	signal?: AbortSignal,
): Promise<OAuthHttpResponse> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				...kimiHeaders(),
			},
			body: new URLSearchParams(fields),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	let body: JsonObject;
	try {
		const parsed = (await response.json()) as unknown;
		body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
	} catch {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw new Error(`Kimi OAuth returned invalid JSON (HTTP ${response.status})`);
	}
	return {
		ok: response.ok,
		status: response.status,
		body,
	};
}

function requestFailure(action: string, response: OAuthHttpResponse): Error {
	const error = typeof response.body.error === "string" ? response.body.error : undefined;
	const description =
		typeof response.body.error_description === "string" ? response.body.error_description : undefined;
	const detail = [error, description].filter(Boolean).join(": ");
	return new Error(`Kimi OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

function parseDeviceCode(body: JsonObject): KimiDeviceCode {
	// RFC 8628 允许 interval 为 0;非正数/缺失时回退轮询器默认值
	const interval = body.interval;
	const intervalSeconds =
		typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined;
	const verificationUriComplete =
		typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length > 0
			? validateVerificationUri(body.verification_uri_complete)
			: undefined;
	const expiresIn = body.expires_in;
	const expiresInSeconds =
		typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
			? expiresIn
			: DEFAULT_DEVICE_FLOW_TTL_SECONDS;
	return {
		deviceCode: requiredString(body, "device_code"),
		userCode: requiredString(body, "user_code"),
		verificationUri: validateVerificationUri(requiredString(body, "verification_uri")),
		verificationUriComplete,
		intervalSeconds,
		expiresInSeconds,
	};
}

function credentialsFromTokenResponse(body: JsonObject, previousRefreshToken?: string): OAuthCredential {
	const access = requiredString(body, "access_token");
	// 刷新响应未轮换 refresh_token 时沿用旧值
	const refresh =
		body.refresh_token === undefined && previousRefreshToken
			? previousRefreshToken
			: requiredString(body, "refresh_token");
	return {
		type: "oauth",
		access,
		refresh,
		expires: Date.now() + positiveNumber(body, "expires_in") * 1000 - REFRESH_SKEW_MS,
	};
}

async function requestDeviceCode(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<KimiDeviceCode> {
	const response = await postForm(
		fetchImpl,
		`${resolveOAuthHost()}/api/oauth/device_authorization`,
		{ client_id: KIMI_CLIENT_ID },
		signal,
	);
	if (!response.ok) {
		throw requestFailure("device authorization", response);
	}
	return parseDeviceCode(response.body);
}

async function pollForTokens(
	fetchImpl: typeof fetch,
	device: KimiDeviceCode,
	signal?: AbortSignal,
): Promise<OAuthCredential> {
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await postForm(
				fetchImpl,
				`${resolveOAuthHost()}/api/oauth/token`,
				{
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: KIMI_CLIENT_ID,
					device_code: device.deviceCode,
				},
				signal,
			);

			if (response.ok) {
				return { status: "complete", value: credentialsFromTokenResponse(response.body) };
			}

			const error = response.body.error;
			if (error === "authorization_pending") {
				return { status: "pending" };
			}
			if (error === "slow_down") {
				const interval = response.body.interval;
				return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
			}
			if (error === "access_denied") {
				return { status: "failed", message: "Kimi device authorization denied" };
			}
			if (error === "expired_token") {
				return { status: "failed", message: "Kimi device authorization expired" };
			}
			return { status: "failed", message: requestFailure("device token polling", response).message };
		},
	});
}

async function loginKimi(fetchImpl: typeof fetch, interaction: AuthInteraction): Promise<OAuthCredential> {
	const device = await requestDeviceCode(fetchImpl, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete ?? device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	return pollForTokens(fetchImpl, device, interaction.signal);
}

async function refreshKimi(
	fetchImpl: typeof fetch,
	refreshToken: string,
	signal?: AbortSignal,
): Promise<OAuthCredential> {
	const response = await postForm(
		fetchImpl,
		`${resolveOAuthHost()}/api/oauth/token`,
		{
			grant_type: "refresh_token",
			client_id: KIMI_CLIENT_ID,
			refresh_token: refreshToken,
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("token refresh", response);
	}
	return credentialsFromTokenResponse(response.body, refreshToken);
}

export function createKimiCodeOAuth(options: KimiCodeOAuthOptions = {}): OAuthAuth {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	return {
		name: "Kimi Code",
		loginLabel: "Sign in with Kimi",
		login: (interaction) => loginKimi(fetchImpl, interaction),
		refresh: (credential, signal) => refreshKimi(fetchImpl, credential.refresh, signal),
		async toAuth(credential) {
			// resolveStoredOAuth 会包上 { auth, source };此处只派生请求鉴权(xai 同款语义)
			return { apiKey: credential.access };
		},
	};
}

/** 默认实例绑定:coordinator 的 load.ts / bun-oauth.ts 接线直接引用此常量 */
export const kimiCodeOAuth: OAuthAuth = createKimiCodeOAuth();
