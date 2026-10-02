# Playground engineering guidance

These instructions apply throughout this repository.

## Shared work

- Inspect the branch and worktree before editing. Use a narrow branch or worktree.
- Preserve unrelated changes. Do not force push, delete branches, or clean files belonging to another task.
- Keep PRs scoped. Use titles shaped like `docs/playground: Describe onboarding` or `fix/playground: Preserve evidence`.
- Do not use em dash characters in new text or commit and PR messages.

## Demo contracts

- Use the published Clutta runtime and supported APIs. Do not implement a second detector in lab scripts.
- Learn from actual workload activity. Do not manufacture Clutta findings, approve candidates automatically, or replace failed live checks with an undisclosed replay.
- Preserve the human review and activation boundary and confirm that Scan has loaded the active catalog before injecting a fault.
- Keep observations, missing completion, and root-cause interpretation separate. Weak or unknown evidence stays explicit.
- Preserve source, raw text, line, time, component, and fingerprint information wherever the runtime provides it.
- Verify workspace ownership and project routing. A workspace API key is not a project-specific credential.
- Scope collection to the lab logs. Never discover host, production, or unrelated Codespace logs by default.
- Use fake payments and lab-owned data only. No customer data, real payment provider calls, or production credentials.

## Documentation and validation

- State whether a command, feature, environment, or result is planned, implemented, or verified.
- Pin runtime artifacts and dependencies. Record the tested commit and checksum; do not rely on warm caches or uncommitted modules.
- Test healthy traffic, silent scheduler failure, observation loss, repair, replay, tenant boundaries, and credential handling.
- Save generated logs, test data, and receipts under the user's `sanitized-cases` directory, outside the checkout.
- Keep credentials out of Git, terminal history, process arguments, screenshots, and receipts. Use a masked prompt or ignored local credential file.
- Run clean-checkout validation and existing security gates. Missing tools and unverified behavior must be reported, not silently waived.
- Document reversible rollout and cleanup. Never reset the user's whole Clutta state or delete unrelated data.
- Keep private history, internal source notes, customer data, and unpublished correspondence out of this public repository.
- Public availability is not certification of a runtime boundary. State known limitations and require live receipts before claiming fresh-account onboarding, resume, or a new scenario verified.
- Public CI uses fake local data only. Do not expose Clutta keys to fork code or add privileged comment-triggered jobs.
- New scenarios belong under `scenarios/<name>/`. Each needs a walkthrough, owned lifecycle/fault controls, preserved evidence, healthy/failure/recovery tests, and an independently checked Clutta path before it is listed as runnable.
