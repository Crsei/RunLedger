import { runtimeDigest } from "../protocol/foundation.ts";
import type {
	ContextAssemblyReceipt,
	ContextAssemblyRequest,
	ContextFragment,
	ContextLayer,
} from "./types.ts";
import { isContextAssemblyRequest, isContextFragment } from "./schema.ts";
import { TokenEstimator } from "./token-estimator.ts";

export const CONTEXT_LAYER_ORDER = [
	"identity",
	"policy",
	"mode",
	"resources",
	"history",
	"memory",
	"task",
] as const satisfies readonly ContextLayer[];

const PRIORITY_ORDER = { required: 0, normal: 1, optional: 2 } as const;
const PROTECTED_LAYERS = new Set<ContextLayer>(["identity", "policy", "mode"]);

type ContextDigest = ContextFragment["contentDigest"];
type ContextDiagnostic = ContextAssemblyReceipt["diagnostics"][number];
type ContextOmission = ContextAssemblyReceipt["omittedFragments"][number];
type SourceHead = ContextAssemblyReceipt["sourceHead"];
type FragmentLimits = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

export interface ContextAssemblyOptions {
	readonly fragmentHardCaps?: FragmentLimits;
	readonly fragmentHardCharCaps?: FragmentLimits;
	readonly contentByFragmentId?: Readonly<Record<string, string>>;
	readonly sourceHead?: SourceHead;
	readonly projectionDigest?: ContextDigest;
}

export interface ContextEngineOptions extends ContextAssemblyOptions {
	readonly estimator?: TokenEstimator;
	readonly clock?: () => Date;
}

export interface AssembledContext {
	readonly fragments: readonly ContextFragment[];
	readonly receipt: ContextAssemblyReceipt;
}

export class ContextAssemblyError extends Error {
	public readonly code:
		| "invalid_request"
		| "invalid_budget"
		| "required_fragment_exceeds_budget"
		| "fragment_digest_mismatch";
	public readonly diagnostics: readonly ContextDiagnostic[];

	public constructor(
		code: ContextAssemblyError["code"],
		message: string,
		diagnostics: readonly ContextDiagnostic[] = [],
	) {
		super(message);
		this.name = "ContextAssemblyError";
		this.code = code;
		this.diagnostics = diagnostics;
	}
}

export class ContextFragmentRegistryError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "ContextFragmentRegistryError";
	}
}

function layerIndex(layer: ContextLayer): number {
	return CONTEXT_LAYER_ORDER.indexOf(layer);
}

function priorityIndex(priority: ContextFragment["priority"]): number {
	return PRIORITY_ORDER[priority];
}

export function compareContextFragments(left: ContextFragment, right: ContextFragment): number {
	return (
		layerIndex(left.layer) - layerIndex(right.layer) ||
		priorityIndex(left.priority) - priorityIndex(right.priority) ||
		left.order - right.order ||
		left.fragmentId.localeCompare(right.fragmentId) ||
		left.contentDigest.digest.localeCompare(right.contentDigest.digest)
	);
}

export function sortContextFragments(fragments: readonly ContextFragment[]): ContextFragment[] {
	return fragments.slice().sort(compareContextFragments);
}

