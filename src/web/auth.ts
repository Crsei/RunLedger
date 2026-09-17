import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

function equal(value: string, expected: string): boolean {
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** 每次显式启动独立认证；Web 凭据绝不复用 Owner token。 */
export class WebAuth {
  private bootstrap: string | undefined = randomBytes(32).toString("base64url");
  private readonly session = randomBytes(32).toString("base64url");
  private readonly cookieName = `rl_web_${randomBytes(8).toString("hex")}`;
  private stopped = false;
  loginUrl(origin: string): string { return `${origin}/#${this.bootstrap ?? ""}`; }
  sameOrigin(request: IncomingMessage, origin: string): boolean {
    return request.headers.host === new URL(origin).host
      && (request.headers.origin === undefined || request.headers.origin === origin)
      && !["cross-site", "same-site"].includes(String(request.headers["sec-fetch-site"] ?? ""));
  }
  exchange(request: IncomingMessage, response: ServerResponse, origin: string, value: unknown): boolean {
    if (this.stopped || request.headers.origin !== origin || !this.sameOrigin(request, origin)
      || typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).join() !== "token"
      || !("token" in value) || typeof value.token !== "string" || this.bootstrap === undefined || !equal(value.token, this.bootstrap)) return false;
    this.bootstrap = undefined;
    response.setHeader("Set-Cookie", `${this.cookieName}=${this.session}; HttpOnly; SameSite=Strict; Path=/api/v1`);
    return true;
  }
  authenticated(request: IncomingMessage): boolean {
    if (this.stopped) return false;
    const matches = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${this.cookieName}=`));
    return matches.length === 1 && equal(matches[0].slice(this.cookieName.length + 1), this.session);
  }
  close(): void { this.stopped = true; this.bootstrap = undefined; }
}
