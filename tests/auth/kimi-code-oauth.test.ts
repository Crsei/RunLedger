import { afterEach, describe, expect, test, vi } from "vitest";
import { createKimiCodeOAuth, kimiCodeOAuth } from "../../src/auth/oauth/kimi-code.ts";
import type { AuthEvent, AuthInteraction, OAuthCredential } from "../../src/auth/types.ts";

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_OAUTH_HOST = "https://auth.kimi.test";
const TOKEN_URL = `${KIMI_OAUTH_HOST}/api/oauth/token`;
const DEVICE_URL = `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`;

const DEVICE_AUTHORIZATION = {
	user_code: "ABCD-EFGH",
	device_code: "device-1",
	verification_uri: "https://kimi.com/activate",
	verification_uri_complete: "https://kimi.com/activate?code=ABCD-EFGH",
	expires_in: 900,
	interval: 1,
};

type RecordedRequest = { url: string; init: RequestInit | undefined };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function recordFetch(
	responses: ReadonlyArray<(request: RecordedRequest) => Response>,
): { fetchImpl: typeof fetch; calls: RecordedRequest[] } {
	const calls: RecordedRequest[] = [];
	let index = 0;
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = { url: String(input), init };
		calls.push(request);
		const response = responses[Math.min(index, responses.length - 1)];
		index += 1;
		return response(request);
	};
	return { fetchImpl, calls };
}

function formBody(init: RequestInit | undefined): URLSearchParams {
	return new URLSearchParams(init?.body as string);
}

function silentInteraction(): AuthInteraction {
	return {
		prompt: async () => "",
		notify: () => undefined,
	};
}

function oauthCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
	return { type: "oauth", access: "access-1", refresh: "refresh-1", expires: 1, ...overrides };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("Kimi Code OAuth flow", () => {
	test("exposes the default binding and derives request auth from the access token", async () => {
		expect(kimiCodeOAuth.name).toBe("Kimi Code");
		expect(kimiCodeOAuth.loginLabel).toBe("Sign in with Kimi");
		expect(typeof kimiCodeOAuth.login).toBe("function");
		expect(typeof kimiCodeOAuth.refresh).toBe("function");

		await expect(kimiCodeOAuth.toAuth(oauthCredential())).resolves.toEqual({ apiKey: "access-1" });
	});

	test("completes the device flow through pending polling", async () => {
		vi.useFakeTimers();
		vi.stubEnv("KIMI_CODE_OAUTH_HOST", KIMI_OAUTH_HOST);
		const { fetchImpl, calls } = recordFetch([
			() => jsonResponse(DEVICE_AUTHORIZATION),
			() => jsonResponse({ error: "authorization_pending" }, 400),
			() => jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
		]);
		const oauth = createKimiCodeOAuth({ fetch: fetchImpl });
		const events: AuthEvent[] = [];
		const interaction: AuthInteraction = { prompt: async () => "", notify: (event) => events.push(event) };

		const loginPromise = oauth.login(interaction);
		await vi.advanceTimersByTimeAsync(1000); // 首次轮询前等待
		await vi.advanceTimersByTimeAsync(1000); // pending 后再次等待
		const credential = await loginPromise;

		expect(credential).toMatchObject({ type: "oauth", access: "access-1", refresh: "refresh-1" });
		expect(credential.expires - Date.now()).toBe(3600 * 1000 - 5 * 60 * 1000);

		expect(events).toEqual([
			{
				type: "device_code",
				userCode: "ABCD-EFGH",
				verificationUri: "https://kimi.com/activate?code=ABCD-EFGH",
				intervalSeconds: 1,
				expiresInSeconds: 900,
			},
		]);

		expect(calls.map((call) => call.url)).toEqual([DEVICE_URL, TOKEN_URL, TOKEN_URL]);
		const device = calls[0];
		expect(device.init?.method).toBe("POST");
		expect(formBody(device.init).get("client_id")).toBe(KIMI_CLIENT_ID);
		expect(formBody(calls[1]?.init).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(formBody(calls[1]?.init).get("device_code")).toBe("device-1");
		expect(formBody(calls[1]?.init).get("client_id")).toBe(KIMI_CLIENT_ID);

		for (const call of calls) {
			const headers = call.init?.headers as Record<string, string>;
			expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
			expect(headers["User-Agent"]).toBe("KimiCLI/1.0");
			expect(headers["X-Msh-Platform"]).toBe("kimi_cli");
			expect(headers["X-Msh-Version"]).toBe("1.0");
			expect(headers["X-Msh-Device-Name"]?.length).toBeGreaterThan(0);
			expect(headers["X-Msh-Device-Model"]?.length).toBeGreaterThan(0);
			expect(headers["X-Msh-Os-Version"]?.length).toBeGreaterThan(0);
			expect(headers["X-Msh-Device-Id"]?.length).toBeGreaterThan(0);
		}
	});

	test("refreshes the token and keeps the previous refresh token when not rotated", async () => {
		vi.stubEnv("KIMI_CODE_OAUTH_HOST", KIMI_OAUTH_HOST);
		const { fetchImpl, calls } = recordFetch([
			() => jsonResponse({ access_token: "access-2", expires_in: 1800 }),
		]);
		const oauth = createKimiCodeOAuth({ fetch: fetchImpl });

		const credential = await oauth.refresh(oauthCredential());

		expect(credential).toMatchObject({ type: "oauth", access: "access-2", refresh: "refresh-1" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(TOKEN_URL);
		const body = formBody(calls[0]?.init);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("refresh-1");
		expect(body.get("client_id")).toBe(KIMI_CLIENT_ID);
	});

	test("rejects when the device code expires", async () => {
		vi.useFakeTimers();
		vi.stubEnv("KIMI_CODE_OAUTH_HOST", KIMI_OAUTH_HOST);
		const { fetchImpl } = recordFetch([
			() => jsonResponse(DEVICE_AUTHORIZATION),
			() => jsonResponse({ error: "expired_token" }, 400),
		]);
		const oauth = createKimiCodeOAuth({ fetch: fetchImpl });

		const loginPromise = oauth.login(silentInteraction());
		loginPromise.catch(() => undefined); // 先挂 handler,避免 fake timers 下的 unhandled rejection 竞态
		const rejection = expect(loginPromise).rejects.toThrow("Kimi device authorization expired");
		await vi.advanceTimersByTimeAsync(1000);
		await rejection;
	});

	test("rejects when the user denies the request", async () => {
		vi.useFakeTimers();
		vi.stubEnv("KIMI_CODE_OAUTH_HOST", KIMI_OAUTH_HOST);
		const { fetchImpl } = recordFetch([
			() => jsonResponse(DEVICE_AUTHORIZATION),
			() => jsonResponse({ error: "access_denied", error_description: "user said no" }, 400),
		]);
		const oauth = createKimiCodeOAuth({ fetch: fetchImpl });

		const loginPromise = oauth.login(silentInteraction());
		loginPromise.catch(() => undefined); // 先挂 handler,避免 fake timers 下的 unhandled rejection 竞态
		const rejection = expect(loginPromise).rejects.toThrow("Kimi device authorization denied");
		await vi.advanceTimersByTimeAsync(1000);
		await rejection;
	});

	test("rejects non-https verification URIs before opening the browser", async () => {
		vi.stubEnv("KIMI_CODE_OAUTH_HOST", KIMI_OAUTH_HOST);
		const { fetchImpl } = recordFetch([
			() => jsonResponse({ ...DEVICE_AUTHORIZATION, verification_uri: "http://kimi.com/activate" }),
		]);
		const oauth = createKimiCodeOAuth({ fetch: fetchImpl });

		await expect(oauth.login(silentInteraction())).rejects.toThrow("Untrusted verification URI in Kimi OAuth response");
	});

	test("rejects device responses with missing required fields", async () => {
		vi.stubEnv("KIMI_CODE_OAUTH_HOST", KIMI_OAUTH_HOST);
		const { fetchImpl } = recordFetch([
			() => jsonResponse({ device_code: "device-1", verification_uri: "https://kimi.com/activate" }),
		]);
		const oauth = createKimiCodeOAuth({ fetch: fetchImpl });

		await expect(oauth.login(silentInteraction())).rejects.toThrow("Invalid Kimi OAuth response field: user_code");
	});

	test("uses the ambient global fetch when no fetch is injected", async () => {
		vi.useFakeTimers();
		vi.stubEnv("KIMI_CODE_OAUTH_HOST", KIMI_OAUTH_HOST);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) =>
				String(input).includes("/api/oauth/device_authorization")
					? jsonResponse(DEVICE_AUTHORIZATION)
					: jsonResponse({ access_token: "access-ambient", refresh_token: "refresh-ambient", expires_in: 3600 }),
			);
		const oauth = createKimiCodeOAuth();

		const loginPromise = oauth.login(silentInteraction());
		await vi.advanceTimersByTimeAsync(1000); // 首次轮询前等待 → 设备码请求 + 首次轮询
		const credential = await loginPromise;

		expect(credential).toMatchObject({ access: "access-ambient", refresh: "refresh-ambient" });
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(DEVICE_URL);
	});
});
