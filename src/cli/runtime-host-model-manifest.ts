/** Canonical user-home model compatibility manifest loader. */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isContainedRuntimePath, type RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { ModelCompatibilityRouter, loadModelCompatibilityManifest, type ModelCompatibilityManifestDocument } from "../runtime/model-routing/router.ts";

export const MODEL_COMPATIBILITY_MANIFEST_RELATIVE_PATH = "state/model-compatibility/manifest.json";

export type CanonicalModelCompatibilityManifestErrorCode =
	| "manifest_path_invalid"
	| "manifest_missing"
	| "manifest_read_failed"
	| "manifest_json_invalid"
	| "manifest_invalid";

export interface CanonicalModelCompatibilityManifestError {
	readonly code: CanonicalModelCompatibilityManifestErrorCode;
	readonly message: string;
}

export type CanonicalModelCompatibilityRouterResult =
	| {
			readonly ok: true;
			readonly path: string;
			readonly manifest: ModelCompatibilityManifestDocument;
			readonly router: ModelCompatibilityRouter;
		}
	| {
			readonly ok: false;
			readonly path: string;
			readonly error: CanonicalModelCompatibilityManifestError;
		};

export function modelCompatibilityManifestPath(layout: RunledgerLayout): string {
	const path = resolve(join(layout.home, MODEL_COMPATIBILITY_MANIFEST_RELATIVE_PATH));
	if (!isContainedRuntimePath(resolve(layout.home), path, "posix")) throw new Error("model compatibility manifest path escaped runledgerHome");
	return path;
}

/**
 * Loads only the current exact manifest from the injected canonical home.
 * Missing or malformed state is an unavailable router, never an implicit
 * built-in profile fallback.
 */
export async function loadCanonicalModelCompatibilityRouter(layout: RunledgerLayout): Promise<CanonicalModelCompatibilityRouterResult> {
	const path = modelCompatibilityManifestPath(layout);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return { ok: false, path, error: { code: "manifest_missing", message: "canonical model compatibility manifest is missing" } };
		return { ok: false, path, error: { code: "manifest_read_failed", message: "canonical model compatibility manifest could not be read" } };
	}
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		return { ok: false, path, error: { code: "manifest_json_invalid", message: "canonical model compatibility manifest is not valid JSON" } };
	}
	const loaded = loadModelCompatibilityManifest(value);
	if (!loaded.ok) return { ok: false, path, error: { code: "manifest_invalid", message: `${loaded.error.code}: ${loaded.error.message}` } };
	try {
		return { ok: true, path, manifest: loaded.value, router: new ModelCompatibilityRouter(loaded.value) };
	} catch {
		return { ok: false, path, error: { code: "manifest_invalid", message: "canonical model compatibility manifest could not be instantiated" } };
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
