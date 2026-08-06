/** Linux-only identity fence for resident Host inspection and forced SIGTERM. */

import { readdir, readFile, readlink, stat } from "node:fs/promises";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { runtimeWorkspacePlatform } from "../../workspace/runtime-platform.ts";

export interface LinuxProcessIdentity {
	readonly pid: number;
	readonly bootId: string;
	readonly startTicks: string;
	readonly uid: number;
	readonly executableDevice: string;
	readonly executableInode: string;
	readonly digest: RuntimeDigest;
}

export function parseLinuxProcessStatStartTicks(content: string): string {
	const commandEnd = content.lastIndexOf(")");
	if (commandEnd < 2 || content[commandEnd + 1] !== " ") throw new Error("linux_process_stat_invalid");
	const fieldsFromState = content.slice(commandEnd + 2).trim().split(/\s+/u);
	const startTicks = fieldsFromState[19];
	if (startTicks === undefined || !/^[0-9]+$/u.test(startTicks)) throw new Error("linux_process_stat_invalid");
	return startTicks;
}

export async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity> {
	assertLinuxPid(pid);
	const procRoot = `/proc/${pid}`;
	const [bootIdRaw, processStat, status, executable] = await Promise.all([
		readFile("/proc/sys/kernel/random/boot_id", "utf8"),
		readFile(`${procRoot}/stat`, "utf8"),
		readFile(`${procRoot}/status`, "utf8"),
		stat(`${procRoot}/exe`, { bigint: true }),
	]);
	const bootId = bootIdRaw.trim().toLowerCase();
	if (!/^[a-f0-9-]{36}$/u.test(bootId)) throw new Error("linux_boot_identity_invalid");
	const uidMatch = /^Uid:\s+([0-9]+)\s/mu.exec(status);
	if (uidMatch?.[1] === undefined) throw new Error("linux_process_uid_invalid");
	const uid = Number(uidMatch[1]);
	if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("linux_process_uid_invalid");
	const body = {
		kind: "linux-proc-current" as const,
		pid,
		bootId,
		startTicks: parseLinuxProcessStatStartTicks(processStat),
		uid,
		executableDevice: executable.dev.toString(),
		executableInode: executable.ino.toString(),
	};
	return { ...body, digest: runtimeDigest(body) };
}

export async function verifyLinuxProcessIdentity(pid: number, expected: RuntimeDigest): Promise<boolean> {
	try {
		const actual = await readLinuxProcessIdentity(pid);
		return actual.digest.algorithm === expected.algorithm && actual.digest.digest === expected.digest;
	} catch {
		return false;
	}
}

/** Resolves the kernel socket inode and then its sole process owner. */
export async function discoverLinuxUnixSocketOwnerPid(socketPath: string): Promise<number | undefined> {
	if (runtimeWorkspacePlatform() !== "linux") throw new Error("linux_socket_owner_unsupported");
	const table = await readFile("/proc/net/unix", "utf8");
	let inode: string | undefined;
	for (const line of table.split("\n").slice(1)) {
		const columns = line.trim().split(/\s+/u);
		if (columns.length >= 8 && columns.slice(7).join(" ") === socketPath && /^[0-9]+$/u.test(columns[6] ?? "")) {
			inode = columns[6];
			break;
		}
	}
	if (inode === undefined) return undefined;
	const owners: number[] = [];
	for (const entry of await readdir("/proc")) {
		if (!/^[1-9][0-9]*$/u.test(entry)) continue;
		const descriptors = await readdir(`/proc/${entry}/fd`).catch(() => []);
		for (const descriptor of descriptors) {
			const target = await readlink(`/proc/${entry}/fd/${descriptor}`).catch(() => "");
			if (target !== `socket:[${inode}]`) continue;
			owners.push(Number(entry));
			break;
		}
	}
	return owners.length === 1 ? owners[0] : undefined;
}

function assertLinuxPid(pid: number): void {
	if (runtimeWorkspacePlatform() !== "linux") throw new Error("linux_process_identity_unsupported");
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("linux_process_id_invalid");
}
