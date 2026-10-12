# When you run into issues

Use the first failed check. The [walkthrough](onboarding.md) is the happy path; these steps are only for a problem you actually encounter.

## Account and permissions

| What you see | What to do |
| --- | --- |
| Setup account shows unavailable integrations | Continue to the dashboard. This lab needs none of those integrations. |
| Access keys is empty | Finish workspace setup, then create an environment in Access keys and wait for provisioning. |
| Key rejected or HTTP 401 | Copy your current workspace key from Access keys. Use the hidden prompt, not a shell argument. |
| Access denied, HTTP 403, or missing scopes | Check that the key, workspace, environment, and project match. If scopes are restricted, use the permission list below. |
| Project destination differs | Stop before sending evidence. Recheck your dedicated project in Connections. The script will not silently reroute it. |
| Credential file cannot be read | `lab-auth.json` must be an owned, private regular file. Do not use a colleague's credential, a symlink, or blanket permission changes. |

### Only when a restricted key lacks permissions

The normal path is the UI-issued workspace key. You do not need to type API scopes into the lab.

For a deliberately restricted key, the lab requires these existing Scan permissions:

```text
read:scan.sources
read:scan.source-bindings
read:scan.pulse-chains
read:scan.inference
read:scan.pulse-chain-instances
read:scan.case-files
write:scan.sources
write:scan.evidence
write:scan.detected-chains
```

The helper validates access; it does not grant permissions or require a new administrator secret. Do not broaden a shared production key to make the lab pass.

## Setup and Codespaces

If startup reports **Lab not ready**, run:

```bash
node --version
docker info --format '{{.ServerVersion}}'
```

Startup waits up to 60 seconds for Docker. If Docker is unavailable in the configured Node container, inspect its initializer logs:

```bash
sudo tail -n 80 /tmp/dockerd.log /tmp/containerd.log
```

Review logs for sensitive information before sharing. Do not start another daemon, delete PID files, prune volumes, or chmod the Docker socket as an assumed fix. After fixing the reported prerequisite or network error:

```bash
node .devcontainer/startup.mjs
```

If Codespaces opens a recovery container without Node, open **Codespaces: View Creation Log** and inspect the earlier failure. Use **Codespaces: Rebuild Container** after correcting it. The recovery image is not the configured lab; installing another runtime there does not repair the original environment.

### Local Linux instead

Prefer Codespaces or a local **Dev Container** from macOS, Windows or Linux. For a local container, open this checkout in VS Code with the Dev Containers extension and choose **Dev Containers: Reopen in Container**. Docker must be running Linux containers. Wait for **Ready for setup**, then run the lab inside the container terminal, not your host shell. Native Linux prerequisites follow below.

Follow the complete [local Linux setup](onboarding.md#local-linux) before launching. Use Node 24 with npm, Git, `flock`, `tar`, Docker, and Docker Compose v2 with `--wait` support. From the repository root, run:

```bash
npm ci --ignore-scripts
npm --prefix scenarios/scheduler ci --ignore-scripts
docker info
docker compose version
```

Then follow [step 4](onboarding.md#4-let-clutta-learn-what-finished-looks-like). Other host platforms are not certified by this lab.

### Cannot find package 'yaml'

The repository was cloned but its Node dependencies are missing. Run both `npm ci` commands above from the repository root, then retry `./lab start`. Do not install `yaml` globally or change the lockfile. Codespaces normally performs this setup automatically.

## Learning, activation, and detection

If the collector exits, the helper stops and prints a `docker logs` command for that collector. Readiness errors identify the missing check: log coverage, snapshot freshness, accepted heartbeat, synchronization, or Cloud source health. These are collection problems, not proof of an application failure. Correct the reported problem before retrying; do not bypass the checks.

Every start checks the latest official stable release. Unchanged artifacts are reused only after checking their integrity against current release metadata. Missing artifacts are downloaded again; altered artifacts are rejected. An unavailable release endpoint does not trigger an offline fallback.

| What you see | What to do |
| --- | --- |
| Learning keeps waiting | Run `./lab status`. The helper waits up to 15 minutes for a real three-step proposal. A timeout is a failed learning check, not a reason to lower evidence gates. |
| Approved flow is not loaded yet | Let `./lab break` verify propagation. Confirm you approved and activated the printed proposal in the correct project. No fault is injected before this check passes. |
| Notification is pending but no Case File appears | Check that activation loaded, this payment began, its deadline passed, and Scan is still observing the lab. Preserve the first failing boundary. |
| Logs are visible in Docker but not Scan | Inspect readability of the mounted lab log directory for the actual collector user. Do not use `chmod 777` or collect unrelated host logs. |
| Analyze says Needs more evidence | Keep that result. Observations or missing completion do not automatically establish a cause. |

## Repair and unavailable Cloud

`./lab repair` resumes the local scheduler before checking Cloud. If local recovery succeeds but Clutta returns HTTP 503, retry the same command after service availability returns.

Check the application separately:

```bash
./workload status
```

Recovered application state: `pending: 0`, `paused: false`, health `ok`. Cloud recovery remains unverified until the helper prints its completed-run PASS. A historical Case File may remain open.

`./lab stop` works offline and stops only the owned local services, preserving data. It reports whether Cloud source retirement was confirmed. If registration failed before a Cloud session was saved, the same command stops the idle workload.

## Restart and update safely

Fresh-account onboarding and reliable rebuild/resume preservation remain open validation checks. Do not treat a configuration setting as proof that data survived.

Before resuming a prior run, check its state without printing credentials:

```bash
test -r "$HOME/sanitized-cases/clutta-playground/active-workload.json"
```

If only `runtime/` remains, the prior run is unavailable in that mount. Keep existing volumes for investigation. A new `./lab start` is a fresh run requiring credentials and approval again, not successful recovery of the old run. **Full Rebuild** is not an assumed fix for missing data.

Before pulling updates or choosing a new stable runtime, repair if needed and run `./lab stop`. Only then:

```bash
git pull --ff-only
npm ci --ignore-scripts
npm --prefix scenarios/scheduler ci --ignore-scripts
./lab start
```

Stop if Git reports uncommitted or conflicting work. Source revisions and runtime versions must not mix inside an active run. Never reset changes or delete a lock file to force progress; an operating-system lock releases when its owning process exits.

One generated formatting difference is accepted: the final newline in `.devcontainer/devcontainer-lock.json` may be present or absent. The helper does not rewrite it. Dependency, digest, permission, staged, and other source changes are still rejected.

## Report a problem

[Open an issue](https://github.com/sefastech/clutta-playground/issues) with the failed stage, approximate time, artifact version, expected result, actual result, and a reviewed secret-free excerpt. State unknown fields as unknown.

Never attach a workspace key, UI session token, `lab-auth.json`, Scan state, or an unreviewed receipt. Generated data belongs in `sanitized-cases`, not Git. No extra playground analytics beacon is installed; authenticated lab evidence goes to Clutta as part of running the connected demo.
