/**
 * 显式 legacy source destructive migration。
 *
 * 该模块没有 import-only、dry-run 或 fallback 模式：调用者必须确认删除，
 * preflight 固定 source deletion manifest，目标验证通过后才逐项删除 source。
 */

import { createHash } from "node:crypto";
import { runtimePathFlavor as runtimePlatformPathFlavor } from "../workspace/runtime-platform.ts";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	isContainedRuntimePath,
	isRuntimeId,
	sessionRelativeLocator,
	type RunledgerLayout,
	type RuntimePathFlavor,
} from "../runtime/contracts/public.ts";
import { canonicalJson } from "../runtime/protocol/canonical-json.ts";
import type { SessionId } from "../runtime/protocol/ids.ts";
import { isCurrentLedgerEntry, isCurrentLedgerHeader } from "../runtime/ledger/types.ts";

const MANIFEST_VERSION = 1 as const;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type MigrationObjectKind = "session" | "settings" | "auth" | "agents";

export type MigrationItemStatus =
	| "validated"
	| "published"
	| "deduplicated_and_deleted"
	| "source_deleted"
	| "conflict"
	| "rejected"
	| "delete_failed";

export interface SourceDeletionManifestItem {
	readonly sourcePath: string;
	readonly sourceDigest: string;
	readonly objectKind: MigrationObjectKind;
	readonly objectId: string;
	readonly targetLocator: string;
	readonly targetDigest: string;
	readonly requestedDeleteAction: "delete_source";
}

export interface SourceDeletionManifest {
	readonly version: typeof MANIFEST_VERSION;
	readonly batchId: string;
	readonly createdAt: string;
	readonly items: readonly SourceDeletionManifestItem[];
}

export interface MigrationItemResult extends SourceDeletionManifestItem {
	readonly status: MigrationItemStatus;
	readonly targetPath: string;
}

export interface MigrationResult {
	readonly batchId: string;
	readonly manifestPath: string;
	readonly receiptPath: string;
	readonly items: readonly MigrationItemResult[];
}

export interface MigrationOptions {
	readonly layout: RunledgerLayout;
	readonly sourcePath: string;
	readonly confirmDelete: boolean;
	/** 测试/受控故障注入点；CLI 不暴露这些 hooks。 */
	readonly beforeDelete?: (item: SourceDeletionManifestItem) => void | Promise<void>;
	readonly afterDelete?: (item: SourceDeletionManifestItem) => void | Promise<void>;
}

export type MigrationErrorCode =
	| "confirmation_required"
	| "source_not_found"
	| "source_inside_home"
	| "rejected"
	| "conflict"
	| "source_changed"
	| "delete_failed"
	| "receipt_failed";

export class MigrationError extends Error {
	readonly code: MigrationErrorCode;
	readonly filePath?: string;

	constructor(code: MigrationErrorCode, message: string, filePath?: string) {
		super(message);
		this.name = "MigrationError";
		this.code = code;
		this.filePath = filePath;
	}
}

interface MigrationCandidate {
	readonly sourcePath: string;
	readonly sourceDigest: string;
	readonly objectKind: MigrationObjectKind;
	readonly objectId: string;
	readonly targetPath: string;
	readonly targetLocator: string;
	readonly targetContent: string;
	readonly targetDigest: string;
	readonly manifestItem: SourceDeletionManifestItem;
}

