/**
 * CLI argv 解析 —— 手写极薄版,本期支持下列旗标:
 *
 *   --continue / -c                    继续最近会话(默认 dir)
 *   --resume / -r                      list all from project sessions dir,弹 TUI 选择器
 *   --session <pathOrId>               直接打开已知 session 文件或 sessionId
 *                                       (本期只支持精确 path)
 *   --session-id <id>                  同 --session,但按精确 id 匹配
 *   --fork <pathOrId>                  从源文件 fork 到当前项目
 *                                       (本期只支持精确 path)
 *   --model <id> / -m <id>             override settings.model
 *   --thinking <level>                 minimal|low|medium|high|xhigh|max
 *   --permission-profile <name>        显式选择 restrictive security profile
 *   --approval-policy <on-request|never|untrusted|granular>
 *   --bash-analyzer <legacy|shadow|ast>
 *   --sandbox <off|read-only|workspace-write|strict|external>
 *   --network <deny|allow|allowlist|review>
 *   --network-host <host>               repeatable allowlist/review entry
 *   --worktree [label]                 在 Host 创建/复用 session worktree
 *   --worktree-ref <ref>               worktree 创建基线 ref
 *   --worktree-branch <name>           worktree 创建分支
 *   --no-worktree                      显式不使用 worktree(与 --worktree 互斥)
 *   --debug                            打开 RUNLEDGER_DEBUG=1 stderr log
 *   --version / -v                     打 version 退出
 *   --help / -h                        打 usage 退出
 *
 * 未知 flag 不抛错,收集到 unknownFlags: Map<name, string|true>;
 * 后续插件化时可由 caller 自行解析对照。
 */

import type { ModelThinkingLevel } from "../types.ts";
import type { ApprovalPolicyName, NetworkPolicyMode } from "../security/types.ts";
import type { BashSecurityAnalyzerMode } from "../security/permission/bash-ast/types.ts";
import type { SandboxProfileName } from "../runtime/contracts/public.ts";
import { controlCommandHelp } from "./control-commands.ts";

const THINKING_LEVELS: ReadonlySet<string> = new Set<ModelThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const PERMISSION_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

const SANDBOX_VALUES: ReadonlySet<string> = new Set<SandboxProfileName>([
  "off",
  "read-only",
  "workspace-write",
  "strict",
  "external",
]);

export interface ParsedArgs {
  help: boolean;
  version: boolean;
  continueRecent: boolean;
  resume: boolean;
  session?: string;
  sessionId?: string;
  fork?: string;
  provider?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  /** 显式 restrictive security profile;仅通过 Host 生效。 */
  permissionProfile?: string;
  approvalPolicy?: ApprovalPolicyName;
  bashAnalyzer?: BashSecurityAnalyzerMode;
  sandbox?: SandboxProfileName;
  /** --network 只在无 managed forceNetworkDeny 时有效。 */
  network?: NetworkPolicyMode;
  networkHosts: readonly string[];
  /** --worktree 显式请求 worktree(label 可选)。 */
  worktree?: string;
  worktreeRef?: string;
  worktreeBranch?: string;
  /** --no-worktree 与 --worktree 互斥。 */
  noWorktree: boolean;
  debug: boolean;
  /** 未知 flag 兜底,key 不带前导 --;有 =value 时 value 为 string,否则为 true */
  unknown: ReadonlyMap<string, string | true>;
  /** 位置参数(本期 CLI 不消费,作 forward compat) */
  positional: readonly string[];
}

export interface ParseResult {
  args: ParsedArgs;
  /** 解析出错(如 --thinking 不合法);CLI 顶层决定如何呈现 */
  error?: string;
}

