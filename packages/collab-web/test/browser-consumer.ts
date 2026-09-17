import { WebSnapshotSchema, WEB_READ_ROUTES } from "../src/contracts/index.ts";
import type { WebSnapshot, WebEvent, WebUsage } from "../src/contracts/index.ts";

/** 此 consumer 另由 types: [] 的浏览器编译门禁验证。 */
export function describeSnapshot(snapshot: WebSnapshot): string {
  return `${snapshot.session.id}:${snapshot.timeline.watermark.sequence}:${snapshot.connection.state}`;
}
export function shouldReload(event: WebEvent): boolean {
  return event.kind === "resync_required";
}
export function knownCost(usage: WebUsage): number | null {
  return usage.costUsd.exact;
}
export const webContractConsumer = { schema: WebSnapshotSchema, routes: WEB_READ_ROUTES };