function sameDigest(left: ContextDigest, right: ContextDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function descriptorDigest(fragment: ContextFragment): ContextDigest {
	return runtimeDigest({
		fragmentId: fragment.fragmentId,
		layer: fragment.layer,
		order: fragment.order,
		contentRef: fragment.contentRef,
		contentDigest: fragment.contentDigest,
		estimatedTokens: fragment.estimatedTokens,
		trust: fragment.trust,
		taint: fragment.taint,
		priority: fragment.priority,
	});
}

/** 以 stable ID 去重，Map 插入顺序不会影响输出顺序或 registry digest。 */
export class ContextFragmentRegistry {
	readonly #fragments = new Map<string, ContextFragment>();

	public get size(): number {
		return this.#fragments.size;
	}

	public register(fragment: ContextFragment): void {
		const candidate: unknown = fragment;
		if (!isContextFragment(candidate)) {
			throw new ContextFragmentRegistryError("invalid context fragment");
		}
		const validFragment = candidate;
		const previous = this.#fragments.get(validFragment.fragmentId);
		if (previous !== undefined && !sameDigest(descriptorDigest(previous), descriptorDigest(validFragment))) {
			throw new ContextFragmentRegistryError(`context fragment ${validFragment.fragmentId} is already registered with a different digest`);
		}
		this.#fragments.set(validFragment.fragmentId, validFragment);
	}

	public registerAll(fragments: readonly ContextFragment[]): void {
		for (const fragment of fragments) this.register(fragment);
	}

	public unregister(fragmentId: string): boolean {
		return this.#fragments.delete(fragmentId);
	}

	public get(fragmentId: string): ContextFragment | undefined {
		return this.#fragments.get(fragmentId);
	}

	public list(): readonly ContextFragment[] {
		return sortContextFragments([...this.#fragments.values()]);
	}

	public digest(): ContextDigest {
		return runtimeDigest(this.list().map(descriptorDigest));
	}
}

function lookupLimit(limits: FragmentLimits | undefined, fragmentId: string): number | undefined {
	if (limits === undefined) return undefined;
	if (limits instanceof Map) return limits.get(fragmentId);
	const record = limits as Readonly<Record<string, number>>;
	return Object.hasOwn(record, fragmentId) ? record[fragmentId] : undefined;
}

function isProtected(fragment: ContextFragment): boolean {
	return fragment.priority === "required" || PROTECTED_LAYERS.has(fragment.layer);
}

function diagnostic(code: string, severity: ContextDiagnostic["severity"], message: string): ContextDiagnostic {
	return { code, severity, message: message.slice(0, 2048) };
}

function omission(fragment: ContextFragment, reasonCode: string): ContextOmission {
	return { fragmentId: fragment.fragmentId, reasonCode };
}

function boundDiagnostics(diagnostics: readonly ContextDiagnostic[]): ContextDiagnostic[] {
	if (diagnostics.length <= 64) return [...diagnostics];
	const omittedCount = diagnostics.length - 63;
	return [
		...diagnostics.slice(0, 63),
		diagnostic("diagnostics_truncated", "warning", `${omittedCount} additional context diagnostics were omitted from the bounded receipt`),
	];
}

function invalidBudget(request: ContextAssemblyRequest): boolean {
	return (
		Number.isSafeInteger(request.contextWindow) && request.contextWindow >= 1 &&
		Number.isSafeInteger(request.outputReserve) && request.outputReserve >= 0 &&
		Number.isSafeInteger(request.toolReserve) && request.toolReserve >= 0 &&
		request.outputReserve <= request.contextWindow &&
		request.toolReserve <= request.contextWindow - request.outputReserve
	);
}

function hasNumericBudget(request: ContextAssemblyRequest): boolean {
	return (
		typeof request.contextWindow === "number" &&
		typeof request.outputReserve === "number" &&
		typeof request.toolReserve === "number"
	);
}

function defaultSourceHead(request: ContextAssemblyRequest, contextDigest: ContextDigest): SourceHead {
	return {
		streamId: request.traceId,
		sequence: 0,
		eventHash: runtimeDigest({ traceId: request.traceId, contextDigest }),
	};
}

export class ContextEngine {
	readonly #estimator: TokenEstimator;
	readonly #clock: () => Date;
	readonly #defaults: ContextAssemblyOptions;

	public constructor(options: ContextEngineOptions = {}) {
		this.#estimator = options.estimator ?? new TokenEstimator();
		this.#clock = options.clock ?? (() => new Date());
		this.#defaults = options;
	}

	public assemble(request: ContextAssemblyRequest, options: ContextAssemblyOptions = {}): AssembledContext {
		if (!isContextAssemblyRequest(request)) {
			if (hasNumericBudget(request) && !invalidBudget(request)) {
				const issue = diagnostic(
					"missing_context_budget",
					"error",
					"context window must leave a non-negative input budget after output and tool reserves",
				);
				throw new ContextAssemblyError("invalid_budget", issue.message, [issue]);
			}
			throw new ContextAssemblyError("invalid_request", "context assembly request failed schema or identity validation");
		}
		if (!invalidBudget(request)) {
			throw new ContextAssemblyError("invalid_budget", "context assembly request leaves no valid bounded input budget");
		}

		const settings: ContextAssemblyOptions = { ...this.#defaults, ...options };
		const availableTokens = request.contextWindow - request.outputReserve - request.toolReserve;
		const ordered = sortContextFragments(request.fragments);
		const included: ContextFragment[] = [];
		const omittedFragments: ContextOmission[] = [];
		const diagnostics: ContextDiagnostic[] = [];
		let usedTokens = 0;

		for (const fragment of ordered) {
			if (!sameDigest(fragment.contentRef.digest, fragment.contentDigest)) {
				const issue = diagnostic(
					"fragment_digest_mismatch",
					"error",
					`fragment ${fragment.fragmentId} content reference digest does not match its descriptor`,
				);
				throw new ContextAssemblyError("fragment_digest_mismatch", issue.message, [issue]);
			}
			const content = settings.contentByFragmentId?.[fragment.fragmentId];
			if (content !== undefined && !sameDigest(runtimeDigest(content), fragment.contentDigest)) {
				const issue = diagnostic(
					"fragment_digest_mismatch",
					"error",
					`fragment ${fragment.fragmentId} content digest does not match its descriptor`,
				);
				throw new ContextAssemblyError("fragment_digest_mismatch", issue.message, [issue]);
			}

			const estimatedTokens = content === undefined
				? fragment.estimatedTokens
				: Math.max(fragment.estimatedTokens, this.#estimator.estimate(content));
			const hardTokenCap = lookupLimit(settings.fragmentHardCaps, fragment.fragmentId);
			const hardCharCap = lookupLimit(settings.fragmentHardCharCaps, fragment.fragmentId);
			const characterCount = content === undefined ? (fragment.contentRef.size ?? 0) : content.length;
			const exceedsOwnTokenCap = hardTokenCap !== undefined && estimatedTokens > hardTokenCap;
			const exceedsOwnCharCap = hardCharCap !== undefined && characterCount > hardCharCap;
			if (exceedsOwnTokenCap || exceedsOwnCharCap) {
				const reasonCode = fragment.taint === "tool_output" ? "oversized_tool_result" : "fragment_cap_exceeded";
				const code = fragment.taint === "tool_output" ? "oversized_tool_result" : "fragment_cap_exceeded";
				const issue = diagnostic(
					code,
					isProtected(fragment) ? "error" : "warning",
					`fragment ${fragment.fragmentId} exceeds its declared hard cap`,
				);
				if (isProtected(fragment)) {
					throw new ContextAssemblyError("required_fragment_exceeds_budget", issue.message, [issue]);
				}
				omittedFragments.push(omission(fragment, reasonCode));
				diagnostics.push(issue);
				continue;
			}

			if (estimatedTokens > availableTokens - usedTokens) {
				const issue = diagnostic(
					"context_budget_exceeded",
					isProtected(fragment) ? "error" : "warning",
					`fragment ${fragment.fragmentId} cannot fit the remaining context budget`,
				);
				if (isProtected(fragment)) {
					throw new ContextAssemblyError("required_fragment_exceeds_budget", issue.message, [issue]);
				}
				omittedFragments.push(omission(fragment, "budget_exceeded"));
				diagnostics.push(issue);
				continue;
			}

			included.push(fragment);
			usedTokens += estimatedTokens;
		}

		const includedDescriptors = included.map((fragment) => ({
			fragmentId: fragment.fragmentId,
			layer: fragment.layer,
			order: fragment.order,
			contentDigest: fragment.contentDigest,
			estimatedTokens: contentEstimate(fragment, settings.contentByFragmentId, this.#estimator),
		}));
		const contextDigest = runtimeDigest(includedDescriptors);
		const sourceHead = settings.sourceHead ?? defaultSourceHead(request, contextDigest);
		const projectionDigest = settings.projectionDigest ?? runtimeDigest({
			fragmentIds: included.map((fragment) => fragment.fragmentId),
			contentRefs: included.map((fragment) => fragment.contentRef),
		});
		const boundedDiagnostics = boundDiagnostics(diagnostics);
		const receipt: ContextAssemblyReceipt = {
			requestId: request.requestId,
			modelProfileId: request.modelProfileId,
			fragmentIds: included.map((fragment) => fragment.fragmentId),
			omittedFragments,
			estimatedInputTokens: usedTokens,
			reservedOutputTokens: request.outputReserve,
			contextDigest,
			diagnostics: boundedDiagnostics,
			sourceHead,
			projectionDigest,
			assembledAt: this.#clock().toISOString(),
		};
		return { fragments: included, receipt };
	}
}

function contentEstimate(
	fragment: ContextFragment,
	contentByFragmentId: Readonly<Record<string, string>> | undefined,
	estimator: TokenEstimator,
): number {
	const content = contentByFragmentId?.[fragment.fragmentId];
	return content === undefined ? fragment.estimatedTokens : Math.max(fragment.estimatedTokens, estimator.estimate(content));
}
