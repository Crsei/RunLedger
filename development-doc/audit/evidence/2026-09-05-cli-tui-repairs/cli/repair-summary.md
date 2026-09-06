# CLI command repair summary

## Scope

- `src/cli/control-commands.ts`: security.inspect maps to session.security.inspect; plugin.reload maps to extension.reload; documented remember text accepted with legacy explicit propose syntax preserved; remember/MCP restart classified as mutations; help states current capability limits.
- `src/cli/main.ts`: only runControlCommand section changed; reuses the canonical mapped operation for mutations; structured failure sets exitCode=1 while Session cleanup still runs.
- `src/cli/auth-gateway-cli.ts`: failed regular/strict checks set exitCode=1, retaining JSON output; status and successful check remain exit 0.
- `src/cli/session-store-migrate.ts`: supports documented `--manifest <digest>` and existing `--manifest=<digest>`; missing values/confirmation remain fail closed.
- `src/cli/args.ts`: forwards skill provider `--scope user|workspace` and `--scope=...` into the domain parser, preventing silent loss of workspace scope.

No build, staging, commit, push, provider/catalog changes, or sandbox changes performed by this agent. Existing staged main.ts changes are preserved; only its control execution section was edited.

## Evidence

- `red-parser.log`: 8 intended failures for mapping, remember syntax/mutation, MCP mutation, scope forwarding and prune parsing.
- `red-execution.log`: corrected source CLI fixture runs fail for the actual security/skill routing and exit-code defects (4 tests). Initial harness errors in earlier `red.log` were corrected before production changes.
- `red.log`: includes strict check returning exit 0 despite ok:false and real spaced prune failure; earlier fixture setup errors are not used as evidence.
- `green.log`: 4 files / 66 tests passed; one original scope expectation exposed a documented production limitation.
- `green-execution.log`: final 5 source CLI tests passed (40.88s), including security/reload, real user policy disable/enable persistence, workspace failure without user policy mutation, query/prerequisite/mutation failure exit codes, and auth-gateway status/check behavior.
- Final combined focused evidence: 5 files / 71 tests passed across the unchanged four-file run plus the final five-test source CLI run. `git diff --check` passed for all touched paths.

## Current capability limit retained

Session extension-composition.ts currently rejects workspace-scoped provider policy and loads user policy only. No workspace capability was invented. The revised regression checks user enable/disable persistence and verifies workspace requests fail with exit 1 without writing user settings. Help explains this limit. plugin.inspect/mcp.inspect and uncomposed worktree/compact/context/memory/plan mutations remain honest unavailable results with nonzero exit status; help labels their current status.

## Parent-owned final gates

Root runs npm run check, build, full tests and global built CLI/TUI verification after all agent changes are integrated. This summary does not label those checks complete.
