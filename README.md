<p align="center">
  <a href="https://clutta.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/clutta-logo-dark.svg">
      <img src="assets/clutta-logo-light.svg" alt="Clutta" width="186" height="60">
    </picture>
  </a>
</p>

# Clutta Playground

**The service is healthy. Did the work finish?**

Run a small distributed application, let Clutta learn its workflow, and deliberately stop one step. Follow the evidence in your own Clutta account, then repair the application and watch new work complete.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/sefastech/clutta-playground)

[Start the walkthrough](docs/onboarding.md) · [Open Clutta](https://app.clutta.io) · [Troubleshooting](docs/troubleshooting.md)

## First lab: a healthy container hiding a stopped scheduler

Three Node.js services and PostgreSQL process fake payments through a real database-backed workflow:

```text
Payment accepted -> notification queued -> notification delivered
       API                worker                 scheduler
```

| State | Application health | What Clutta verifies |
| --- | --- | --- |
| Healthy | Green | Fresh payments complete every required step. |
| Scheduler paused | Still green | A new payment misses its delivery step and deadline; its Case File cites the observed records. |
| Repaired | Green | Pending work drains and a fresh monitored payment completes. |

The lab produces 600 distinct test payments and at least 500 ordinary log entries per watched service. No real money, payment provider, production access, application-side Clutta SDK, Kubernetes, or Slack setup is needed.

## Start here

Follow the [step-by-step guide](docs/onboarding.md). It covers signup, your workspace key, a dedicated project, and these four actions:

1. `./lab start`: connect and learn, then review and activate the proposed flow in your browser.
2. `./lab break`: verify healthy controls, then silently pause notification delivery.
3. `./lab repair`: resume delivery and verify a fresh completed run in Clutta.
4. `./lab stop`: stop only this lab's services while preserving its data.

Every step has a success check. Printed links open your own proposal, Case File, and monitored run. You make the approval decision; the scripts do not make it for you.

Allow time for first-time image downloads and learning. A five-minute screen demonstration starts with setup already complete; it is not a five-minute cold-start guarantee. GitHub Codespaces usage is billed according to your account.

## Scenarios and experiments

The first runnable scenario is [payments and notification scheduling](scenarios/scheduler/README.md). The root `./lab` commands currently guide this scenario only.

More scenarios can live under `scenarios/<name>/`, each with its own workload, walkthrough, fault controls, and verification. New labs are added to this list only when their documented path has been tested.

- Repeat the silent pause and repair to compare failed and completed runs.
- Fork the repository and explore the [workload](scenarios/scheduler/README.md). Commit changes before running; modified scenarios need their own validation.
- Investigate a separate incident with focused, sanitized evidence in [Clutta Analyze](https://app.clutta.io/analyze). This is a one-time analysis, not live monitoring or Case File creation.

This release covers one scheduler journey, not arbitrary workflows. Clutta establishes missing completion from a monitored contract; it does not label an unknown cause as a diagnosis. Fresh-account onboarding and rebuild/resume preservation remain open validation checks.

## When you run into issues

Use [troubleshooting](docs/troubleshooting.md) for setup, permissions, unavailable services, or restart problems. A failed check stays failed; no prerecorded result replaces it.

Logs, credentials, and receipts stay under `~/sanitized-cases/clutta-playground/`, outside Git. Never share `lab-auth.json`, Scan state, or your workspace key. There is no added playground analytics beacon; connecting the lab sends its scoped evidence to Clutta using your account.

## Contributing

Small, reproducible improvements are welcome. Open an issue or PR with the behavior you changed, expected evidence, and test results. Read [AGENTS.md](AGENTS.md) for the engineering requirements. CI uses fake local data only and requires no Clutta key.

## License

Playground code and documentation are [MIT licensed](LICENSE). Clutta's name, logos, and assets in `assets/` are excluded from that license and must not be used to imply endorsement. This license does not change the terms of the Clutta service or downloaded runtime artifacts.
