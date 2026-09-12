# Storage / CLI

- [数据库结构图与完整字段清单](database-structures.html)：当前源码的主库 schema 6、轨迹缓存版本 2；5 张分图覆盖 11 张表，附索引、约束、触发器及 JSON 载体说明。浏览器打开 HTML 查看；图内省略的列完整保留在可展开清单中。
- [用户级存储迁移与交接](02-user-home-migration-handoff.md)：当前用户级 home、显式迁移与验收边界。
- [项目布局与 CLI 历史计划](01-project-layout-cli-plan.md)：历史设计输入，不作为当前存储 authority。

数据库图依据 `src/storage/session-store/schema.ts` 与 `src/runtime/trajectory/index-store.ts` 的实际 DDL，更新日期为 2026-09-12；后续 schema 变更需同步更新图稿。图稿没有读取或导出真实用户数据。
