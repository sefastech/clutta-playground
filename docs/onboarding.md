# The payment worked. Why didn't the notification?

A health check says a service is alive. This lab asks whether its work actually finished.

```text
API accepts payment -> worker queues notification -> scheduler delivers it
                                                    ^ your silent failure
```

Follow each step only after its success check passes. All payments are fake; the application, logs, and Clutta results are real.

## 1. Create your Clutta account

[Sign up](https://app.clutta.io/signup) and finish workspace setup. On **Setup account**, continue to the dashboard; no Slack or other integration is required.

**Continue when:** you can open the dashboard.

## 2. Prepare your connection

1. Open [Access keys](https://app.clutta.io/access-keys), create a dedicated **Playground** environment, and copy its workspace API key. Do not use a production key.
2. Open [Projects](https://app.clutta.io/projects), create **Scheduler lab**, then open **Connections**.
3. Select the same environment. Copy the **Workspace ID** and **Project ID**. Wait for release verification.

The key is your private pass; the project is where the lab's evidence appears. Use your own values. Never put the key in Git, chat, a command, or a recording.

The key is workspace-scoped, not project-scoped. A dedicated project/environment does not limit its permissions to this lab. Use a separate Clutta workspace if you need isolation from existing data. The helper registers lab sources, uploads their evidence, and reads Scan results; it needs no production-system access.

**Continue when:** you have the three connection values.

## 3. Open your lab

[Open in GitHub Codespaces](https://codespaces.new/sefastech/clutta-playground), select `main`, and create the Codespace. Wait for **Ready for setup**. Startup verifies the latest official stable Clutta artifacts without connecting your account or generating traffic.

```bash
node --version
docker info --format '{{.ServerVersion}}'
```

**Continue when:** both commands return versions. First-time downloads and learning take longer than the five-minute screen demonstration. Codespaces usage depends on your GitHub account.

## 4. Let Clutta learn what "finished" looks like

```bash
./lab start
```

Enter your workspace ID, project ID, and hidden key when prompted. Extra spaces at either end are trimmed; blank or malformed values still fail.

The helper checks your account and project, starts isolated Scan, and generates **600 distinct fake payments**. Each watched service writes at least 500 actual log entries. Clutta learns the journey from these records.

**Continue when:** **Review needed** prints a browser link. Learning uses live checks, not a countdown pretending to succeed.

## 5. Choose what Clutta watches

Open the printed link in your signed-in Clutta browser. Check:

- Project: **Scheduler lab**.
- Three steps: **accepted -> queued -> delivered**, with the same `payment_id` across services.
- Supporting records and the proposed deadline: how long the journey may take.

Approve and activate the correct flow yourself. The script never approves it for you.

**Continue when:** the correct flow is approved and active.

## 6. Keep health green. Stop the useful work.

```bash
./lab break
```

The helper waits for Scan to load your approval and verifies **20 healthy monitored payments** first. It then pauses only the scheduler loop. Health remains green, but a new notification waits in the outbox: the database's saved delivery queue.

**Continue when:** **PASS: Clutta cited this payment's missing final step** appears.

Open the Case File link. Follow that payment's accepted and queued records, then its missing delivery and missed deadline. Check the contradiction yourself:

```bash
./workload status
```

Expected: health `ok`, `paused: true`, and `pending` greater than zero. Clutta establishes missing completion, not an unknown root cause.

## 7. Repair and compare

```bash
./lab repair
```

**Continue when:** **PASS: backlog drained and a new monitored payment completed** appears.

Open the completed-run link. Compare it with the failed run: all three steps now finish. The historical missed deadline is not automatically declared resolved.

## 8. Repeat, stop, or explore

Repeat with `./lab break`, then `./lab repair`. When finished:

```bash
./lab stop
```

Only this lab's services stop. Its files and key are preserved under `~/sanitized-cases/clutta-playground/`.

For code experiments, fork the repository and use the [workload guide](../scenarios/scheduler/README.md). For a separate incident, submit focused sanitized evidence to [Analyze](https://app.clutta.io/analyze); that one-time path does not create a Case File.

## When you run into issues

Start with [troubleshooting](troubleshooting.md). It covers unreadable credentials, permission scopes, delayed activation, HTTP 503, local Docker setup, and safe restart/update behavior. Do not skip a failed check or edit evidence to force a result.
