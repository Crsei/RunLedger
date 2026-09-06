import type { TrajectoryClientPort, TrajectoryDetail, TrajectoryPage, TrajectoryRecord, TrajectoryRequest } from "../../runtime/contracts/trajectory.ts";
import { TRAJECTORY_BOUNDS } from "../../runtime/contracts/trajectory.ts";
import type { TuiPreferencesPort } from "../preferences/types.ts";
import type { Component } from "../primitives.ts";
import { matchesKey } from "../primitives.ts";
import { displayWidth, truncateDisplayWidth, wrapDisplayWidth } from "../mermaid/display-width.ts";
import { renderTrajectoryTimeline, trajectoryCost, trajectoryDuration, trajectorySpans } from "./layout.ts";

type Tab = "Overview" | "Input" | "Output" | "Timing" | "Usage";
const TABS: readonly Tab[] = ["Overview", "Input", "Output", "Timing", "Usage"];
export interface TrajectoryPanelOptions {
  readonly client: TrajectoryClientPort;
  readonly sessionId: string;
  readonly onChange: () => void;
  readonly onClose: () => void;
  readonly getHeight: () => number;
  readonly preferences?: TuiPreferencesPort;
}
/** 只消费 owner DTO 的有界阅读面板；不直接读取日志或执行工具。 */
export class TrajectoryPanel implements Component {
  private readonly options: TrajectoryPanelOptions;
  private records: readonly TrajectoryRecord[] = [];
  private page: TrajectoryPage | undefined;
  private selected: string | undefined;
  private follow = true;
  private duration = false;
  private turnsCollapsed = false;
  private callsCollapsed = false;
  private search = "";
  private editingSearch = false;
  private searchDraft = "";
  private focus: "list" | "detail" | "toolbar" = "list";
  private toolbarIndex = 0;
  private tab: Tab = "Overview";
  private detail: TrajectoryDetail | undefined;
  private detailOffset = 0;
  private detailLoading = false;
  private timeFrom: number | undefined;
  private timeTo: number | undefined;
  private error: string | undefined;
  private loading = false;
  private closed = false;
  private request = 0;
  private detailRequest = 0;
  private unsubscribe: (() => void) | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  private width = 80;
  private displayed: readonly TrajectoryRecord[] = [];
  private listStart = 0;

