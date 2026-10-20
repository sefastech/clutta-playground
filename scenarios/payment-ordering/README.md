# Payment completed, business order broken

The merchant must not be told "paid" before the ledger records the payment.
This scenario completes every payment but deliberately reverses those two operations for one payment. The business risk is premature fulfilment; the lab does not move money or measure financial loss.

Three services and PostgreSQL perform real local work with fake payments:

`payment accepted → balanced ledger entry → merchant test mailbox`

The fault queues the notification before the ledger transaction. Both entries eventually exist, and HTTP health stays green. Database timestamps establish the actual order independently of Clutta. Scan sees only committed business logs, never the fault switch or test verdict.

## Local verification first

Use the [local Linux setup](../../docs/onboarding.md#local-linux), or open a Codespace and wait for **Ready for setup**. Codespaces installs dependencies automatically. For a native clone, run `npm ci --ignore-scripts` and `npm --prefix scenarios/scheduler ci --ignore-scripts`.
From a clean committed checkout:

```sh
CLUTTA_PLAYGROUND_SCENARIO=payment-ordering ./workload start
CLUTTA_PLAYGROUND_SCENARIO=payment-ordering ./workload verify
CLUTTA_PLAYGROUND_SCENARIO=payment-ordering ./workload stop
```

This checks healthy order, reversed order, repair, balanced entries, duplicate submissions and log timestamps. It is application verification, not a Clutta detection claim.

## Clutta proof

Create a new dedicated project. Use the supported stable runtime, your own account and the hidden credential prompt:

```sh
./lab start payment-ordering
# Open the printed candidate. Review and activate its three ordered steps.
./lab break payment-ordering
./lab repair payment-ordering
./lab stop payment-ordering
```

Review `payment.accepted`, `ledger.recorded`, `merchant.notified` in that order, linked by `payment_id`. Do not approve another proposal or disable the deadline guards to make a check pass.

Break first verifies 20 fresh healthy monitored payments. It then submits one reversed payment, disables the fault, and requires a completed Cloud run plus its cited `out_of_order` Case File. If either is absent, the proof fails. Repair checks another 20 healthy payments and a fresh completed run; it does not erase the historical violation or automatically resolve the Case File.

Data and receipts stay in `~/sanitized-cases/clutta-playground/payment-ordering`, separate from the default scheduler scenario. Stop removes only this scenario's owned containers; records remain. An explicit data-directory override must also be separate. After an interrupted break, run repair before retrying.

### Lost local state, approved flow still exists

From a clean checkout with `npm ci` completed:

```sh
./lab start --existing-flow payment-ordering
./lab break payment-ordering
./lab repair payment-ordering
```

Enter the existing workspace/project, the key at the hidden prompt, and the
approved proposal ID from its candidate URL. This creates fresh local services
and collector state, not recovered payments, evidence or receipts. Leave
`CLUTTA_PLAYGROUND_DATA_ROOT` unset to use the persistent default above.

The lab checks the exact project-scoped approved definition, scenario events,
order, grouping and live collector catalog before generating any payments. It
does not approve, modify or relearn a flow. An unavailable or incompatible flow
stops the command. Retry `./lab start payment-ordering` after correcting the
reported problem; the saved reuse intent prevents a fallback to learning.
The healthy controls in `break` must still pass before fault injection.

## What the result means

The healthy, ordering-fault and repair sequence was verified locally against Clutta Cloud with v0.2.24. Your run must pass the same live checks; a previous result is not a substitute. This is a controlled lab with generated payments, not a production-scale benchmark.

CI checks both workloads inside the configured Dev Container. Fresh-account cloud onboarding and recovery after a full Codespaces rebuild still require a live check.

Repair verifies later healthy execution. It does not undo the original ordering violation or automatically resolve its Case File.