const HELP_TEXT = `Usage: runledger [options]

  -c, --continue              继续 canonical 用户 home 中的最近会话
  -r, --resume                在 TUI 中选择当前项目的历史会话
      --session <path>        直接打开已知 session 文件
      --session-id <id>       按 sessionId 直接打开 canonical 会话
      --fork <path>           从 canonical session 文件 fork 到当前 workspace
  -m, --model <id>            覆盖 settings.model
      --provider <id>         覆盖 settings.provider
      --thinking <level>      off|minimal|low|medium|high|xhigh|max
      --permission-profile <name>
                              read-only|workspace-write|danger-full-access|named-profile-id
      --approval-policy <p>   on-request|never|untrusted|granular
      --bash-analyzer <mode>  legacy|shadow|ast
      --sandbox <profile>     off|read-only|workspace-write|strict|external
      --network <mode>        deny|allow|allowlist|review
      --network-host <host>   allowlist/review host，可重复
      --worktree [label]      在 Host 创建/复用 session worktree
      --worktree-ref <ref>    worktree 基线 ref
      --worktree-branch <n>   worktree 分支名
      --no-worktree           显式不使用 worktree(与 --worktree 互斥)
      --session-dir <dir>     已拒绝;请使用预创建的 RUNLEDGER_DIR
      --debug                 RUNLEDGER_DEBUG=1,stderr log
  -v, --version               打版本退出
  -h, --help                  本帮助

环境变量:
  <PROVIDER>_API_KEY           provider 可用的环境凭据之一;也可在 TUI /login
  RUNLEDGER_DIR                已预创建的 canonical 用户 home 覆盖
  RUNLEDGER_SESSION_DIR        已拒绝;不能改变 canonical session root

布局参见 Runtime contract 与 development-doc/storage-cli/02-user-home-migration-handoff.md。
`;

export const USAGE = `${HELP_TEXT}\n${controlCommandHelp()}\n`;

