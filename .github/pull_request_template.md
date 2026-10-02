## Scope

Affected behavior and audience:
Affected modules, data, and deployment surfaces:

## Evidence and contract

Input and expected result:
Healthy and failure boundaries protected:
Preserved evidence and tenant scope:
Compatibility and dependency impact:

## Engineering checklist

- [ ] The whole path and downstream consumers were inspected, not only the edited function.
- [ ] The implementation uses the canonical Clutta path; no fabricated detector result or hidden approval.
- [ ] Public interfaces, persisted data, scope boundaries, and cited evidence remain compatible.
- [ ] Deterministic positive and negative checks cover the reported behavior.
- [ ] Dependencies and artifacts are pinned, coherent, and traceable to the reviewed source.
- [ ] Clean-checkout tests, relevant module checks, static/security checks, and the build passed.
- [ ] Runtime claims are supported by the complete input-to-UI/CLI path, or explicitly remain unverified.
- [ ] Weak, missing, conflicting, and disconnected evidence remain explicit.
- [ ] Rollout, reversible cleanup, and rollback are documented.

## Validation

Commands and results:
Missing tools and checks that remain unverified:
Artifact version, source revision, and checksum:

## Release safety

Deployment target and owner:
Previous immutable rollback target:
Public-demo boundary and checks that remain unverified:
