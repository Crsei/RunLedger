import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const AUTH_GATEWAY_TOKEN_FILE = "auth-gateway.token";
export const AUTH_GATEWAY_TOKEN_MODE = 0o600;

/** Return the canonical bearer-token path below a RunLedger home directory. */
export function authGatewayTokenPath(home: string): string {
	return join(home, AUTH_GATEWAY_TOKEN_FILE);
}

/** Generate a URL-safe token; the raw secret is never logged by this module. */
export function generateAuthGatewayToken(): string {
	return randomBytes(32).toString("base64url");
}

/** Constant-time comparison for bearer secrets, including a length check. */
export function timingSafeTokenEqual(expected: string, provided: string): boolean {
	const expectedBytes = Buffer.from(expected, "utf8");
	const providedBytes = Buffer.from(provided, "utf8");
	if (expectedBytes.length === 0 || expectedBytes.length !== providedBytes.length) return false;
	return timingSafeEqual(expectedBytes, providedBytes);
}

/** Parse the RFC 6750 bearer form without accepting an empty or multi-token value. */
export function parseBearerToken(authorization: string | undefined): string | undefined {
	if (authorization === undefined) return undefined;
	const match = /^Bearer\s+(\S+)$/iu.exec(authorization.trim());
	return match?.[1];
}

async function persistToken(path: string, token: string): Promise<void> {
	if (token.length === 0 || /\s/u.test(token)) throw new Error("Auth gateway token must be a non-empty value without whitespace");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await writeFile(temporaryPath, `${token}\n`, { encoding: "utf8", mode: AUTH_GATEWAY_TOKEN_MODE });
		await chmod(temporaryPath, AUTH_GATEWAY_TOKEN_MODE);
		await rename(temporaryPath, path);
		await chmod(path, AUTH_GATEWAY_TOKEN_MODE);
	} finally {
		try {
			await unlink(temporaryPath);
		} catch {
			// The temporary file was normally moved; cleanup is best effort.
		}
	}
}

async function readExistingToken(path: string): Promise<string | undefined> {
	try {
		const token = (await readFile(path, "utf8")).trim();
		if (token.length === 0) return undefined;
		await chmod(path, AUTH_GATEWAY_TOKEN_MODE);
		return token;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Could not read auth gateway token file: ${path}`, { cause: error });
	}
}

/** Ensure the canonical token exists and return it without regenerating a valid secret. */
export async function ensureAuthGatewayToken(path: string): Promise<string> {
	const existing = await readExistingToken(path);
	if (existing !== undefined) return existing;
	const token = generateAuthGatewayToken();
	await persistToken(path, token);
	return token;
}

/** Replace the canonical token and return the new secret exactly once to the caller. */
export async function regenerateAuthGatewayToken(path: string): Promise<string> {
	const token = generateAuthGatewayToken();
	await persistToken(path, token);
	return token;
}

/** Read a token for status checks without creating or modifying the file. */
export async function readAuthGatewayToken(path: string): Promise<string | undefined> {
	return readExistingToken(path);
}