/** 解析 argv,返回 ParsedArgs 与可选 error 字符串。 */
export function parseArgs(argv: readonly string[]): ParseResult {
  let help = false;
  let version = false;
  let continueRecent = false;
  let resume = false;
  let session: string | undefined;
  let sessionId: string | undefined;
  let fork: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let thinking: ModelThinkingLevel | undefined;
  let permissionProfile: string | undefined;
  let approvalPolicy: ApprovalPolicyName | undefined;
  let bashAnalyzer: BashSecurityAnalyzerMode | undefined;
  let sandbox: SandboxProfileName | undefined;
  let network: NetworkPolicyMode | undefined;
  const networkHosts: string[] = [];
  let worktree: string | undefined;
  let worktreeRef: string | undefined;
  let worktreeBranch: string | undefined;
  let noWorktree = false;
  let debug = false;
  const unknown = new Map<string, string | true>();
  const positional: string[] = [];

  let error: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      // separator: 之后全部当 positional
      for (let j = i + 1; j < argv.length; j++) {
        positional.push(argv[j]!);
      }
      break;
    }
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }
    if (a === "-v" || a === "--version") {
      version = true;
      continue;
    }
    if (a === "-c" || a === "--continue") {
      continueRecent = true;
      continue;
    }
    if (a === "-r" || a === "--resume") {
      resume = true;
      continue;
    }
    if (a === "--debug") {
      debug = true;
      continue;
    }
    if (a === "-m" || a === "--model") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      model = v;
      continue;
    }
    if (a === "--provider") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      provider = v;
      continue;
    }
    if (a === "--session") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      session = v;
      continue;
    }
    if (a === "--session-id") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      sessionId = v;
      continue;
    }
    if (a === "--fork") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      fork = v;
      continue;
    }
    if (a === "--thinking") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      if (!THINKING_LEVELS.has(v)) {
        error = `--thinking 不合法:${v}(合法值 off/minimal/low/medium/high/xhigh/max)`;
        break;
      }
      thinking = v as ModelThinkingLevel;
      continue;
    }
    if (a === "--permission-profile") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      if (!PERMISSION_PROFILE_ID.test(v)) {
        error = `--permission-profile 不合法:${v}(应为内置或 named profile id)`;
        break;
      }
      permissionProfile = v;
      continue;
    }
    if (a === "--approval-policy") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      if (v !== "on-request" && v !== "never" && v !== "untrusted" && v !== "granular") {
        error = `--approval-policy 不合法:${v}(合法值 on-request/never/untrusted/granular)`;
        break;
      }
      approvalPolicy = v;
      continue;
    }
    if (a === "--bash-analyzer") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      if (v !== "legacy" && v !== "shadow" && v !== "ast") {
        error = `--bash-analyzer 不合法:${v}(合法值 legacy/shadow/ast)`;
        break;
      }
      bashAnalyzer = v;
      continue;
    }
    if (a === "--sandbox") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      if (!SANDBOX_VALUES.has(v)) {
        error = `--sandbox 不合法:${v}(合法值 off/read-only/workspace-write/strict/external)`;
        break;
      }
      sandbox = v as SandboxProfileName;
      continue;
    }
    if (a === "--network") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      if (v !== "deny" && v !== "allow" && v !== "allowlist" && v !== "review") {
        error = `--network 不合法:${v}(合法值 deny/allow/allowlist/review)`;
        break;
      }
      network = v;
      continue;
    }
    if (a === "--network-host") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      if (!validNetworkHost(v)) {
        error = `--network-host 不合法:${v}`;
        break;
      }
      networkHosts.push(v.toLowerCase().replace(/\.$/u, ""));
      continue;
    }
    if (a === "--worktree") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        worktree = next;
        i += 1;
      } else {
        worktree = "";
      }
      continue;
    }
    if (a === "--worktree-ref") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      worktreeRef = v;
      continue;
    }
    if (a === "--worktree-branch") {
      const v = argv[++i];
      if (v === undefined) {
        error = `${a} 缺少值`;
        break;
      }
      worktreeBranch = v;
      continue;
    }
    if (a === "--no-worktree") {
      noWorktree = true;
      continue;
    }
    if (a === "--session-dir" || a.startsWith("--session-dir=")) {
      if (a === "--session-dir" && argv[i + 1] !== undefined) i += 1;
      error = "unsupported_cli_authority: --session-dir 已拒绝;请使用预创建的 RUNLEDGER_DIR";
      break;
    }
    // --flag=value 形式
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      const key = a.slice(2, eq);
      const val = a.slice(eq + 1);
      // 未知 flag 兜底;不解析已知 flag 的 = 形式(本期保持简洁)
      unknown.set(key, val);
      continue;
    }
    // 单个 - 前缀的未知短 flag 也不抛错
    if (a.startsWith("-") && a !== "-") {
      unknown.set(a.replace(/^-+/, ""), true);
      continue;
    }
    // 否则当 positional
    positional.push(a);
  }

  if (worktree !== undefined && noWorktree) {
    error = "--worktree 与 --no-worktree 互斥";
  }
  if (error === undefined && network === "allowlist" && networkHosts.length === 0) {
    error = "--network allowlist 至少需要一个 --network-host";
  }
  if (error === undefined && (network === undefined || network === "deny") && networkHosts.length > 0) {
    error = network === "deny" ? "--network deny 不能配置 --network-host" : "--network-host 需要显式 --network review|allowlist|allow";
  }

  return {
    args: {
      help,
      version,
      continueRecent,
      resume,
      session,
      sessionId,
      fork,
      provider,
      model,
      thinking,
      permissionProfile,
      approvalPolicy,
      bashAnalyzer,
      sandbox,
      network,
      networkHosts: [...new Set(networkHosts)],
      worktree,
      worktreeRef,
      worktreeBranch,
      noWorktree,
      debug,
      unknown,
      positional,
    },
    error,
  };
}

function validNetworkHost(host: string): boolean {
  return host.length > 0 && host.length <= 512 && !host.includes("://") && !host.includes("/") && !host.includes("@") && !host.includes("\0");
}