/** 执行一次不可逆 migration；confirmDelete=false 永远不会触碰 source。 */
export async function migrateLegacyData(options: MigrationOptions): Promise<MigrationResult> {
	if (!options.confirmDelete) {
		throw new MigrationError(
			"confirmation_required",
			"destructive migration requires --confirm-delete",
		);
	}

	const source = await resolveSource(options.sourcePath, options.layout);
	const sourceInfo = await fs.lstat(source);
	const sourceDeletionRoot = sourceInfo.isDirectory() ? source : path.dirname(source);
	await ensureCanonicalHome(options.layout);
	const candidates = await discoverCandidates(source, options.layout);
	if (candidates.length === 0) {
		throw new MigrationError("rejected", "source contains no supported current-format objects", source);
	}
	await assertNoTargetConflicts(candidates, options.layout);

	const batchId = `migration-${Date.now()}-${randomToken()}`;
	const batchDir = path.join(options.layout.tmp, batchId);
	const manifestPath = path.join(batchDir, "source-deletion-manifest.json");
	const receiptPath = path.join(batchDir, "migration-receipt.json");
	const deletionReceiptPath = path.join(batchDir, "source-deletions.jsonl");
	const manifest: SourceDeletionManifest = {
		version: MANIFEST_VERSION,
		batchId,
		createdAt: new Date().toISOString(),
		items: candidates.map((candidate) => candidate.manifestItem),
	};
	await fs.mkdir(batchDir, { recursive: true, mode: DIRECTORY_MODE });
	await writePrivateFile(manifestPath, `${canonicalJson(manifest)}\n`);
	await writePrivateFile(deletionReceiptPath, "");

	const published: string[] = [];
	const results: MigrationItemResult[] = [];
	try {
		for (const candidate of candidates) {
			const targetAlreadyPresent = await targetHasDigest(candidate, options.layout);
			if (targetAlreadyPresent) {
				results.push({ ...candidate.manifestItem, status: "deduplicated_and_deleted", targetPath: candidate.targetPath });
				continue;
			}
			const stagePath = path.join(batchDir, `${results.length}.stage`);
			await writePrivateFile(stagePath, candidate.targetContent);
			await ensureCanonicalParent(options.layout, candidate.targetPath);
			if (existsSync(candidate.targetPath)) {
				throw new MigrationError("conflict", `target appeared during publish: ${candidate.targetPath}`, candidate.targetPath);
			}
			await fs.rename(stagePath, candidate.targetPath);
			published.push(candidate.targetPath);
			await hardenCanonicalFile(options.layout, candidate.targetPath);
			const verified = await targetHasDigest(candidate, options.layout);
			if (!verified) {
				throw new MigrationError("conflict", `target digest verification failed: ${candidate.targetPath}`, candidate.targetPath);
			}
			results.push({ ...candidate.manifestItem, status: "published", targetPath: candidate.targetPath });
		}

		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index]!;
			await options.beforeDelete?.(candidate.manifestItem);
			let current: string;
			try {
				current = await readDigest(candidate.sourcePath);
			} catch (error) {
				throw new MigrationError("source_changed", `source unavailable before deletion: ${String(error)}`, candidate.sourcePath);
			}
			if (current !== candidate.sourceDigest) {
				throw new MigrationError("source_changed", `source changed before deletion: ${candidate.sourcePath}`, candidate.sourcePath);
			}
			try {
				await deleteSourceFile(candidate.sourcePath, sourceDeletionRoot);
			} catch (error) {
				throw new MigrationError("delete_failed", String(error), candidate.sourcePath);
			}
			try {
				await options.afterDelete?.(candidate.manifestItem);
			} catch (error) {
				throw new MigrationError("receipt_failed", String(error), candidate.sourcePath);
			}
			try {
				await fs.appendFile(
					deletionReceiptPath,
					`${canonicalJson({
						type: "source_deleted",
						batchId,
						index,
						sourcePath: candidate.sourcePath,
						sourceDigest: candidate.sourceDigest,
						targetLocator: candidate.targetLocator,
					})}\n`,
					"utf8",
				);
			} catch (error) {
				throw new MigrationError("receipt_failed", String(error), deletionReceiptPath);
			}
			const previous = results[index]!;
			results[index] = {
				...previous,
				status: previous.status === "deduplicated_and_deleted" ? previous.status : "source_deleted",
			};
		}

		const receipt = {
			version: MANIFEST_VERSION,
			batchId,
			manifestPath: path.relative(options.layout.home, manifestPath).split(path.sep).join("/"),
			items: results.map(({ targetPath: _targetPath, ...item }) => item),
			deletedPaths: results.map((item) => item.sourcePath),
			completedAt: new Date().toISOString(),
		};
		await writePrivateFile(receiptPath, `${canonicalJson(receipt)}\n`);
		await removeStagingFiles(batchDir);
		return { batchId, manifestPath, receiptPath, items: results };
	} catch (error) {
		if (!(error instanceof MigrationError) || (error.code !== "delete_failed" && error.code !== "receipt_failed")) {
			await cleanupPublishedTargets(published);
			await removeStagingFiles(batchDir);
		}
		throw error;
	}
}

