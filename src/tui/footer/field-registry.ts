import type { ModelThinkingLevel } from "../../types.ts";
import { formatUsageSegments, type UsageDisplayFieldId, type UsageSnapshot } from "../../runtime/usage/index.ts";
import type { StatusLineAccent, StatusLineSegment } from "../highlight/status-style.ts";
import { agentModeBadge, sanitizeLabel } from "../presentation/projectors.ts";
import { visibleWidth } from "../primitives.ts";
import { fitToWidth } from "../components/render-width.ts";

export type FooterRow = "activity" | "identity" | "usage";

export interface FooterSnapshot {
	readonly nowMs: number;
	readonly isStreaming: boolean;
	readonly stopReason?: string;
	readonly runTiming?: {
		readonly state: "working" | "waiting" | "recovery_required";
		readonly activeDurationMs: number;
		readonly lastResumedAtMs?: number;
	};
	readonly providerId?: string;
	readonly modelId: string;
	readonly agentMode?: string;
	readonly toolsSummary?: string;
	readonly permissionProfile?: string;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly workspaceDisplayAbsolutePath?: string;
	readonly gitBranchLabel?: string;
	readonly planProgress?: { readonly completed: number; readonly total: number };
	/** Goal Mode 徽标：status + 已观测用量下界；完整度 partial 时必须标注为下界。 */
	readonly goal?: {
		readonly status: string;
		readonly tokensUsed: number;
		readonly accountingCompleteness: "complete" | "partial";
		readonly continuations: number;
	};
	readonly contextUsage?: { readonly totalTokens?: number; readonly contextWindow?: number };
	readonly usage?: UsageSnapshot;
	readonly threadLabel?: string;
	readonly queue: { readonly steering: number; readonly followUp: number };
}

export interface FooterFieldDefinition {
	readonly id: string;
	readonly row: FooterRow;
	readonly order: number;
	readonly accent: StatusLineAccent;
	/** 缺失表示必保留；数值越小越先在窄屏隐藏。 */
	readonly dropPriority?: number;
	readonly minWidth?: number;
	readonly project: (snapshot: FooterSnapshot) => string | undefined;
}

export interface RegisteredFooterField {
	readonly definition: FooterFieldDefinition;
	readonly registrationSequence: number;
}

export interface ProjectedFooterField {
	readonly id: string;
	readonly segment: StatusLineSegment;
	readonly dropPriority?: number;
	readonly minWidth?: number;
}

export interface ProjectedFooterRow {
	readonly row: FooterRow;
	readonly fields: readonly ProjectedFooterField[];
}

export interface FooterProjectionError {
	readonly fieldId: string;
	readonly code: "projection_failed";
}

export interface FooterProjection {
	readonly rows: readonly ProjectedFooterRow[];
	readonly errors: readonly FooterProjectionError[];
}

export type FooterFieldRegistrationResult =
	| { readonly ok: true; readonly unregister: () => boolean }
	| { readonly ok: false; readonly code: "duplicate_field" | "invalid_definition" | "registry_disposed" };

const ROW_ORDER: readonly FooterRow[] = ["activity", "identity", "usage"];

/** 输入区 Footer 参数注册表；实例归属于单个 InteractiveMode。 */
export class FooterFieldRegistry {
	private readonly entries = new Map<string, RegisteredFooterField>();
	private readonly listeners = new Set<(revision: number) => void>();
	private registrationSequence = 0;
	private currentRevision = 0;
	private disposed = false;

	register(definition: FooterFieldDefinition): FooterFieldRegistrationResult {
		if (this.disposed) return { ok: false, code: "registry_disposed" };
		if (!validDefinition(definition)) return { ok: false, code: "invalid_definition" };
		if (this.entries.has(definition.id)) return { ok: false, code: "duplicate_field" };
		this.registrationSequence += 1;
		this.entries.set(definition.id, { definition, registrationSequence: this.registrationSequence });
		this.notify();
		let active = true;
		return {
			ok: true,
			unregister: () => {
				if (!active) return false;
				active = false;
				return this.unregister(definition.id);
			},
		};
	}

	unregister(id: string): boolean {
		if (this.disposed || !this.entries.delete(id)) return false;
		this.notify();
		return true;
	}

	list(row?: FooterRow): readonly RegisteredFooterField[] {
		return [...this.entries.values()]
			.filter((entry) => row === undefined || entry.definition.row === row)
			.sort(compareEntries);
	}

	project(snapshot: FooterSnapshot): FooterProjection {
		const rows: ProjectedFooterRow[] = [];
		const errors: FooterProjectionError[] = [];
		let errorMarkerAdded = false;
		for (const row of ROW_ORDER) {
			const fields: ProjectedFooterField[] = [];
			for (const entry of this.list(row)) {
				try {
					const text = sanitizeLabel(entry.definition.project(snapshot));
					if (text.length === 0) continue;
					fields.push(projectedField(entry.definition, text));
				} catch {
					errors.push({ fieldId: entry.definition.id, code: "projection_failed" });
					if (!errorMarkerAdded) {
						errorMarkerAdded = true;
						fields.push({
							id: "footer.projection-error",
							segment: { accent: "state", text: "[footer:err]" },
						});
					}
				}
			}
			if (fields.length > 0) rows.push({ row, fields });
		}
		return { rows, errors };
	}

