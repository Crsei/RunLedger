# Independent review and steering follow-up

Reviewed current working tree on 2026-09-05. No staging, commit, build, provider configuration, or sandbox changes.

## Review results

- Terminal-only assistant message repair in `src/runtime/agent-loop/loop-runner.ts`: no concrete new regression found. A provider terminal response without a start now produces one assistant start followed by the existing canonical end; normal started streams remain unchanged.
- The Session controller `agent.event` filter matches production: event-persistence stores `eventType: agent.event`; runtime-server streams durable event types from the store. The internal notification spelling `agent_event` is not the wire subscription spelling. No production Agent events are incorrectly filtered by this gate.
- Found a residual idle-state bug: an idle `Agent.clearAllQueues()` emits an actual `queue_update`, and the previous receive assignment marked the controller busy. The TUI Alt+Up action invokes that path. A temporary source-code experiment reproduced false -> true, a pending waitForIdle, and a subsequent request misrouted to steer. Evidence: `review/idle-queue.mjs`, `review/idle-queue.log`, `review/idle-queue-invocation.json`. This uses a real Agent and SessionInteractiveController with a transport fixture, not an external provider. Parent owns the receive fix.
- Follow-up review of boundary-only state updates identified active attach initialization: a snapshot taken after agent_start subscribes from a later cursor, so the new client will not receive that start. Constructor must initialize from the already available snapshot.agentRuns status=active; recovery_required must not become busy. Reported to parent for its controller-state ownership.
- Capability gates were checked against current production manifests and the operations each TUI workflow actually invokes. No implemented production operation was found incorrectly disabled. Plugin/skill/hook entry points query extension.inspect; MCP queries mcp.list; provider policy queries skill.provider.list; plan.inspect is implemented read-only. Current extension mutations are implemented and remain reachable. Memory/compaction/worktree and plan mutation remain outside current Session capabilities. CLI plugin.inspect and mcp.inspect have no production manifest operations and expose the existing list/doctor alternative.

## Authorized steering repair

Changed only `SessionInteractiveController.prompt` within the shared controller file, plus new `tests/cli/session-steering.test.ts`. The command body now follows the selected wire kind: prompt uses promptText; steer/follow_up use text. This preserves input across active default submits and idle calls with explicit queue behavior.

The test exercises the real production conversation command routes and observes the text received by the domain controller. Six combinations cover active/idle and undefined/steer/followUp behavior, including multiline Chinese input.

- RED: canonical focused runner, 1 file / 6 tests, 3 failed and 3 passed, runner exit 1. The three failures each delivered empty text instead of the user question.
- GREEN: same runner plus adjacent session-interactive-controller suite, 2 files / 25 tests passed, exit 0.
- Evidence: steering-red.log, steering-red-evidence.json, steering-red-invocation.json; steering-green.log, steering-green-evidence.json, steering-green-invocation.json.
- Environment: provider secret variables removed; HOME, RUNLEDGER_DIR, TMPDIR and XDG directories isolated by the existing test wrapper; temporary HOME/TMPDIR removed at end.
- git diff --check for the touched controller and new test passed.
- Parent owns final combined check/build and built CLI/TUI verification; no independent build run here.
