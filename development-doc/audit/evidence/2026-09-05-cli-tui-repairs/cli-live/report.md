# Built PATH CLI repair verification

Executable: `/home/nzq/.npm-global/bin/runledger` → `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger/bin/runledger.js`.
Current HEAD: `bd8dc1c7093a68801820f8018448bd6c7db6972f`; tested current built dirty working tree.
dist/cli/main.js SHA-256: `b4a0565421fe7a8325d59d6548c69f5d7841ea1a944d248764827ecbedadd5c6`.

Result: **26/26 passed**, timeouts=0.

No provider credentials inherited or configured; controlled commands only. No external model requests.
All HOME, XDG and RUNLEDGER state is isolated under this evidence directory. No production source edits, staging, commits or process services created by this verification.

Coverage includes canonical security/reload dispatch; user-scoped skill provider mutation persisted to settings; rejected workspace scope preserves user settings; failure exit codes; documented and explicit remember syntax; local gateway token checks; and actual isolated archive migration/deletion with both manifest spellings.

Capability gaps remain explicit failure outcomes. The matrix counts expected rejection with the required nonzero exit code as a successful negative test, not an implemented feature. No real external model completion or provider-credential acceptance is claimed.

| Case | Arguments | Exit | Verdict |
| --- | --- | ---: | --- |
| help | `--help` | 0 | PASS |
| version | `--version` | 0 | PASS |
| workspace_capability | `workspace capability` | 0 | PASS |
| security_inspect | `security inspect` | 0 | PASS |
| skill_provider_list | `skill provider list` | 0 | PASS |
| skill_provider_disable_user | `skill provider disable runledger-user --scope user` | 0 | PASS |
| skill_provider_enable_user | `skill provider enable runledger-user --scope=user` | 0 | PASS |
| skill_provider_workspace_rejected | `skill provider disable runledger-user --scope=workspace` | 1 | PASS |
| skill_provider_missing_scope | `skill provider disable runledger-user --scope` | 2 | PASS |
| plugin_reload | `plugin reload` | 0 | PASS |
| plugin_list | `plugin list` | 0 | PASS |
| mcp_list | `mcp list` | 0 | PASS |
| mcp_doctor | `mcp doctor` | 0 | PASS |
| memory_query_unavailable | `memory search audit-no-match` | 1 | PASS |
| remember_documented | `remember audit-note` | 1 | PASS |
| remember_explicit | `remember propose audit-note` | 1 | PASS |
| plan_inspect | `plan inspect` | 0 | PASS |
| plan_mutation_unavailable | `plan enter` | 1 | PASS |
| gateway_status_missing | `auth-gateway status --json` | 0 | PASS |
| gateway_check_missing | `auth-gateway check --json` | 1 | PASS |
| gateway_check_configured | `auth-gateway check --json` | 0 | PASS |
| manifest_missing_confirmation | `storage prune-legacy --manifest 0000000000000000000000000000000000000000000000000000000000000000` | 2 | PASS |
| migrate_spaced | `migrate session-store --confirm-archive` | 0 | PASS |
| prune_spaced | `storage prune-legacy --manifest e56f5a433bdfae4f8c56e8e3303f0c8ae839539b98baf750eebc76fa334082fd --confirm-delete` | 0 | PASS |
| migrate_equals | `migrate session-store --confirm-archive` | 0 | PASS |
| prune_equals | `storage prune-legacy --manifest=de3b8abb81f3bfd3bd6a46adf1fec41ee3d706d63b0585734e650645687198f7 --confirm-delete` | 0 | PASS |

Raw complete stdout/stderr is retained in results.json and individual per-command files. Field-level checks, expected outcomes and exact isolated RUNLEDGER_DIR are included in results.json.