	subscribe(listener: (revision: number) => void): () => void {
		if (this.disposed) return () => {};
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.entries.clear();
		this.notify();
		this.listeners.clear();
	}

	get revision(): number {
		return this.currentRevision;
	}

	private notify(): void {
		this.currentRevision += 1;
		for (const listener of this.listeners) listener(this.currentRevision);
	}
}

/** 注册 RunLedger 自带字段；后续内部模块可在同一实例继续动态注册。 */
export function createDefaultFooterFieldRegistry(): FooterFieldRegistry {
	const registry = new FooterFieldRegistry();
	for (const definition of builtinFooterFields()) registry.register(definition);
	return registry;
}

/** 按 descriptor 的 dropPriority 拟合各行，不依赖渲染后的文案前缀。 */
export function fitProjectedFooterRows(rows: readonly ProjectedFooterRow[], width: number): readonly ProjectedFooterRow[] {
	return rows.map((row) => ({ ...row, fields: fitProjectedFields(row.fields, width) }))
		.filter((row) => row.fields.length > 0);
}

function validDefinition(definition: FooterFieldDefinition): boolean {
	return definition.id.length > 0
		&& definition.id.trim() === definition.id
		&& ROW_ORDER.includes(definition.row)
		&& Number.isSafeInteger(definition.order)
		&& (definition.dropPriority === undefined || (Number.isSafeInteger(definition.dropPriority) && definition.dropPriority >= 0))
		&& (definition.minWidth === undefined || (Number.isSafeInteger(definition.minWidth) && definition.minWidth >= 0));
}

function compareEntries(left: RegisteredFooterField, right: RegisteredFooterField): number {
	const row = ROW_ORDER.indexOf(left.definition.row) - ROW_ORDER.indexOf(right.definition.row);
	if (row !== 0) return row;
	const order = left.definition.order - right.definition.order;
	if (order !== 0) return order;
	const registration = left.registrationSequence - right.registrationSequence;
	if (registration !== 0) return registration;
	return left.definition.id.localeCompare(right.definition.id);
}

function projectedField(definition: FooterFieldDefinition, text: string): ProjectedFooterField {
	return {
		id: definition.id,
		segment: { accent: definition.accent, text },
		...(definition.dropPriority === undefined ? {} : { dropPriority: definition.dropPriority }),
		...(definition.minWidth === undefined ? {} : { minWidth: definition.minWidth }),
	};
}

function builtinFooterFields(): readonly FooterFieldDefinition[] {
	return [
		field("activity.queue", "activity", 10, "metadata", queueText),
		{ ...field("identity.mode", "identity", 0, "state", (snapshot) => agentModeBadge(snapshot.agentMode)), minWidth: 13 },
		field("identity.tools", "identity", 45, "metadata", toolsText, 10),
		field("identity.permission", "identity", 46, "metadata", (snapshot) => snapshot.permissionProfile === undefined ? undefined : `Permission: ${snapshot.permissionProfile}`, 60),
		field("identity.state", "identity", 10, "state", statusText),
		field("identity.path", "identity", 20, "path", (snapshot) => snapshot.workspaceDisplayAbsolutePath),
		field("identity.branch", "identity", 30, "branch", (snapshot) => snapshot.gitBranchLabel, 50),
		field("identity.model", "identity", 40, "model", modelText),
		field("identity.plan", "identity", 50, "progress", planText, 40),
		field("identity.goal", "identity", 55, "progress", goalText, 45),
		field("identity.context-used", "identity", 60, "usage", legacyContextUsedText, 20),
		field("identity.context-limit", "identity", 70, "limit", legacyContextLimitText, 30),
		field("identity.thread", "identity", 80, "thread", (snapshot) => snapshot.threadLabel),
		usageField("usage.input", 10, "usage", "input", 40),
		usageField("usage.output", 20, "usage", "output"),
		usageField("usage.cache-read", 30, "usage", "cache-read", 30),
		usageField("usage.cache-write", 40, "usage", "cache-write", 30),
		usageField("usage.hit", 50, "usage", "hit", 20),
		usageField("usage.rate", 60, "usage", "rate"),
		usageField("usage.cost", 70, "usage", "cost"),
		usageField("usage.context", 80, "limit", "context"),
	];
}

function field(
	id: string,
	row: FooterRow,
	order: number,
	accent: StatusLineAccent,
	project: FooterFieldDefinition["project"],
	dropPriority?: number,
): FooterFieldDefinition {
	return { id, row, order, accent, project, ...(dropPriority === undefined ? {} : { dropPriority }) };
}

function usageField(
	id: string,
	order: number,
	accent: StatusLineAccent,
	usageId: UsageDisplayFieldId,
	dropPriority?: number,
): FooterFieldDefinition {
	return field(id, "usage", order, accent, (snapshot) => usageText(snapshot, usageId), dropPriority);
}

