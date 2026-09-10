# 真实 session 上下文快照

本页与 [JSON 文件](system-prompts.json) 来自一次在本项目目录运行的真实 CLI/TUI session。捕获点是 provider 编码后发到本地 HTTP 端点的请求正文，包含最终 system prompt、用户消息以及完整工具描述和参数 schema。仅项目 `AGENTS.md` 正文按用户要求刻意省略，注入位置保留。

## 本次运行

| 项目 | 实测值 |
|---|---|
| 时间（UTC） | 2026-09-10T09:23:31Z |
| 源码提交 | `0afdcd7fefbb1d4cedcba7e1e09674b47ae52001` |
| 工作目录 | `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger` |
| Session ID | `session_cwd-_data2-HDD-SATA-20T_Digital_avatar_haowe-mtvbl31h` |
| 入口 | `/home/nzq/.npm-global/bin/runledger` → 仓库 `bin/runledger.js` → 新构建的 `dist` |
| 模式 | `default / standard@1` |
| 路由 | `litellm / claude-opus-4-8`，本地 HTTP fixture |
| 权限 | `workspace-write`；`on-request` |
| 配置 | 隔离 HOME/RUNLEDGER_DIR；thinking off；autoTitle 与 idleRecap 关闭；recording events |
| 结果 | 1 次请求；持久化 agent_end 为 stop；回复 AFTER_DONE；退出码 0；遗留进程 0 |

本地端点返回确定性响应，没有调用外部模型。它捕获的是实际发送的请求，可以验证上下文组装，但不代表用户日常配置或其他 provider 的请求完全相同。原始请求与 SQLite session 证据保存在 `/tmp/runledger-prompt-capture-E6X6nk`（本机临时路径）；跟踪 ID 为 `trace_fc475c98-35e9-4c12-a0c8-d8f797fbd24f`。

首次逐字符输入触发既有 `editor_activity: request capacity exceeded`，未形成成功轮次；改用 bracketed paste 后本次完成。两次运行均已清理所属进程。

## 最终注入的 system prompt

本次 adapter 将 runtime 的 `systemPrompt` 编码为 `messages[0].role = "developer"`。以下内容直接取自该字段，保留顺序与换行：

```text
You are RunLedger's interactive coding agent inside a TUI. Work in /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger. Use governed Read/Write/Edit/Bash/process tools and keep replies concise.

---

[AGENTS.md 正文刻意省略；来源：工作目录/AGENTS.md]

Current Session permissions (runtime authority):
profile: workspace-write; revision: 1
approval_policy: on-request; filesystem: workspace-write; network: review
The runtime governs every operation. Only the user can change this Session's permission preset. System-destructive operations still require explicit one-time confirmation.
```

项目 AGENTS 原文实际已注入，导出时精确替换一次，原文 13537 UTF-8 字节，SHA-256 为 `7db18de8744d155c93a7efcd0e0e174e670c478c89e2cc469278d633c1ff105d`。隔离用户目录没有用户级 AGENTS，因此没有该段。没有读取或复制真实用户配置与凭据。

## 与上一版的差异

上一版从静态源码列举字符串，误把 `src/cli/runtime-host-session.ts` 的 legacy Host 权限片段写成当前生产接线。本次请求实际是 `Current Session permissions (runtime authority):`，没有 `RunLedger permission context:`。

当前路径是 [Session Owner domain](../src/runtime/session-runtime/domain.ts) 的 `buildSystemPrompt()` 加 `session-effective-permissions`，再由 [model-request-adapter](../src/runtime/context/model-request-adapter.ts) 按选中的上下文片段组装。工具定义独立放在 `tools` 字段，不能只导出一条 system prompt 字符串就代表完整模型上下文。

本次隔离配置没有已配置的 Skill catalog 或 MCP 服务内容，也没有历史消息。工具表中仍有 Skill 和 MCP 入口工具；入口存在不表示已有扩展内容注入。其他 profile、用户配置和后续轮次需要各自捕获。

