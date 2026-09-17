/** Plan 15 的浏览器数据合同；不授予运行时权限，不导出通用 command proxy。 */
export * from "./common.ts";
export * from "./catalog.ts";
export * from "./timeline.ts";
export * from "./trajectory.ts";
export * from "./usage.ts";
export * from "./capabilities.ts";

/** 服务端必须显式匹配方法与路径；该清单不代表路由已实现。 */
export const WEB_READ_ROUTES = Object.freeze([
  "/api/v1/projects",
  "/api/v1/projects/:id/sessions",
  "/api/v1/projects/:id/usage",
  "/api/v1/sessions/:id/snapshot",
  "/api/v1/sessions/:id/timeline",
  "/api/v1/sessions/:id/trajectory",
  "/api/v1/sessions/:id/trajectory/:recordId/detail",
  "/api/v1/sessions/:id/events",
  "/api/v1/sessions/:id/processes",
  "/api/v1/sessions/:id/children",
  "/api/v1/sessions/:id/plan",
] as const);