async function resolveSource(sourcePath: string, layout: RunledgerLayout): Promise<string> {
	const absolute = path.resolve(sourcePath);
		let info;
	try {
		info = await fs.lstat(absolute);
	} catch {
		throw new MigrationError("source_not_found", `migration source not found: ${absolute}`, absolute);
	}
	if (info.isSymbolicLink()) {
		throw new MigrationError("rejected", `migration source symlink is not allowed: ${absolute}`, absolute);
	}
	const canonical = await fs.realpath(absolute);
	const home = existsSync(layout.home) ? await fs.realpath(layout.home) : path.resolve(layout.home);
	if (isContainedRuntimePath(home, canonical, runtimePlatformPathFlavor())) {
		throw new MigrationError("source_inside_home", "migration source must be outside canonical runledger home", canonical);
	}
	return canonical;
}

async function discoverCandidates(source: string, layout: RunledgerLayout): Promise<MigrationCandidate[]> {
	const info = await fs.lstat(source);
	const files = info.isDirectory() ? await collectSourceFiles(source) : [source];
	const candidates: MigrationCandidate[] = [];
	for (const filePath of files.sort()) {
		const kind = objectKindForPath(filePath);
		if (!kind) {
			if (!info.isDirectory()) throw new MigrationError("rejected", `unsupported migration source: ${filePath}`, filePath);
			continue;
		}
		const content = await readUtf8Source(filePath);
		candidates.push(await buildCandidate(filePath, kind, content, layout));
	}
	return candidates;
}

async function collectSourceFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) await visit(entryPath);
			else if (entry.isFile() && objectKindForPath(entryPath)) files.push(entryPath);
		}
	}
	await visit(root);
	return files;
}

function objectKindForPath(filePath: string): MigrationObjectKind | undefined {
	const name = path.basename(filePath);
	if (name.endsWith(".jsonl")) return "session";
	if (name === "settings.json") return "settings";
	if (name === "auth.json") return "auth";
	if (name === "AGENTS.md") return "agents";
	return undefined;
}

async function buildCandidate(
	sourcePath: string,
	kind: MigrationObjectKind,
	content: string,
	layout: RunledgerLayout,
): Promise<MigrationCandidate> {
	const sourceDigest = digest(content);
	let objectId: string;
	let targetPath: string;
	let targetContent = content;
	if (kind === "session") {
		const parsed = parseCurrentSession(sourcePath, content);
		objectId = parsed.sessionId;
		const createdAt = new Date(parsed.createdAt).toISOString();
		const relativeLocator = sessionRelativeLocator(parsed.sessionId as SessionId, createdAt, false);
		targetPath = path.resolve(layout.home, relativeLocator);
	} else if (kind === "settings") {
		objectId = "settings";
		targetPath = layout.settings;
		targetContent = canonicalSettings(content, sourcePath);
	} else if (kind === "auth") {
		objectId = "auth";
		targetPath = layout.auth;
		targetContent = canonicalObject(content, sourcePath);
	} else {
		objectId = "agents";
		targetPath = layout.agents;
	}
	assertContainedLexically(layout, targetPath);
	const targetLocator = path.relative(layout.home, targetPath).split(path.sep).join("/");
	const targetDigest = digest(targetContent);
	const manifestItem: SourceDeletionManifestItem = {
		sourcePath,
		sourceDigest,
		objectKind: kind,
		objectId,
		targetLocator,
		targetDigest,
		requestedDeleteAction: "delete_source",
	};
	return { sourcePath, sourceDigest, objectKind: kind, objectId, targetPath, targetLocator, targetContent, targetDigest, manifestItem };
}

