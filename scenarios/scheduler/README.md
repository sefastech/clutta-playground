# Real payment and scheduler workload

Three Node.js services and PostgreSQL perform real operations using fake payments. The commands below test application ground truth only; they do not connect to Clutta or generate findings. For the connected experience, follow the [Clutta walkthrough](../../docs/onboarding.md) and use `./lab`.

```text
Payment accepted -> worker commits outbox item -> scheduler commits mailbox delivery
                                                   |
                                              pause only this loop
                                                   |
                                       HTTP health stays green; outbox waits
```

The outbox is a database list of notifications waiting to be delivered. The mailbox is a separate table recording actual lab deliveries. This models a local transactional destination, not an external email or payment provider. Atomic delivery in this database is not a claim about exactly-once delivery over a network.

## Run locally

Requirements: Linux, Node.js 20 or newer, Git, `flock` (normally supplied by util-linux), Docker, and Docker Compose with `--wait` support. Codespaces supplies the configured Linux environment; rebuild/resume preservation and other host platforms are not certified. Run commands from the repository root.

```bash
./workload start
./workload verify
```

The verification command requires a fresh run. It submits **600 distinct fake payments at 10 per second**, checks every service log against committed database timestamps, tests input/replay boundaries, pauses the scheduler, confirms pending work with a green health check, then repairs it. Expect roughly a minute of traffic plus checks, not an instantaneous fake result.

Generated files stay under `~/sanitized-cases/clutta-playground/<run-id>/`. The command prints the exact run directory. An explicit `CLUTTA_PLAYGROUND_DATA_ROOT` override must be outside the checkout; it is intended for isolated CI/test data, not production storage.

Each log has at least 500 entries after a successful verification:

| File | What produces its entries |
| --- | --- |
| `logs/api.log` | A distinct payment is accepted and committed. |
| `logs/worker.log` | That payment is processed and its notification is queued in one transaction. |
| `logs/scheduler.log` | Its notification is delivered to the test mailbox and committed. |

The messages use plain language: "Payment accepted", "Payment processed and notification queued", and "Notification delivered to the test mailbox". Each record includes its real database time, service, payment identifier, amount, and currency. Common prices repeat across different payments, as in a real workload; a price is not a substitute for payment identity. There are no padded copies, artificial error keywords, or client-authored Clutta findings. A process can commit before its log write; missing log records remain a collection limitation, not proof that the database operation never occurred.

## Deliberately break and repair it

After verification, try the interaction yourself:

```bash
./workload pause
./workload payment
./workload status
```

Copy the new payment identifier from the payment command. Inspect it with:

```bash
./workload status YOUR_PAYMENT_ID
```

Expected: the worker has processed it, an outbox item exists, no mailbox delivery exists, and the scheduler's health still says `ok`. Give the worker time to commit before checking. The pause endpoint waits for any in-flight scheduler operation to finish before acknowledging the pause; the new payment is sent afterward.

```bash
./workload resume
./workload status YOUR_PAYMENT_ID
./workload payment
```

Expected: the pending notification is delivered, and fresh payments complete too. This is application ground truth only. The `./lab` path separately verifies loaded activation, healthy source coverage, the monitored deadline, and the backend's Case File in your Clutta account.

For additional traffic:

```bash
./workload traffic 600 10
```

Never substitute this workload's database summary for a Clutta alert or finding.

## Security and cleanup

There are no published host ports. The helper sends requests inside the owned Compose network. PostgreSQL uses password-free trust only on that isolated, fake-data network; do not copy this configuration into a shared or production environment. Local Docker access is privileged access and must belong to the intended operator. Control endpoints are lab fault controls, not production administration endpoints.

Application processes run as the operator's UID/GID, with a read-only container root, dropped capabilities, and restricted log files. PostgreSQL creates and owns its data subdirectory; do not use blanket permission changes to inspect or delete it.

```bash
./workload stop
```

This stops only the uniquely named lab project and preserves its logs, receipt, and database. A subsequent start creates a fresh run; it never truncates or resets the previous database. No command recursively removes data, prunes Docker, stops unrelated projects, or changes existing Clutta state.

Start and stop hold an operating-system lock for their data root. A simultaneous operation fails explicitly instead of creating an orphan project or overwriting the active pointer. The lock is released by the OS on exit or reboot; do not delete another process's lock file to force a start.

## Test and dependency identity

For focused local contracts:

```bash
cd scenarios/scheduler
npm ci --ignore-scripts
npm test
npm run check
```

From the repository root, `npm test` also checks simultaneous start/stop locking and recovery after the lock owner exits. These tests leave their isolated helper-test directories under `sanitized-cases`; they do not start Docker or erase data.

The `pg` dependency is exact and locked. Node and PostgreSQL container references include multi-platform immutable manifest digests. Docker builds copy the committed source and lockfile rather than using host `node_modules`. Runtime verification checks the built source marker and image revision label, confirms all three application services use the same image, and records their actual container/image IDs, lockfile checksum, PostgreSQL/Node/pg versions, times, line counts, and database state. Clean-checkout verification is required before the implementation PR is ready.