## 用户消息

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Capture this session context. Reply with OK without calling any tools."
    }
  ]
}
```

## 请求参数

以下为除 `messages` 和 `tools` 外的全部请求字段：

```json
{
  "model": "claude-opus-4-8",
  "stream": true,
  "stream_options": {
    "include_usage": true
  },
  "store": false,
  "max_completion_tokens": 32768
}
```

## 完整工具上下文（21 项）

以下各项直接取自实际请求的 `tools` 数组，顺序、描述、参数 schema 均保留。

### read

```json
{
  "type": "function",
  "function": {
    "name": "read",
    "description": "读取文件内容,按行/字节截断。默认上限 2000 行 / 300000 字节。",
    "parameters": {
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string",
          "description": "要读的文件路径(相对或绝对)"
        },
        "offset": {
          "type": "number",
          "description": "起始行号 (1-indexed)"
        },
        "limit": {
          "type": "number",
          "description": "最多读取行数"
        },
        "lineNumbers": {
          "type": "boolean",
          "description": "是否在每行行首加 cat -n 风格行号;缺省 true。"
        },
        "noCache": {
          "type": "boolean",
          "description": "跳过 mtime 去重缓存,强制重新读盘;缺省 false。"
        }
      }
    },
    "strict": false
  }
}
```

### write

```json
{
  "type": "function",
  "function": {
    "name": "write",
    "description": "写入文件;目录不存在会递归创建。会覆盖已有文件。",
    "parameters": {
      "type": "object",
      "required": [
        "path",
        "content"
      ],
      "properties": {
        "path": {
          "type": "string",
          "description": "要写入的文件路径(相对或绝对)"
        },
        "content": {
          "type": "string",
          "description": "文件内容"
        }
      }
    },
    "strict": false
  }
}
```

### edit

```json
{
  "type": "function",
  "function": {
    "name": "edit",
    "description": "在已有文件内做多块 oldText → newText 替换;oldText 必须严格匹配文件原内容子串。",
    "parameters": {
      "type": "object",
      "required": [
        "path",
        "edits"
      ],
      "properties": {
        "path": {
          "type": "string",
          "description": "要修改的文件路径(相对或绝对)"
        },
        "edits": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "oldText",
              "newText"
            ],
            "properties": {
              "oldText": {
                "type": "string",
                "description": "原文(必须是文件内容子串,精确匹配)"
              },
              "newText": {
                "type": "string",
                "description": "替换为新文本"
              },
              "replaceAll": {
                "type": "boolean",
                "description": "是否替换所有出现;缺省 false(只替换第一个)。当 oldText 在文件内 >1 次出现且未设 true,会抛错以便 LLM 改用更精确上下文。"
              },
              "findActualString": {
                "type": "boolean",
                "description": "放宽匹配:headers/footers 周围空白允许误差。对齐 pi core/tools/edit.ts 的 find_actual_string 模式。缺省 false。"
              }
            }
          },
          "description": "一系列 oldText → newText 替换块"
        }
      }
    },
    "strict": false
  }
}
```

### MultiEdit

```json
{
  "type": "function",
  "function": {
    "name": "MultiEdit",
    "description": "单次调用对同一文件做 N 处编辑;任一处 fail 则整体 abort。",
    "parameters": {
      "type": "object",
      "required": [
        "filePath",
        "edits"
      ],
      "properties": {
        "filePath": {
          "type": "string",
          "description": "目标文件路径(相对 cwd 或绝对)"
        },
        "edits": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "oldString",
              "newString"
            ],
            "properties": {
              "oldString": {
                "type": "string",
                "description": "原文片段(必须可重定位)"
              },
              "newString": {
                "type": "string",
                "description": "新文片段"
              },
              "replaceAll": {
                "type": "boolean",
                "description": "为 true 则替换所有出现;缺省 false 仅首处"
              }
            }
          },
          "description": "一次性应用的所有 edits(按数组顺序)"
        }
      }
    },
    "strict": false
  }
}
```

### bash

```json
{
  "type": "function",
  "function": {
    "name": "bash",
    "description": "在受治理 shell 中执行一条命令,流式回传 stdout/stderr。非零退出码视为错误。",
    "parameters": {
      "type": "object",
      "required": [
        "command"
      ],
      "properties": {
        "command": {
          "type": "string",
          "description": "要执行的 shell 命令"
        },
        "timeout": {
          "type": "number",
          "description": "超时(ms),默认 60000;最大 2147483647"
        },
        "stdin": {
          "type": "string",
          "description": "把这段文本通过 stdin 喂给子进程;缺省不喂。"
        },
        "run_in_background": {
          "type": "boolean",
          "description": "true → 请求受治理的后台执行。未提供 Host process facade 时 fail closed。缺省 false。"
        },
        "output_format": {
          "type": "string",
          "description": "\"text\"(缺省:native stdout/stderr/exit 三段) | \"stream-json\"(stdout 每行 NDJSON: {\"type\":\"stdout\",\"line\":\"...\"},stderr 类似,\"type\":\"exit\",\"code\":N})。"
        }
      }
    },
    "strict": false
  }
}
```

### grep

```json
{
  "type": "function",
  "function": {
    "name": "grep",
    "description": "在文件或目录内搜索文本。默认上限 100 个匹配。优先 ripgrep,失败回退 grep。",
    "parameters": {
      "type": "object",
      "required": [
        "pattern"
      ],
      "properties": {
        "pattern": {
          "type": "string",
          "description": "搜索模式(默认正则)"
        },
        "path": {
          "type": "string",
          "description": "搜索路径;默认 cwd"
        },
        "glob": {
          "type": "string",
          "description": "文件名 glob 过滤"
        },
        "ignoreCase": {
          "type": "boolean",
          "description": "大小写不敏感"
        },
        "literal": {
          "type": "boolean",
          "description": "原文匹配(fixed strings)"
        },
        "context": {
          "type": "number",
          "description": "上下文行数(对称 before+after)"
        },
        "afterContext": {
          "type": "number",
          "description": "匹配行后的上下文行数;不设时由 context 填充"
        },
        "beforeContext": {
          "type": "number",
          "description": "匹配行前的上下文行数;不设时由 context 填充"
        },
        "multiline": {
          "type": "boolean",
          "description": "允许多行 pattern(?<NL>...) 匹配;rg 加 -U, grep 加 -P -z。缺省 false。"
        },
        "outputFormat": {
          "type": "string",
          "description": "\"text\"(缺省) | \"files-with-matches\"(只输出命中文件名,等价 rg -l / grep -l)。用于快速 inventory 哪些文件含某 pattern。"
        },
        "limit": {
          "type": "number",
          "description": "结果行数上限,默认 100"
        }
      }
    },
    "strict": false
  }
}
```

### find

```json
{
  "type": "function",
  "function": {
    "name": "find",
    "description": "按 glob pattern 查找文件。默认上限 1000 个。优先 fd, 失败回退 find。",
    "parameters": {
      "type": "object",
      "required": [
        "pattern"
      ],
      "properties": {
        "pattern": {
          "type": "string",
          "description": "glob pattern, e.g. *.ts or src/**/test.ts"
        },
        "path": {
          "type": "string",
          "description": "搜索根目录; 默认 cwd"
        },
        "limit": {
          "type": "number",
          "description": "最大结果数, 默认 1000"
        }
      }
    },
    "strict": false
  }
}
```

### glob

```json
{
  "type": "function",
  "function": {
    "name": "glob",
    "description": "按 glob pattern 查找文件路径。第一方手写 ** 递归;默认跳过 .git / node_modules;按 mtime desc 排序。",
    "parameters": {
      "type": "object",
      "required": [
        "pattern"
      ],
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Glob pattern,支持 * / ** / ?;不支持字符集 [abc]。例:src/**/*.ts"
        },
        "path": {
          "type": "string",
          "description": "搜索根目录;缺省 cwd"
        },
        "limit": {
          "type": "number",
          "description": "结果条目上限,默认 100"
        }
      }
    },
    "strict": false
  }
}
```

### ls

```json
{
  "type": "function",
  "function": {
    "name": "ls",
    "description": "列目录内容,按字母序排序;目录条目尾部加 '/';默认条目上限 500。",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "目录;默认 cwd"
        },
        "limit": {
          "type": "number",
          "description": "条目上限,默认 500"
        }
      }
    },
    "strict": false
  }
}
```

### WebFetch

```json
{
  "type": "function",
  "function": {
    "name": "WebFetch",
    "description": "抓 URL 并按 prompt 给出回复。HTTP 自动升级 HTTPS,跨 host redirect 报错(请重发)。",
    "parameters": {
      "type": "object",
      "required": [
        "url",
        "prompt"
      ],
      "properties": {
        "url": {
          "type": "string",
          "description": "目标 URL;HTTP 自动升级 HTTPS"
        },
        "prompt": {
          "type": "string",
          "description": "对该 URL 正文要回答的问题"
        },
        "maxBytes": {
          "type": "number",
          "description": "正文字节截断上限,默认 2_000_000"
        }
      }
    },
    "strict": false
  }
}
```

### request_permissions

```json
{
  "type": "function",
  "function": {
    "name": "request_permissions",
    "description": "请求 Host 审批一组精确的临时权限；工具自身不会授予权限。",
    "parameters": {
      "type": "object",
      "required": [
        "scope",
        "permissions"
      ],
      "properties": {
        "scope": {
          "anyOf": [
            {
              "type": "string",
              "const": "one_off"
            },
            {
              "type": "string",
              "const": "turn"
            },
            {
              "type": "string",
              "const": "session"
            }
          ]
        },
        "permissions": {
          "type": "object",
          "properties": {
            "filesystem": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "path",
                  "access"
                ],
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 4096
                  },
                  "access": {
                    "anyOf": [
                      {
                        "type": "string",
                        "const": "read"
                      },
                      {
                        "type": "string",
                        "const": "write"
                      },
                      {
                        "type": "string",
                        "const": "deny"
                      }
                    ]
                  }
                },
                "additionalProperties": false
              },
              "minItems": 1,
              "maxItems": 128
            },
            "network": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "host",
                  "protocol",
                  "access"
                ],
                "properties": {
                  "host": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  },
                  "protocol": {
                    "anyOf": [
                      {
                        "type": "string",
                        "const": "http"
                      },
                      {
                        "type": "string",
                        "const": "https"
                      },
                      {
                        "type": "string",
                        "const": "socks5-tcp"
                      },
                      {
                        "type": "string",
                        "const": "socks5-udp"
                      }
                    ]
                  },
                  "port": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 65535
                  },
                  "access": {
                    "anyOf": [
                      {
                        "type": "string",
                        "const": "allow"
                      },
                      {
                        "type": "string",
                        "const": "deny"
                      }
                    ]
                  }
                },
                "additionalProperties": false
              },
              "minItems": 1,
              "maxItems": 128
            }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },
    "strict": false
  }
}
```

### process_output

```json
{
  "type": "function",
  "function": {
    "name": "process_output",
    "description": "立即读取受治理进程的 bounded output page；不会等待进程完成。",
    "parameters": {
      "type": "object",
      "required": [
        "handle",
        "cursor"
      ],
      "properties": {
        "handle": {
          "type": "object",
          "required": [
            "authorityId",
            "tenantId",
            "workspaceId",
            "sessionId",
            "hostGeneration",
            "sessionGeneration",
            "executionId",
            "attemptId",
            "revision",
            "requestDigest"
          ],
          "properties": {
            "authorityId": {
              "type": "string",
              "pattern": "^authority_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "tenantId": {
              "type": "string",
              "pattern": "^tenant_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 134
            },
            "workspaceId": {
              "type": "string",
              "pattern": "^workspace_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 137
            },
            "sessionId": {
              "type": "string",
              "pattern": "^session_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "hostGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "sessionGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "executionId": {
              "type": "string",
              "pattern": "^execution_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "attemptId": {
              "type": "string",
              "pattern": "^attempt_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "revision": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "requestDigest": {
              "type": "object",
              "required": [
                "algorithm",
                "digest"
              ],
              "properties": {
                "algorithm": {
                  "type": "string",
                  "const": "sha256"
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$",
                  "minLength": 64,
                  "maxLength": 64
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        },
        "cursor": {
          "type": "object",
          "required": [
            "sequence",
            "byteOffset"
          ],
          "properties": {
            "sequence": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "byteOffset": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "additionalProperties": false
        },
        "max_bytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 65536
        }
      },
      "additionalProperties": false
    },
    "strict": false
  }
}
```

### process_wait

```json
{
  "type": "function",
  "function": {
    "name": "process_wait",
    "description": "在固定正超时内等待受治理进程；超时只结束 waiter，不改变进程状态。",
    "parameters": {
      "type": "object",
      "required": [
        "handle",
        "timeout_ms"
      ],
      "properties": {
        "handle": {
          "type": "object",
          "required": [
            "authorityId",
            "tenantId",
            "workspaceId",
            "sessionId",
            "hostGeneration",
            "sessionGeneration",
            "executionId",
            "attemptId",
            "revision",
            "requestDigest"
          ],
          "properties": {
            "authorityId": {
              "type": "string",
              "pattern": "^authority_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "tenantId": {
              "type": "string",
              "pattern": "^tenant_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 134
            },
            "workspaceId": {
              "type": "string",
              "pattern": "^workspace_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 137
            },
            "sessionId": {
              "type": "string",
              "pattern": "^session_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "hostGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "sessionGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "executionId": {
              "type": "string",
              "pattern": "^execution_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "attemptId": {
              "type": "string",
              "pattern": "^attempt_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "revision": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "requestDigest": {
              "type": "object",
              "required": [
                "algorithm",
                "digest"
              ],
              "properties": {
                "algorithm": {
                  "type": "string",
                  "const": "sha256"
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$",
                  "minLength": 64,
                  "maxLength": 64
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        },
        "timeout_ms": {
          "type": "integer",
          "minimum": 1,
          "maximum": 30000
        }
      },
      "additionalProperties": false
    },
    "strict": false
  }
}
```

### write_stdin

```json
{
  "type": "function",
  "function": {
    "name": "write_stdin",
    "description": "向受治理进程写入 bounded stdin；只有当前 driver 可以执行。",
    "parameters": {
      "type": "object",
      "required": [
        "handle",
        "input"
      ],
      "properties": {
        "handle": {
          "type": "object",
          "required": [
            "authorityId",
            "tenantId",
            "workspaceId",
            "sessionId",
            "hostGeneration",
            "sessionGeneration",
            "executionId",
            "attemptId",
            "revision",
            "requestDigest"
          ],
          "properties": {
            "authorityId": {
              "type": "string",
              "pattern": "^authority_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "tenantId": {
              "type": "string",
              "pattern": "^tenant_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 134
            },
            "workspaceId": {
              "type": "string",
              "pattern": "^workspace_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 137
            },
            "sessionId": {
              "type": "string",
              "pattern": "^session_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "hostGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "sessionGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "executionId": {
              "type": "string",
              "pattern": "^execution_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "attemptId": {
              "type": "string",
              "pattern": "^attempt_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "revision": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "requestDigest": {
              "type": "object",
              "required": [
                "algorithm",
                "digest"
              ],
              "properties": {
                "algorithm": {
                  "type": "string",
                  "const": "sha256"
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$",
                  "minLength": 64,
                  "maxLength": 64
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        },
        "input": {
          "type": "string",
          "maxLength": 65536
        }
      },
      "additionalProperties": false
    },
    "strict": false
  }
}
```

### process_stop

```json
{
  "type": "function",
  "function": {
    "name": "process_stop",
    "description": "请求 Host 停止受治理进程；只返回安全 receipt，不暴露 PID 或 process group。",
    "parameters": {
      "type": "object",
      "required": [
        "handle"
      ],
      "properties": {
        "handle": {
          "type": "object",
          "required": [
            "authorityId",
            "tenantId",
            "workspaceId",
            "sessionId",
            "hostGeneration",
            "sessionGeneration",
            "executionId",
            "attemptId",
            "revision",
            "requestDigest"
          ],
          "properties": {
            "authorityId": {
              "type": "string",
              "pattern": "^authority_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "tenantId": {
              "type": "string",
              "pattern": "^tenant_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 134
            },
            "workspaceId": {
              "type": "string",
              "pattern": "^workspace_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 137
            },
            "sessionId": {
              "type": "string",
              "pattern": "^session_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "hostGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "sessionGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "executionId": {
              "type": "string",
              "pattern": "^execution_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "attemptId": {
              "type": "string",
              "pattern": "^attempt_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "revision": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "requestDigest": {
              "type": "object",
              "required": [
                "algorithm",
                "digest"
              ],
              "properties": {
                "algorithm": {
                  "type": "string",
                  "const": "sha256"
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$",
                  "minLength": 64,
                  "maxLength": 64
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        },
        "signal": {
          "type": "string",
          "minLength": 1,
          "maxLength": 16
        }
      },
      "additionalProperties": false
    },
    "strict": false
  }
}
```

### process_resize

```json
{
  "type": "function",
  "function": {
    "name": "process_resize",
    "description": "调整受治理 PTY 的 bounded terminal size；只有当前 driver 可以执行。",
    "parameters": {
      "type": "object",
      "required": [
        "handle",
        "columns",
        "rows"
      ],
      "properties": {
        "handle": {
          "type": "object",
          "required": [
            "authorityId",
            "tenantId",
            "workspaceId",
            "sessionId",
            "hostGeneration",
            "sessionGeneration",
            "executionId",
            "attemptId",
            "revision",
            "requestDigest"
          ],
          "properties": {
            "authorityId": {
              "type": "string",
              "pattern": "^authority_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "tenantId": {
              "type": "string",
              "pattern": "^tenant_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 134
            },
            "workspaceId": {
              "type": "string",
              "pattern": "^workspace_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 137
            },
            "sessionId": {
              "type": "string",
              "pattern": "^session_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "hostGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "sessionGeneration": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "executionId": {
              "type": "string",
              "pattern": "^execution_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 138
            },
            "attemptId": {
              "type": "string",
              "pattern": "^attempt_[A-Za-z0-9._~-]{1,128}$",
              "maxLength": 136
            },
            "revision": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "requestDigest": {
              "type": "object",
              "required": [
                "algorithm",
                "digest"
              ],
              "properties": {
                "algorithm": {
                  "type": "string",
                  "const": "sha256"
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$",
                  "minLength": 64,
                  "maxLength": 64
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        },
        "columns": {
          "type": "integer",
          "minimum": 1,
          "maximum": 512
        },
        "rows": {
          "type": "integer",
          "minimum": 1,
          "maximum": 256
        }
      },
      "additionalProperties": false
    },
    "strict": false
  }
}
```

### lsp

```json
{
  "type": "function",
  "function": {
    "name": "lsp",
    "description": "查询语言服务器:诊断、定义、引用、悬停、符号、状态与能力;写动作(rename/code_actions)经治理接缝执行。",
    "parameters": {
      "type": "object",
      "required": [
        "action"
      ],
      "properties": {
        "action": {
          "enum": [
            "diagnostics",
            "definition",
            "type_definition",
            "implementation",
            "references",
            "hover",
            "symbols",
            "status",
            "capabilities",
            "rename",
            "rename_file",
            "code_actions",
            "reload",
            "request"
          ]
        },
        "file": {
          "type": "string",
          "description": "文件路径;symbols/request 的 workspace 形态可用 \"*\";diagnostics 仅支持单文件"
        },
        "line": {
          "type": "number",
          "minimum": 1,
          "description": "1 起始行号"
        },
        "symbol": {
          "type": "string",
          "description": "行内符号子串;支持 name#N 出现次选择器"
        },
        "query": {
          "type": "string"
        },
        "new_name": {
          "type": "string",
          "description": "rename/rename_file 的新名字或目标路径"
        },
        "apply": {
          "type": "boolean",
          "description": "rename/rename_file 默认应用;code_actions 默认仅列出"
        },
        "timeout": {
          "type": "number",
          "minimum": 1,
          "maximum": 300,
          "description": "秒,默认 20"
        },
        "payload": {
          "type": "string",
          "description": "action=request 的 JSON 参数"
        }
      }
    },
    "strict": false
  }
}
```

### Skill

```json
{
  "type": "function",
  "function": {
    "name": "Skill",
    "description": "读取一个已发现 skill 的 SKILL.md 正文。未调用时只有 catalog 元数据进入上下文。",
    "parameters": {
      "type": "object",
      "required": [
        "name"
      ],
      "properties": {
        "name": {
          "type": "string",
          "description": "skill qualifiedId;对应 catalog 中 frontmatter.name 或 identity.qualifiedId"
        },
        "args": {
          "type": "object",
          "patternProperties": {
            "^.*$": {}
          }
        }
      }
    },
    "strict": false
  }
}
```

### mcp_catalog

```json
{
  "type": "function",
  "function": {
    "name": "mcp_catalog",
    "description": "List this Session's bounded MCP server and tool catalog.",
    "parameters": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    "strict": false
  }
}
```

### mcp_search

```json
{
  "type": "function",
  "function": {
    "name": "mcp_search",
    "description": "Search this Session's MCP tool catalog without invoking a server.",
    "parameters": {
      "type": "object",
      "required": [
        "query"
      ],
      "properties": {
        "query": {
          "type": "string",
          "minLength": 0,
          "maxLength": 512
        },
        "maxResults": {
          "type": "integer",
          "minimum": 1,
          "maximum": 32
        }
      },
      "additionalProperties": false
    },
    "strict": false
  }
}
```

### mcp_call

```json
{
  "type": "function",
  "function": {
    "name": "mcp_call",
    "description": "Invoke one MCP tool through this Session's recovery barrier.",
    "parameters": {
      "type": "object",
      "required": [
        "serverId",
        "toolName",
        "input"
      ],
      "properties": {
        "serverId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "toolName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "input": {}
      },
      "additionalProperties": false
    },
    "strict": false
  }
}
```

## 其他源码提示词

JSON 的 `sourceReferenceOnly` 保留 minimal、plan、自动标题与 legacy transcript 总结的源码参考，并明确标为本次 session 未观测。它们不是本轮请求的组成部分。

## 验证

构建通过；已对成功 session 的持久化终态、请求数、AGENTS 原文注入、退出码和所属进程清理做断言。导出的 JSON 与原始请求逐字段对比，仅 AGENTS 正文被替换；Markdown 中消息和全部工具 JSON 与导出值一致。