function usageText(snapshot: FooterSnapshot, id: UsageDisplayFieldId): string | undefined {
	if (snapshot.usage === undefined) return undefined;
	return formatUsageSegments(snapshot.usage).find((segment) => segment.id === id)?.text;
}

/** standard 是标准 Session 的完整工具表，属常态；只展示 shell / readonly + plan 等受限工具集。 */
function toolsText(snapshot: FooterSnapshot): string | undefined {
	return snapshot.toolsSummary === undefined || snapshot.toolsSummary === "standard" ? undefined : `Tools: ${snapshot.toolsSummary}`;
}

function queueText(snapshot: FooterSnapshot): string | undefined {
	const { steering, followUp } = snapshot.queue;
	if (!validCount(steering) || !validCount(followUp) || (steering === 0 && followUp === 0)) return undefined;
	return `queue:s${steering}/f${followUp}`;
}

function statusText(snapshot: FooterSnapshot): string | undefined {
	const timing = snapshot.runTiming;
	if (timing?.state === "recovery_required") return "Recovery required";
	if (timing !== undefined) {
		return timing.state === "working"
			? "Working"
			: "Waiting for input";
	}
	return snapshot.isStreaming ? "..." : undefined;
}

function modelText(snapshot: FooterSnapshot): string {
	return `${snapshot.providerId === undefined ? "" : `${snapshot.providerId}/`}${snapshot.modelId}${snapshot.thinkingLevel === undefined ? "" : ` · think:${snapshot.thinkingLevel}`}`;
}

function goalText(snapshot: FooterSnapshot): string | undefined {
	const goal = snapshot.goal;
	if (goal === undefined || goal.status === "inactive") return undefined;
	// 下界语义必须显式，避免把 partial 用量当成精确值（D6）。
	const bound = goal.accountingCompleteness === "partial" ? "≥" : "";
	const continuations = goal.continuations > 0 ? ` ·+${goal.continuations}` : "";
	return `Goal: ${goal.status} ${bound}${goal.tokensUsed}${continuations}`;
}

function planText(snapshot: FooterSnapshot): string | undefined {
	const progress = snapshot.planProgress;
	if (progress === undefined || !validCount(progress.completed) || !validCount(progress.total)
		|| progress.total === 0 || progress.completed > progress.total) return undefined;
	return `plan (${progress.completed}/${progress.total})`;
}

function legacyContextUsedText(snapshot: FooterSnapshot): string | undefined {
	if (snapshot.usage !== undefined) return undefined;
	const total = snapshot.contextUsage?.totalTokens;
	return knownNonNegative(total) ? `usage ${formatTokenCount(total)}` : undefined;
}

function legacyContextLimitText(snapshot: FooterSnapshot): string | undefined {
	if (snapshot.usage !== undefined) return undefined;
	const total = snapshot.contextUsage?.totalTokens;
	const window = snapshot.contextUsage?.contextWindow;
	if (!knownNonNegative(total) || !knownPositive(window)) return undefined;
	return `limit ${Math.min(100, Math.round(total / window * 100))}%`;
}

function fitProjectedFields(input: readonly ProjectedFooterField[], width: number): readonly ProjectedFooterField[] {
	const safeWidth = Math.max(0, Math.floor(width));
	let fields = input.map((entry) => ({ ...entry, segment: { ...entry.segment } }));
	const priorities = [...new Set(fields.flatMap((entry) => entry.dropPriority === undefined ? [] : [entry.dropPriority]))]
		.sort((left, right) => left - right);
	for (const priority of priorities) {
		if (projectedWidth(fields) <= safeWidth) break;
		fields = fields.filter((entry) => entry.dropPriority !== priority);
	}
	while (fields.length > 1 && separatorWidth(fields.length) >= safeWidth) fields.pop();
	let excess = Math.max(0, projectedWidth(fields) - safeWidth);
	while (excess > 0) {
		const candidate = fields
			.map((entry, index) => ({
				index,
				width: visibleWidth(entry.segment.text),
				minimum: entry.minWidth ?? minimumWidth(entry.segment.accent),
			}))
			.filter((entry) => entry.width > entry.minimum)
			.sort((left, right) => (right.width - right.minimum) - (left.width - left.minimum))[0];
		if (candidate === undefined) break;
		const target = Math.max(candidate.minimum, candidate.width - excess);
		fields = fields.map((entry, index) => index === candidate.index
			? { ...entry, segment: { ...entry.segment, text: fitToWidth(entry.segment.text, target) } }
			: entry);
		excess = Math.max(0, projectedWidth(fields) - safeWidth);
	}
	return fields;
}

function projectedWidth(fields: readonly ProjectedFooterField[]): number {
	return fields.reduce((total, entry) => total + visibleWidth(entry.segment.text), 0) + separatorWidth(fields.length);
}

function separatorWidth(count: number): number {
	return Math.max(0, count - 1) * 3;
}

function minimumWidth(accent: StatusLineAccent): number {
	if (accent === "model") return 12;
	if (accent === "path") return 8;
	if (accent === "metadata") return 16;
	return 4;
}

function validCount(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function knownNonNegative(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0;
}

function knownPositive(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
}

function formatTokenCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}
