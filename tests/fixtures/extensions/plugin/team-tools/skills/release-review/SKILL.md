---
name: release-review
description: Review a release candidate without executing bundled scripts.
user-invocable: true
disable-model-invocation: false
allowed-tools:
  - Read
  - grep
metadata:
  owner: platform
---

# Release review

Inspect the release diff and produce an auditable readiness report.
