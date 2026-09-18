/** 受治理 GitHub REST 只读工具。 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";
import {
	executeGitHubRead,
	type GitHubReadDetails,
	type GitHubReadInput,
	type GitHubReadOperation,
} from "../../websource/github-read.ts";
import type { WebSearchCredentialPort } from "../../websource/credentials.ts";
import type { WebSearchFetch } from "../../websource/transport.ts";

const operation = Type.Union([
	Type.Literal("repo_view"),
	Type.Literal("file_read"),
	Type.Literal("search_issues"),
	Type.Literal("search_prs"),
	Type.Literal("search_code"),
	Type.Literal("search_commits"),
	Type.Literal("search_repos"),
]);

export const githubSchema = Type.Object({
	op: operation,
	repo: Type.Optional(Type.String({ maxLength: 201, description: "Repository in owner/repository form; required by repo_view and file_read." })),
	path: Type.Optional(Type.String({ maxLength: 1_024, description: "Repository-relative file path; required by file_read." })),
	ref: Type.Optional(Type.String({ maxLength: 256, description: "Branch, tag, or commit ref for file_read." })),
	query: Type.Optional(Type.String({ maxLength: 4_096, description: "GitHub search query; required by search operations." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum search results (default 10)." })),
}, { additionalProperties: false });

export type GitHubToolInput = Static<typeof githubSchema>;

export interface GithubToolOptions {
	readonly fetch: WebSearchFetch;
	readonly credentials: WebSearchCredentialPort;
}

export function createGithubTool(options: GithubToolOptions): AgentTool<typeof githubSchema, GitHubReadDetails> {
	return {
		name: "github",
		label: "GitHub",
		description: "Read GitHub repository metadata, text files, and public issue, pull request, code, commit, or repository search results. This tool cannot create, checkout, or push pull requests.",
		parameters: githubSchema,
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		async execute(_toolCallId, params, signal) {
			const input: GitHubReadInput = {
				op: params.op as GitHubReadOperation,
				...(params.repo === undefined ? {} : { repo: params.repo }),
				...(params.path === undefined ? {} : { path: params.path }),
				...(params.ref === undefined ? {} : { ref: params.ref }),
				...(params.query === undefined ? {} : { query: params.query }),
				...(params.limit === undefined ? {} : { limit: params.limit }),
			};
			const result = await executeGitHubRead(input, options, signal);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: result.details,
				...(result.ok ? {} : { isError: true }),
			};
		},
	};
}