  constructor(options: TrajectoryPanelOptions) { this.options = options; }
  async open(): Promise<void> {
    const loaded = await this.options.preferences?.load();
    if (this.closed) return;
    const preference = loaded?.preferences.trajectory;
    if (preference) { this.duration = preference.duration; this.turnsCollapsed = preference.turnsCollapsed; this.callsCollapsed = preference.callsCollapsed; }
    this.unsubscribe = this.options.client.subscribe(() => this.scheduleRefresh());
    await this.load();
  }
  dispose(): void {
    this.closed = true; this.request++; this.detailRequest++;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
  }
  invalidate(): void {}
  getPresentationVersion(): number { return this.version; }
  private changed(): void { if (!this.closed) { this.version++; this.options.onChange(); } }
  private scheduleRefresh(): void {
    if (this.closed || !this.follow || this.refreshTimer !== undefined) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.loading) { this.scheduleRefresh(); return; }
      void this.load(this.follow ? {} : { recordId: this.records.at(-1)?.id });
    }, 250);
  }
  private scope(): TrajectoryRequest {
    return { search: this.search, ...(this.timeFrom === undefined ? {} : { timeFrom: this.timeFrom }), ...(this.timeTo === undefined ? {} : { timeTo: this.timeTo }) };
  }
  async load(request: TrajectoryRequest = {}, append?: "older" | "newer"): Promise<void> {
    if (this.closed || (this.loading && append !== undefined)) return;
    const ticket = ++this.request;
    this.loading = true; this.changed();
    const result = await this.options.client.page({ ...this.scope(), ...request });
    if (this.closed || ticket !== this.request) return;
    this.loading = false;
    if (!result.ok) {
      this.error = result.code;
      if (result.code === "invalid_trajectory_cursor") this.records = [];
      this.changed(); return;
    }
    this.error = undefined;
    this.page = result.value;
    if (append === undefined) this.records = result.value.records;
    else {
      const combined = append === "older" ? [...result.value.records, ...this.records] : [...this.records, ...result.value.records];
      const unique = [...new Map(combined.map((record) => [record.id, record])).values()].sort((a, b) => a.ordinal - b.ordinal);
      this.records = append === "older" ? unique.slice(0, TRAJECTORY_BOUNDS.windowSize) : unique.slice(-TRAJECTORY_BOUNDS.windowSize);
      // 游标始终对应当前边缘；更早/更晚页再次加载时按稳定记录定位。
    }
    if (this.follow) this.selected = this.records.at(-1)?.id;
    else if (!this.records.some((record) => record.id === this.selected)) this.selected = this.records[0]?.id;
    this.changed();
    if (this.focus === "detail") void this.loadDetail();
  }
  private async older(): Promise<void> {
    this.follow = false;
    if (!this.page || this.loading) return;
    const first = this.records[0];
    if (!first) return;
    const boundary = await this.options.client.page({ ...this.scope(), recordId: first.id, pageSize: 1 });
    if (this.closed || !boundary.ok || !boundary.value.hasOlder) return;
    await this.load({ cursor: boundary.value.before, direction: "older" }, "older");
  }
  private async newer(): Promise<void> {
    const last = this.records.at(-1);
    if (!last || this.loading) return;
    const boundary = await this.options.client.page({ ...this.scope(), recordId: last.id, pageSize: 1 });
    if (this.closed || !boundary.ok || !boundary.value.hasNewer) return;
    await this.load({ cursor: boundary.value.after, direction: "newer" }, "newer");
  }
  private visible(): readonly TrajectoryRecord[] {
    const ids = new Set(this.records.map((record) => record.id));
    const children = new Map<string, TrajectoryRecord[]>();
    for (const record of this.records) {
      const parent = record.parentId !== undefined && ids.has(record.parentId) ? record.parentId : "";
      const siblings = children.get(parent) ?? []; siblings.push(record); children.set(parent, siblings);
    }
    const ordered: TrajectoryRecord[] = [], visited = new Set<string>();
    const visit = (parent: string): void => {
      const siblings = children.get(parent) ?? [];
      siblings.sort((a, b) => (a.startedAtMs ?? a.endedAtMs ?? a.ordinal) - (b.startedAtMs ?? b.endedAtMs ?? b.ordinal) || a.ordinal - b.ordinal);
      for (const record of siblings) {
        if (visited.has(record.id)) continue;
        visited.add(record.id); ordered.push(record); visit(record.id);
      }
    };
    visit("");
    if (this.turnsCollapsed) return [...new Map(ordered.map((record) => [record.runId, ordered.find((candidate) => candidate.id === record.runId) ?? record])).values()];
    return ordered.filter((record) => !this.callsCollapsed || record.kind !== "attempt");
  }
  private move(delta: number): void {
    if (this.focus === "detail") { this.detailOffset = Math.max(0, this.detailOffset + delta); this.changed(); return; }
    const rows = this.visible();
    const current = rows.findIndex((record) => record.id === this.selected);
    const target = Math.max(0, Math.min(rows.length - 1, current + delta));
    this.follow = false; this.selected = rows[target]?.id;
    if (current + delta < 0) void this.older();
    if (current + delta >= rows.length) void this.newer();
    this.changed();
  }
  private selectedRecord(): TrajectoryRecord | undefined { return this.records.find((record) => record.id === this.selected); }
  private async loadDetail(cursor?: string): Promise<void> {
    const record = this.selectedRecord();
    if (!record || (this.tab !== "Input" && this.tab !== "Output")) return;
    const ticket = ++this.detailRequest;
    this.detailLoading = true; this.changed();
    const result = await this.options.client.detail(record.id, this.tab === "Input" ? "input" : "output", cursor);
    if (this.closed || ticket !== this.detailRequest) return;
    this.detailLoading = false;
    if (result.ok) { this.detail = result.value; this.detailOffset = 0; }
    else this.error = result.code;
    this.changed();
  }
  private async savePreferences(): Promise<void> {
    const port = this.options.preferences;
    if (!port) return;
    const loaded = await port.load();
    const result = await port.save({ ...loaded.preferences, trajectory: { duration: this.duration, turnsCollapsed: this.turnsCollapsed, callsCollapsed: this.callsCollapsed } });
    if (!result.ok) this.error = "Trajectory display preference could not be saved";
    this.changed();
  }
  private toggle(key: string): void {
    if (key === "d") this.duration = !this.duration;
    if (key === "t") this.turnsCollapsed = !this.turnsCollapsed;
    if (key === "c") this.callsCollapsed = !this.callsCollapsed;
    const visible = this.visible();
    if (!visible.some((record) => record.id === this.selected)) this.selected = visible[0]?.id;
    void this.savePreferences(); this.changed();
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (data.startsWith("trajectory:mouse:")) { this.mouse(data); return; }
    if (this.editingSearch) {
      if (matchesKey(data, "escape")) this.editingSearch = false;
      else if (matchesKey(data, "enter")) { this.search = this.searchDraft; this.editingSearch = false; this.follow = false; void this.load(); }
      else if (matchesKey(data, "backspace")) this.searchDraft = [...this.searchDraft].slice(0, -1).join("");
      else if (!/[\x00-\x1f\x7f]/.test(data)) this.searchDraft = (this.searchDraft + data).slice(0, TRAJECTORY_BOUNDS.searchCharacters);
      this.changed(); return;
    }
    if (matchesKey(data, "escape")) {
      if (this.focus !== "list") { this.focus = "list"; this.changed(); }
      else if (this.timeFrom !== undefined || this.search) { this.timeFrom = undefined; this.timeTo = undefined; this.search = ""; void this.load(); }
      else { this.dispose(); this.options.onClose(); }
      return;
    }
    if (matchesKey(data, "tab")) { this.focus = this.focus === "list" ? "detail" : this.focus === "detail" ? "toolbar" : "list"; this.changed(); void this.loadDetail(); return; }
    if (this.focus === "toolbar") {
      if (matchesKey(data, "left")) this.toolbarIndex = Math.max(0, this.toolbarIndex - 1);
      if (matchesKey(data, "right")) this.toolbarIndex = Math.min(4, this.toolbarIndex + 1);
      if (matchesKey(data, "enter")) this.handleToolbar();
      this.changed(); return;
    }
    if (matchesKey(data, "up") || data === "k") { this.move(-1); return; }
    if (matchesKey(data, "down") || data === "j") { this.move(1); return; }
    if (matchesKey(data, "pageUp")) { this.move(-this.pageHeight()); return; }
    if (matchesKey(data, "pageDown")) { this.move(this.pageHeight()); return; }
    if (matchesKey(data, "home")) { this.follow = false; this.selected = this.visible()[0]?.id; void this.older(); return; }
    if (matchesKey(data, "end") || data === "f") { this.follow = true; void this.load(); return; }
    if (matchesKey(data, "enter")) { this.focus = "detail"; this.changed(); void this.loadDetail(); return; }
    if (["d", "t", "c"].includes(data)) { this.toggle(data); return; }
    if (data === "/") { this.editingSearch = true; this.searchDraft = this.search; this.changed(); return; }
    if (/^[1-5]$/.test(data)) { this.tab = TABS[Number(data) - 1]!; this.detail = undefined; this.detailOffset = 0; this.focus = "detail"; this.changed(); void this.loadDetail(); return; }
    if (data === "n") { if (this.focus === "detail" && this.detail?.next) void this.loadDetail(this.detail.next); else void this.newer(); return; }
    if (data === "p") { void this.older(); return; }
    if (data === "r") { void this.load(); return; }
    if (data === "[" || data === "]") {
      const record = this.selectedRecord();
      if (data === "[") this.timeFrom = record?.startedAtMs;
      else if (this.timeFrom !== undefined && record?.endedAtMs !== undefined) { this.timeTo = Math.max(this.timeFrom, record.endedAtMs); void this.load(); }
      this.changed();
    }
  }
  handlePaste(text: string): void { if (this.editingSearch) { this.searchDraft = (this.searchDraft + text.replace(/[\x00-\x1f\x7f]/g, " ")).slice(0, TRAJECTORY_BOUNDS.searchCharacters); this.changed(); } }
  private handleToolbar(): void {
    const key = ["d", "t", "c", "/", "f"][this.toolbarIndex]!;
    if (["d", "t", "c"].includes(key)) this.toggle(key);
    else { this.focus = "list"; this.handleInput(key); }
  }
  private mouse(data: string): void {
    const [, , type, xText, yText] = data.split(":");
    const x = Number(xText), y = Number(yText);
    if (type === "up" || type === "down") { if (this.width >= 110) this.focus = x >= Math.floor(this.width * 0.54) ? "detail" : "list"; this.move(type === "up" ? -3 : 3); return; }
    if (type !== "click") return;
    if (y === 1) {
      const toolbar = [0, 17, 32, 47, 62];
      this.toolbarIndex = toolbar.filter((start) => x >= start).length - 1;
      this.handleToolbar(); return;
    }
    if (y === 3) {
      const spans = trajectorySpans(this.records, this.duration);
      const end = Math.max(1, ...spans.map((span) => span.end));
      const position = Math.max(0, x) / Math.max(1, this.width - 2) * end;
      this.selected = spans.find((span) => span.start <= position && span.end >= position)?.id ?? this.selected;
      this.follow = false; this.changed(); return;
    }
    if (y >= 5 && x === (this.width >= 110 ? Math.floor(this.width * 0.54) : this.width) - 1) {
      const position = Math.max(0, Math.min(1, (y - 5) / Math.max(1, this.pageHeight() - 1)));
      this.selected = this.displayed[Math.round(position * Math.max(0, this.displayed.length - 1))]?.id;
      this.follow = false; this.focus = "list"; this.changed(); return;
    }
    if (y >= 5) {
      if (this.width >= 110 && x >= Math.floor(this.width * 0.54)) this.focus = "detail";
      else { this.focus = "list"; this.selected = this.displayed[this.listStart + y - 5]?.id ?? this.selected; this.follow = false; }
      this.changed();
    }
  }
  private pageHeight(): number { return Math.max(3, this.options.getHeight() - 8); }
  render(width: number): string[] {
    this.width = width;
    const fit = (value: string, columns = width): string => truncateDisplayWidth(value, Math.max(1, columns), true);
    const rows = this.visible(); this.displayed = rows;
    const selectedIndex = Math.max(0, rows.findIndex((record) => record.id === this.selected));
    const height = this.pageHeight();
    this.listStart = Math.max(0, Math.min(rows.length - height, selectedIndex - Math.floor(height / 2)));
    const selected = this.selectedRecord();
    const status = this.page?.status;
    const wide = width >= 110;
    const listWidth = wide ? Math.floor(width * 0.54) : width;
    const bars = trajectorySpans(this.records, this.duration);
    const lines = [
      fit(`Trajectory · ${truncateDisplayWidth(this.options.sessionId, Math.max(12, Math.min(36, width - 50)), true)} · ${status?.mode ?? "loading"} / ${status?.health ?? "loading"}`),
      fit(`[d] Duration ${this.duration ? "on" : "off"}  [t] Turns ${this.turnsCollapsed ? "+" : "−"}  [c] Calls ${this.callsCollapsed ? "+" : "−"}  [/] Search  [f] Follow ${this.follow ? "on" : "off"}${this.focus === "toolbar" ? ` <${this.toolbarIndex + 1}>` : ""}`),
      fit(`Overview · ${this.duration ? "duration / idle compressed" : "equal width"} · M model T tool W wait · ${status?.records ?? 0} records / ${status?.recordedBytes ?? 0} bytes`),
      fit(renderTrajectoryTimeline(bars, Math.max(1, width - 2), this.selected)),
      fit(this.editingSearch ? `Search: ${this.searchDraft}▏` : this.error ?? (this.loading ? "Loading…" : `[p] Earlier history · ${this.search ? `search: ${this.search} · ` : ""}${this.timeFrom !== undefined ? "time range selected · Esc clear" : status?.diagnostics.join(", ") || (status?.gaps?.length ? `${status.gaps.length} visible coverage gaps · ${status.gaps[0]?.reason}` : "↑↓ select · Enter details")}`)),
    ];
    const details = this.detailLines(selected, wide ? width - listWidth - 3 : width);
    const detailMax = Math.max(0, details.length - height);
    this.detailOffset = Math.min(this.detailOffset, detailMax);
    for (let i = 0; i < height; i++) {
      const record = rows[this.listStart + i];
      const depth = record?.kind === "run" ? "" : record?.kind === "step" || record?.kind === "message" ? "  " : record?.kind === "attempt" ? "        " : record?.kind === "tool" ? "      " : "    ";
      const label = record === undefined ? (i === 0 ? "No matching records" : "") : `${record.id === this.selected ? "›" : " "}${depth}${this.turnsCollapsed && record.runId.startsWith("run/") ? `Turn ${record.runId.slice(-12)}${record.kind === "run" ? "" : " (root outside page)"}` : `${record.kind} ${record.name}`} · ${record.state} · ${trajectoryDuration(record.durationMs)} ${record.summary.replace(/\s+/g, " ")}`;
      const left = fit(label, listWidth - 1);
      const thumb = rows.length > height && i === Math.floor(selectedIndex / Math.max(1, rows.length - 1) * (height - 1)) ? "█" : "│";
      if (wide) lines.push(fit(left + " ".repeat(Math.max(0, listWidth - 1 - displayWidth(left))) + thumb + " " + (details[this.detailOffset + i] ?? "")));
      else lines.push(this.focus === "detail" ? fit(details[this.detailOffset + i] ?? "") : fit(left + " ".repeat(Math.max(0, listWidth - 1 - displayWidth(left))) + thumb));
    }
    lines.push(fit(`Focus: ${this.focus} · Tab switch · 1 Overview 2 Input 3 Output 4 Timing 5 Usage · n more · [ ] time range`));
    lines.push(fit(`Read only · PgUp/PgDn · Home earlier · End follow · r retry · Esc back/close · ${status?.historyCoverage ?? "partial"}`));
    return lines;
  }
  private detailLines(record: TrajectoryRecord | undefined, width: number): string[] {
    if (!record) return ["Select a record"];
    const lines = [`${TABS.map((tab) => tab === this.tab ? `[${tab}]` : tab).join(" ")}`, record.name];
    if (this.tab === "Input" || this.tab === "Output") {
      if (this.detailLoading) lines.push("Loading detail…");
      else if (!this.detail || this.detail.record.id !== record.id) lines.push("Enter or 2/3 to load saved detail");
      else lines.push(`Content: ${this.detail.availability}`, this.detail.text || "Body not recorded; digest-only or unavailable.", ...(this.detail.next ? ["[n] Next content page"] : []));
    } else if (this.tab === "Timing") lines.push(`Start: ${record.startedAtMs === undefined ? "unavailable" : new Date(record.startedAtMs).toISOString()}`, `End: ${record.endedAtMs === undefined ? "unavailable" : new Date(record.endedAtMs).toISOString()}`, `Elapsed: ${trajectoryDuration(record.durationMs)}`, `Active: ${trajectoryDuration(record.activeDurationMs)}`, `TTFT: ${trajectoryDuration(record.ttftMs)}`, `Timing source: ${record.source}`);
    else if (this.tab === "Usage") lines.push(`Input: ${record.inputTokens ?? "unavailable"}`, `Output: ${record.outputTokens ?? "unavailable"}`, `Cache read: ${record.cacheReadTokens ?? "unavailable"}`, `Cost: ${trajectoryCost(record.costUsd)}`, `Usage source: ${record.usageSource ?? "unavailable"}`, `Cost source: ${record.costSource ?? "unavailable"}`);
    else lines.push(`Kind: ${record.kind}`, `State: ${record.state}`, `Run: ${record.runId}`, `Step: ${record.stepId ?? "—"}`, `Source: ${record.source} · generation ${record.generation}`, `Duration: ${trajectoryDuration(record.durationMs)}`, `Input: ${record.input} · Output: ${record.output}`, record.summary);
    return lines.flatMap((line) => line.split("\n").flatMap((part) => wrapDisplayWidth(part, Math.max(1, width), TRAJECTORY_BOUNDS.detailBytes)));
  }
}
