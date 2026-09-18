/**
 * GitHub REST 的只读、受治理子集。
 *
 * 上游 `github` 工具同时包含 PR 创建、checkout 与 push；这里刻意只保留
 * repository/file/search 查询。调用方必须注入 `WebSearchFetch`，因此本模块
 * 不读取环境变量，也不直接调用全局 fetch。
 */

import type { WebSearchCredentialPort } from "./credentials.ts";
import type { WebSearchFetch } from "./transport.ts";

export const GITHUB_READ_OPERATIONS = [
	"repo_view",
	"file_read",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
] as const;

export type GitHubReadOperation = (typeof GITHUB_READ_OPERATIONS)[number];

export interface GitHubReadInput {
	readonly op: GitHubReadOperation;
	readonly repo?: string;
	readonly path?: string;
	readonly ref?: string;
	readonly query?: string;
	readonly limit?: number;
}

export interface GitHubReadDetails {
	readonly op: GitHubReadOperation;
	readonly endpoint: string;
	readonly status?: number;
	readonly truncated?: boolean;
}

export type GitHubReadResult =
	| { readonly ok: true; readonly text: string; readonly details: GitHubReadDetails }
	| { readonly ok: false; readonly text: string; readonly details: GitHubReadDetails };

export interface GitHubReadOptions {
	readonly fetch: WebSearchFetch;
	readonly credentials: WebSearchCredentialPort;
	/** 结果在进入 AgentTool 前的硬上限；默认 32 KiB。 */
	readonly maxResultChars?: number;
}

const GITHUB_API = "https://api.github.com";
const DEFAULT_LIMIT = 10;
const MAX_RESULT_CHARS = 32_000;
const REPOSITORY_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const REF_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;

