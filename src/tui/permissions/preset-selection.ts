/** TUI 选择系统 preset 时的纯配置投影。 */

import { builtinPermissionPreset, type BuiltinPermissionPresetId } from "../../security/config/presets.ts";
import type { FilesystemPolicy, SecurityConfigDocument } from "../../security/types.ts";

/**
 * 预设选择必须替换所有会放宽系统卡承诺的顶层 override；自定义 deny、
 * protected paths、named profiles、rules 与 Bash 策略仍作为额外收紧保留。
 */
export function applySystemPermissionPreset(
	document: SecurityConfigDocument,
	presetId: BuiltinPermissionPresetId,
): SecurityConfigDocument {
	const preset = builtinPermissionPreset(presetId);
	if (preset === undefined) throw new Error(`unknown system permission preset: ${presetId}`);
	const {
		profile: _profile,
		approvalPolicy: _approvalPolicy,
		approvalReviewer: _approvalReviewer,
		granularApproval: _granularApproval,
		sandbox: _sandbox,
		network: _network,
		filesystem,
		...remaining
	} = document;
	const hardening = filesystemHardening(filesystem);
	return {
		...remaining,
		profile: preset.id,
		approvalReviewer: preset.reviewer,
		...(hardening === undefined ? {} : { filesystem: hardening }),
	};
}

function filesystemHardening(filesystem: Partial<FilesystemPolicy> | undefined): Partial<FilesystemPolicy> | undefined {
	if (filesystem === undefined) return undefined;
	const {
		readRoots: _readRoots,
		writeRoots: _writeRoots,
		denyRead,
		denyWrite,
		protectedPaths,
	} = filesystem;
	const hardening = {
		...(denyRead === undefined ? {} : { denyRead }),
		...(denyWrite === undefined ? {} : { denyWrite }),
		...(protectedPaths === undefined ? {} : { protectedPaths }),
	};
	return Object.keys(hardening).length === 0 ? undefined : hardening;
}