function parseCurrentSession(sourcePath: string, content: string): { sessionId: string; createdAt: number } {
	const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
	if (lines.length === 0) throw new MigrationError("rejected", `empty session source: ${sourcePath}`, sourcePath);
	let header: unknown;
	try {
		header = JSON.parse(lines[0]!);
	} catch (error) {
		throw new MigrationError("rejected", `invalid session header: ${String(error)}`, sourcePath);
	}
	if (!isCurrentLedgerHeader(header) || !isRuntimeId(header.sessionId, "session")) {
		throw new MigrationError("rejected", `unsupported current session header: ${sourcePath}`, sourcePath);
	}
	for (let index = 1; index < lines.length; index += 1) {
		let entry: unknown;
		try {
			entry = JSON.parse(lines[index]!);
		} catch {
			throw new MigrationError("rejected", `invalid session entry at line ${index + 1}: ${sourcePath}`, sourcePath);
		}
		if (!isCurrentLedgerEntry(entry)) {
			throw new MigrationError("rejected", `unsupported session entry at line ${index + 1}: ${sourcePath}`, sourcePath);
		}
	}
	if (!Number.isFinite(header.createdAt) || !Number.isFinite(new Date(header.createdAt).getTime())) {
		throw new MigrationError("rejected", `invalid session createdAt: ${sourcePath}`, sourcePath);
	}
	return { sessionId: header.sessionId, createdAt: header.createdAt };
}

function canonicalSettings(content: string, sourcePath: string): string {
	const raw = parseObject(content, sourcePath);
	const settings: Record<string, unknown> = {};
	if (typeof raw.provider === "string" && raw.provider.length > 0) settings.provider = raw.provider;
	if (typeof raw.model === "string" && raw.model.length > 0) settings.model = raw.model;
	if (typeof raw.thinkingLevel === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(raw.thinkingLevel)) {
		settings.thinkingLevel = raw.thinkingLevel;
	}
	if (raw.theme === "dark" || raw.theme === "light") settings.theme = raw.theme;
	if (Array.isArray(raw.enabledModels)) {
		const enabled = raw.enabledModels.filter((value): value is string => typeof value === "string" && value.length > 0);
		if (enabled.length > 0) settings.enabledModels = enabled;
	}
	if (raw.steeringMode === "one-at-a-time" || raw.steeringMode === "all") settings.steeringMode = raw.steeringMode;
	if (raw.followUpMode === "one-at-a-time" || raw.followUpMode === "all") settings.followUpMode = raw.followUpMode;
	return `${JSON.stringify(settings, null, 2)}\n`;
}

function canonicalObject(content: string, sourcePath: string): string {
	return `${JSON.stringify(parseObject(content, sourcePath), null, 2)}\n`;
}

function parseObject(content: string, sourcePath: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new MigrationError("rejected", `invalid JSON source: ${String(error)}`, sourcePath);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new MigrationError("rejected", `source JSON must be an object: ${sourcePath}`, sourcePath);
	}
	return parsed as Record<string, unknown>;
}

async function assertNoTargetConflicts(candidates: readonly MigrationCandidate[], layout: RunledgerLayout): Promise<void> {
	const targets = new Set<string>();
	for (const candidate of candidates) {
		if (targets.has(candidate.targetPath)) {
			throw new MigrationError("conflict", `multiple source objects map to ${candidate.targetPath}`, candidate.targetPath);
		}
		targets.add(candidate.targetPath);
		if (!existsSync(candidate.targetPath)) continue;
		await assertCanonicalFile(layout, candidate.targetPath);
		if ((await readDigest(candidate.targetPath)) !== candidate.targetDigest) {
			throw new MigrationError("conflict", `target digest conflict: ${candidate.targetPath}`, candidate.targetPath);
		}
	}
}

async function targetHasDigest(candidate: MigrationCandidate, layout: RunledgerLayout): Promise<boolean> {
	if (!existsSync(candidate.targetPath)) return false;
	await assertCanonicalFile(layout, candidate.targetPath);
	return (await readDigest(candidate.targetPath)) === candidate.targetDigest;
}

async function deleteSourceFile(sourcePath: string, sourceRoot: string): Promise<void> {
	const relativeSource = path.relative(sourceRoot, sourcePath);
	if (relativeSource === "" || relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) {
		throw new Error(`source deletion escaped source root: ${sourcePath}`);
	}
	const info = await fs.lstat(sourcePath);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`source deletion target is not a regular file: ${sourcePath}`);
	await fs.unlink(sourcePath);
	if (existsSync(sourcePath)) throw new Error(`source deletion could not be verified: ${sourcePath}`);
}