/** 执行一个固定 GitHub REST read endpoint；任意 URL 均不属于输入面。 */
export async function executeGitHubRead(input: GitHubReadInput, options: GitHubReadOptions, signal?: AbortSignal): Promise<GitHubReadResult> {
	const endpoint = endpointFor(input);
	const details = (status?: number, truncated?: boolean): GitHubReadDetails => ({
		op: input.op,
		endpoint,
		...(status === undefined ? {} : { status }),
		...(truncated === undefined ? {} : { truncated }),
	});
	const headers: Record<string, string> = {
		Accept: input.op === "search_commits"
			? "application/vnd.github+json, application/vnd.github.cloak-preview+json"
			: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const token = await options.credentials.getApiKey("github");
	if (token !== undefined && token.trim().length > 0) headers.Authorization = `Bearer ${token}`;

	let response: Response;
	try {
		response = await options.fetch(`${GITHUB_API}${endpoint}`, { method: "GET", headers, signal });
	} catch {
		return { ok: false, text: "GitHub request could not be delivered through the governed network.", details: details() };
	}
	if (!response.ok) {
		return { ok: false, text: renderHttpFailure(response.status), details: details(response.status) };
	}
	try {
		if (input.op === "file_read") {
			const rendered = renderFile(await response.json());
			return bounded(rendered, details(response.status), options.maxResultChars);
		}
		if (input.op === "repo_view") {
			const rendered = renderRepo(await response.json());
			return bounded(rendered, details(response.status), options.maxResultChars);
		}
		const rendered = renderSearch(input.op, await response.json());
		return bounded(rendered, details(response.status), options.maxResultChars);
	} catch {
		return { ok: false, text: "GitHub returned an invalid response body.", details: details(response.status) };
	}
}

function endpointFor(input: GitHubReadInput): string {
	switch (input.op) {
		case "repo_view": {
			const repo = requireRepo(input.repo);
			return `/repos/${repo.owner}/${repo.repo}`;
		}
		case "file_read": {
			const repo = requireRepo(input.repo);
			const path = repositoryPath(input.path);
			const query = input.ref === undefined ? "" : `?ref=${encodeURIComponent(ref(input.ref))}`;
			return `/repos/${repo.owner}/${repo.repo}/contents/${path}${query}`;
		}
		case "search_issues": return searchEndpoint("issues", searchQuery(input.query, "is:issue"), input.limit);
		case "search_prs": return searchEndpoint("issues", searchQuery(input.query, "is:pr"), input.limit);
		case "search_code": return searchEndpoint("code", searchQuery(input.query), input.limit);
		case "search_commits": return searchEndpoint("commits", searchQuery(input.query), input.limit);
		case "search_repos": return searchEndpoint("repositories", searchQuery(input.query), input.limit);
	}
}

function requireRepo(value: string | undefined): { readonly owner: string; readonly repo: string } {
	if (value === undefined) throw new Error("github: repo is required for this operation");
	const parts = value.split("/");
	if (parts.length !== 2 || !REPOSITORY_COMPONENT.test(parts[0] ?? "") || !REPOSITORY_COMPONENT.test(parts[1] ?? "")) {
		throw new Error("github: repo must be owner/repository");
	}
	return { owner: encodeURIComponent(parts[0]!), repo: encodeURIComponent(parts[1]!) };
}

function repositoryPath(value: string | undefined): string {
	if (value === undefined || value.length === 0 || value.length > 1_024 || value.includes("\\") || value.includes("\0")) {
		throw new Error("github: path is required and must be a repository-relative path");
	}
	const parts = value.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw new Error("github: path escapes repository root");
	return parts.map(encodeURIComponent).join("/");
}

function ref(value: string): string {
	if (!REF_COMPONENT.test(value) || value.includes("..")) throw new Error("github: ref is invalid");
	return value;
}

function searchQuery(value: string | undefined, suffix?: string): string {
	if (value === undefined || value.trim().length === 0 || value.length > 4_096) throw new Error("github: query is required for this operation");
	return suffix === undefined ? value.trim() : `${value.trim()} ${suffix}`;
}

function searchEndpoint(kind: "issues" | "code" | "commits" | "repositories", query: string, requested: number | undefined): string {
	const limit = requested ?? DEFAULT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("github: limit must be an integer between 1 and 50");
	return `/search/${kind}?q=${encodeURIComponent(query)}&per_page=${limit}`;
}

function renderRepo(value: unknown): string {
	const record = object(value);
	if (record === undefined) throw new Error("invalid repository payload");
	return [
		`# ${text(record.full_name) ?? text(record.name) ?? "Repository"}`,
		...(text(record.description) === undefined ? [] : [text(record.description)!]),
		`- visibility: ${text(record.visibility) ?? (record.private === true ? "private" : "public")}`,
		...(text(record.default_branch) === undefined ? [] : [`- default branch: ${text(record.default_branch)!}`]),
		...(number(record.stargazers_count) === undefined ? [] : [`- stars: ${number(record.stargazers_count)!}`]),
		...(text(record.html_url) === undefined ? [] : [`- url: ${text(record.html_url)!}`]),
	].join("\n");
}

function renderFile(value: unknown): string {
	const record = object(value);
	if (record === undefined || Array.isArray(value)) throw new Error("GitHub path is a directory; use repo_view or a file path");
	if (record.type !== "file" || typeof record.content !== "string" || record.encoding !== "base64") throw new Error("GitHub did not return a readable text file");
	const bytes = Buffer.from(record.content.replace(/\s/gu, ""), "base64");
	if (bytes.byteLength === 0 && number(record.size) !== 0) throw new Error("GitHub file content is invalid");
	if (isProbablyBinary(bytes)) {
		const source = text(record.html_url) ?? "the GitHub file view";
		return `[Cannot read binary file (${bytes.byteLength} bytes). Open ${source} to view it.]`;
	}
	return bytes.toString("utf8");
}

function renderSearch(op: Exclude<GitHubReadOperation, "repo_view" | "file_read">, value: unknown): string {
	const record = object(value);
	const items = record === undefined || !Array.isArray(record.items) ? undefined : record.items;
	if (items === undefined) throw new Error("invalid GitHub search payload");
	const title = op.replace("search_", "GitHub ").replace(/_/gu, " ");
	const total = record === undefined ? undefined : number(record.total_count);
	const lines = [`# ${title}`, `results: ${total ?? items.length}`];
	for (const item of items) {
		const entry = object(item);
		if (entry === undefined) continue;
		const label = text(entry.full_name) ?? text(entry.title) ?? text(entry.name) ?? text(entry.sha) ?? "untitled";
		const url = text(entry.html_url) ?? text(entry.url);
		const description = text(entry.description) ?? text(entry.body);
		lines.push(`- ${label}${url === undefined ? "" : ` — ${url}`}${description === undefined ? "" : `\n  ${description.replace(/\s+/gu, " ").slice(0, 500)}`}`);
	}
	return lines.join("\n");
}

function bounded(text: string, details: GitHubReadDetails, configured?: number): GitHubReadResult {
	const max = configured ?? MAX_RESULT_CHARS;
	if (!Number.isSafeInteger(max) || max < 1) throw new Error("github: result bound is invalid");
	if (text.length <= max) return { ok: true, text, details };
	return {
		ok: true,
		text: `${text.slice(0, max)}\n\n[GitHub result truncated at ${max} characters.]`,
		details: { ...details, truncated: true },
	};
}

function renderHttpFailure(status: number): string {
	if (status === 401) return "GitHub authentication failed; configure a valid GitHub credential.";
	if (status === 403) return "GitHub denied this request or its rate limit has been reached.";
	if (status === 404) return "GitHub repository, file, or search resource was not found.";
	if (status === 422) return "GitHub rejected the repository reference or search query.";
	return `GitHub request failed with HTTP ${status}.`;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isProbablyBinary(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
	if (sample.includes(0)) return true;
	let controls = 0;
	for (const value of sample) {
		if (value < 0x09 || (value > 0x0d && value < 0x20)) controls += 1;
	}
	return sample.length > 0 && controls / sample.length > 0.1;
}
