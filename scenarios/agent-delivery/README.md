# The agent answered. Did the answer arrive?

An answer is saved. Its delivery quietly stalls. Both services stay healthy.

This scenario runs a real LangGraph tool loop, PostgreSQL outbox, and separate
delivery worker. By default the model response and delivery destination are
simulated. No model key, Telegram token, or real customer data is needed.

**Status:** local workload rehearsal. Connected Clutta acceptance is still a
gate, not a certified one-command demo. The root `./lab` commands operate the
scheduler scenario only.

## 1. Start the services

Use a GitHub Codespace or Linux workspace with Node.js 20+, Docker Compose,
Git, and `flock`. From the repository root on a committed checkout:

```bash
./scenarios/agent-delivery/workload start
./scenarios/agent-delivery/workload status
```

Continue when agent and delivery health are `ok`. Save the two application log
paths printed by `start`. Never collect the adjacent `control` directory.

## 2. Generate healthy answers

```bash
./scenarios/agent-delivery/workload traffic 600 5
./scenarios/agent-delivery/workload status
```

Wait until every answer is `accepted`, with none pending, stalled, sending, or
uncertain. Some sandbox sends are temporarily rate limited and retry normally.
Both application logs contain at least 600 real activity records, not padding.

This proves sandbox delivery, not that Clutta observed the work.

## 3. Connect Clutta before breaking anything

Use your own Clutta account, a dedicated Agent Delivery project, and a revocable
workspace key. A workspace key is not restricted to this project.

Use the project's **Connections** instructions to configure the published
collector. Watch only the `agent.log` and `delivery.log` paths from step 1.
Keep credentials outside Git and command arguments.

For a containerized collector, mount persistent state at `/var/clutta/.clutta`,
not just its parent directory. Preserve state on restart. Do not use `--fresh`
as a troubleshooting shortcut.

After connection, generate another healthy batch with step 2. In Clutta:

1. Confirm the installation belongs to this project and both files are covered.
2. Open **Flows** and inspect the learned candidate and its cited records.
3. Keep `answer_id` as the correlation identity.
4. Check the observed sequence:
   `answer.persisted` → `delivery.attempted` → `delivery.accepted`.
5. Review timing, approve, and activate the flow yourself.
6. Confirm the collector loaded that revision. Create a fresh request and
   verify its completed Flow Run and cited final acceptance in Clutta.

```bash
./scenarios/agent-delivery/workload request
```

Do not accept a one-second deadline simply because it is prefilled. Choose an
explicit demo budget based on measured healthy behavior, including retries.
Record the approved timing. Do not promise a detection latency not measured.

**Stop here if:** processing is unavailable, evidence never arrives, the candidate
does not match the records, or a fresh healthy request has no completed Flow
Run. A healthy heartbeat or local `accepted` count cannot replace that check.
Do not inject a fault to diagnose a broken observation path.

## 4. Strand one answer

Only after the connected healthy check passes:

```bash
./scenarios/agent-delivery/workload break
./scenarios/agent-delivery/workload status
```

Save the printed `answer_id`. Exactly that request is targeted, so concurrent
requests cannot consume the fault. Its state is `stalled` while the worker
remains healthy. Fault control records stay outside the watched logs.

After the approved deadline and processing delay, inspect Clutta's Case File.
It must identify this answer, project, active flow revision, and missing final
acceptance with cited application evidence.

This proves missing completion, not an unknown root cause, customer readership,
or a defect in LangGraph itself.

## 5. Repair and compare

```bash
./scenarios/agent-delivery/workload repair
./scenarios/agent-delivery/workload request
./scenarios/agent-delivery/workload status
```

The deliberately stalled answer should now be accepted without regenerating
its answer. Check its evidence and a fresh completed Flow Run in Clutta.
Preserve the missed-deadline history. Automatic Case File resolution is not
promised.

## 6. Stop safely

Stop the collector using the same isolated state/configuration used to start
it. Then:

```bash
./scenarios/agent-delivery/workload stop
```

Only this scenario's Compose project stops. Database, application logs, and
control records remain under `~/sanitized-cases/clutta-agent-delivery/`.
This does not retire a Cloud source or delete a Case File.

## When you run into issues

| What you see | What to do |
| --- | --- |
| `clutta` not found after `./lab bootstrap` | Bootstrap stores a verified runtime outside PATH. Use the published CLI installation instructions or recorded runtime path; it does not install a global command. |
| Key rejected or workspace mismatch | Check the workspace and key in Connections. Use a masked prompt or private auth file, never a committed `key.nts`. |
| Healthy installation, but no Flow Runs | Check both watched paths, active revision, routing, and processing availability. Save the error and request ID; do not keep generating traffic. |
| HTTP 503/504 or processing unavailable | Pause the connected demo. Keep collector state and buffered evidence. Local success is not Cloud success. |
| Source revision changed | Stop before starting the new revision. Previous data is preserved. |
| `sending` or `uncertain` delivery | Reconcile before resending. Automatic repair only handles deliberately `stalled` jobs. |

## Optional real delivery

Fixture/sandbox comes first. Claude and Telegram are optional, not prerequisites.
Model calls can cost money. Telegram acceptance does not prove readership.

Configure an owner-only env file outside the checkout with `ANTHROPIC_API_KEY`,
`AGENT_MODEL`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_LAB_CHAT_ID`. Use an explicit
available model ID and a dedicated lab chat. Never share this file.

```bash
export AGENT_LIVE_ENV_FILE="$HOME/agent-live.env"
export AGENT_MODEL_MODE=anthropic
export AGENT_DELIVERY_MODE=telegram
./scenarios/agent-delivery/workload start
```

Keep LangSmith tracing disabled and collect only the two application logs.
Logs omit reply text, tokens, and raw chat IDs; destination hashes remain
pseudonymous data. A successful Telegram response must contain the expected
chat, message ID, and text. Uncertain sends require reconciliation.

## Validation boundaries

Unit tests exercise the real LangGraph graph with a fixture model, sandbox,
and transport doubles. Real PostgreSQL tests cover rollback and delivery
ownership. Neither substitutes for connected Cloud receipts.

```bash
npm --prefix scenarios/agent-delivery ci --ignore-scripts
npm --prefix scenarios/agent-delivery test
npm --prefix scenarios/agent-delivery run check
```

CI uses fake data and no Clutta or provider keys. Before promoting this to a
verified connected demo, retain receipts for healthy completion, the exact
stalled answer, repair, retries, collector restart, observation loss, and
workspace/project isolation on the published runtime.