async function readUtf8Source(filePath: string): Promise<string> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		throw new MigrationError("rejected", `source read failed: ${String(error)}`, filePath);
	}
}

async function ensureCanonicalHome(layout: RunledgerLayout): Promise<void> {
	await fs.mkdir(layout.home, { recursive: true, mode: DIRECTORY_MODE });
	const info = await fs.lstat(layout.home);
	if (info.isSymbolicLink()) throw new MigrationError("rejected", `canonical home is symlink: ${layout.home}`, layout.home);
}

async function ensureCanonicalParent(layout: RunledgerLayout, targetPath: string): Promise<void> {
	assertContainedLexically(layout, targetPath);
	const parent = path.dirname(targetPath);
	await assertNoSymlinkComponents(layout, parent);
	await fs.mkdir(parent, { recursive: true, mode: DIRECTORY_MODE });
	await assertCanonicalDirectory(layout, parent);
}

async function assertCanonicalFile(layout: RunledgerLayout, filePath: string): Promise<void> {
	assertContainedLexically(layout, filePath);
	const info = await fs.lstat(filePath);
	if (info.isSymbolicLink() || !info.isFile()) throw new MigrationError("rejected", `target is not a regular canonical file: ${filePath}`, filePath);
	const root = await fs.realpath(layout.home);
	const actual = await fs.realpath(filePath);
	if (!isContainedRuntimePath(root, actual, runtimePlatformPathFlavor())) {
		throw new MigrationError("rejected", `target escaped canonical home: ${filePath}`, filePath);
	}
}

async function assertCanonicalDirectory(layout: RunledgerLayout, directory: string): Promise<void> {
	assertContainedLexically(layout, directory);
	const info = await fs.lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new MigrationError("rejected", `target parent is not canonical: ${directory}`, directory);
	const root = await fs.realpath(layout.home);
	const actual = await fs.realpath(directory);
	if (!isContainedRuntimePath(root, actual, runtimePlatformPathFlavor())) {
		throw new MigrationError("rejected", `target parent escaped canonical home: ${directory}`, directory);
	}
}

async function assertNoSymlinkComponents(layout: RunledgerLayout, target: string): Promise<void> {
	assertContainedLexically(layout, target);
	let current = layout.home;
	for (const segment of path.relative(layout.home, target).split(path.sep).filter((value) => value.length > 0)) {
		current = path.join(current, segment);
		try {
			const info = await fs.lstat(current);
			if (info.isSymbolicLink()) throw new MigrationError("rejected", `target path contains symlink: ${current}`, current);
		} catch (error) {
			if (error instanceof MigrationError) throw error;
			break;
		}
	}
}

async function hardenCanonicalFile(layout: RunledgerLayout, filePath: string): Promise<void> {
	await assertCanonicalFile(layout, filePath);
	await fs.chmod(filePath, FILE_MODE);
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
	await fs.writeFile(filePath, content, { encoding: "utf8", mode: FILE_MODE });
	await fs.chmod(filePath, FILE_MODE);
}

async function readDigest(filePath: string): Promise<string> {
	const content = await fs.readFile(filePath, "utf8");
	return digest(content);
}

function digest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

async function cleanupPublishedTargets(targets: readonly string[]): Promise<void> {
	for (const target of targets) await fs.rm(target, { force: true }).catch(() => undefined);
}

async function removeStagingFiles(batchDir: string): Promise<void> {
	const entries = await fs.readdir(batchDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
	for (const entry of entries) {
		if (entry.name.endsWith(".stage")) await fs.rm(path.join(batchDir, entry.name), { force: true });
	}
}

function assertContainedLexically(layout: RunledgerLayout, target: string): void {
	if (!isContainedRuntimePath(layout.home, target, runtimePlatformPathFlavor())) {
		throw new MigrationError("rejected", `path escaped canonical home: ${target}`, target);
	}
}


function randomToken(): string {
	return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}
