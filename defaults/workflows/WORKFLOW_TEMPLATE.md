# Workflow Template

Use this template when creating new workflows. A workflow is a YAML file at `workflows/<name>.workflow.yaml` inside your agent's workspace. The runner reads it, executes the steps in order, and persists state so it survives Kellix restarts.

## When to use a workflow vs a job

- **`manage_jobs`** — for "fire an LLM prompt on a schedule" (single tick = single LLM invocation). Cheap to author, expensive at high frequency.
- **`manage_workflows`** — for everything else: deterministic ticks, multi-step pipelines, approval gates, branching, sub-workflows, cross-agent calls. The runner only invokes the LLM when an `llm:` (or `pipeline: llm.invoke ...`) step runs.

If your watchdog is "ping every minute, only call the LLM when something's wrong," use a workflow.

## File format

```yaml
name: my-workflow              # required, unique within this agent
description: One-line description

args:                          # optional input parameters
  target:
    description: which host to check
    default: prod
    required: false

triggers:                      # optional; manual + MCP `run` always work
  - cron: "*/5 * * * *"        # standard cron
    timezone: Europe/Stockholm
    stagger_ms: 30000           # deterministic jitter window to avoid synchronized runs
  - at: "2026-06-01T08:00:00Z" # one-off
  - webhook: /grafana-alerts   # POST endpoint (registered in kellix web)
  - manual: true               # explicit declaration; same as omitting

concurrency:                   # default: { mode: queue }
  mode: skip                   # skip|queue|parallel

failure_alert:                 # optional: alert on repeated scheduled-run failures
  after: 2                     # consecutive failed runs before messaging you
  cooldown_ms: 1800000         # minimum time between repeated alerts for this workflow
  mode: telegram               # telegram (default) or webhook
  # to: "https://example.com/hook" # required for webhook mode

env:                           # static env merged into shell steps
  REGION: eu-west-1

condition: "$args.target != 'never'"   # top-level skip-expression

approval_defaults:             # inherited by approval: steps
  required_approver: robert
  timeout_ms: 600000

steps:
  - id: ...
    type-specific-key: ...
```

## Step types

Every step supports common keys:
- `id` (required, unique) — referenced as `$steps.<id>.stdout/json/error/approved/approved_by/response`
- `name` (optional, human label)
- `when` (or `condition`) — skip if expression is falsy
- `on_error` — `stop` (default) / `continue` / `skip_rest`
- `retry: { max, backoff: exponential|linear|none, delay_ms, max_delay_ms, jitter: true }`
- `env: { K: V }` — extra env merged into the step (shell steps)

## Failure alerts

For cron/at workflows, add `failure_alert` to avoid repeated messages when a workflow keeps failing:

```yaml
failure_alert:
  after: 2             # alert after 2 consecutive failed workflow runs
  cooldown_ms: 1800000 # then at most once every 30 minutes while still failing
  mode: telegram       # or webhook with `to: https://...`
```

Kellix resets the failure count after a successful run. Use `failure_alert: false` to explicitly disable alerts for a workflow. `include_skipped` is accepted for OpenClaw compatibility; current Kellix workflows only report completed scheduled runs as ok/error.

### `run:` — arbitrary shell

```yaml
- id: tick
  run: curl -s https://example.com/health
  timeout_ms: 10000
```

Note: a `run:` value starting with `{` or `[` must be wrapped in single or double quotes (YAML plain-scalar rule). Use `run: '{"hi": 1}'` or `run: "echo {hi}"`.

### `script:` — invoke a skill script

```yaml
- id: fetch
  script: skills/grafana/scripts/check-alerts.sh
  args: ["${userName}"]
```

Routes through the same allowlist + vault-secret injection as the `run_script` MCP tool. The first arg is automatically prefixed with the calling userName if missing.

### `llm:` — invoke the agent's LLM

```yaml
- id: summarize
  llm:
    prompt: "Given these alerts, summarize the impact:\n${$steps.fetch.stdout}"
    return: json           # extracts a fenced ```json ``` block from the reply
```

The agent's existing OpenCode container runs the prompt in a fresh session. Returns the assistant's text as `stdout`; with `return: json` also parses the first fenced JSON block as `json`.

(Lobster alias accepted: `pipeline: llm.invoke --prompt "..."` maps to `llm:`.)

### `pipeline:` — pure data transforms

Operate on the prior step's `json` output (or `input:` override).

```yaml
- id: critical
  pipeline: where "$_.severity == 'critical'"
- id: just_names
  pipeline: pick alertname,instance
- id: as_array
  pipeline: json
- id: tabular
  pipeline: table
```

### `approval:` — human-in-the-loop gate

```yaml
- id: gate
  approval:
    reason: "About to restart nginx on prod — proceed?"
    required_approver: robert
    require_different_approver: false
    timeout_ms: 600000
    buttons: [["Yes", "No"], ["Defer 1h"]]
```

The agent sends the `reason` to Telegram with inline buttons. Either button click OR text reply (when the chat has exactly one pending approval) resumes the workflow. Outputs `$gate.approved` (bool — `false` if response matches `No/Cancel/Deny/Reject/Abort`), `$gate.approved_by`, `$gate.response`.

Without `timeout_ms`, the gate is sticky — survives kellix restarts indefinitely until resolved.

### `workflow:` — sub-workflow (same agent)

```yaml
- id: subroutine
  workflow: child-workflow-name
  args:
    arg1: value
  loop:                            # optional
    max_iterations: 5
    condition: "$loop.json.done != true"
```

Inside a loop iteration, `KELLIX_LOOP_ITERATION` is available as an arg.

### `cross_agent:` — invoke another agent

```yaml
- id: investigate
  cross_agent:
    agent: sysadmin
    workflow: deep-investigation
    args: { incident: "${$steps.gate.response}" }
    mode: sync           # sync (default) or async
    timeout_ms: 300000
```

`sync` mode awaits the target's output; `async` fires and returns `{mode: "async", started: true}` immediately.

### `wait:` — sleep or poll

```yaml
- id: pause
  wait:
    for_ms: 5000
# or
  wait:
    until: "$steps.health.json.ok == true"
    poll_ms: 1000
    timeout_ms: 60000
```

## Expression syntax

Used in `when:`, `condition:`, `wait.until:`, and inside `${...}` string interpolation.

Shell-like operators: `||`, `&&`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `+`, `-`, `*`, `/`, `%`. Strict equality with number↔number-string coercion. Cross-type compare → `false` (no throw). Missing path → `null`.

Paths:
- `$steps.<id>.stdout` / `.json` / `.error` / `.approved` / `.approved_by` / `.response`
- `$args.<name>` (also `${args.<name>}` for interpolation)
- `$env.<NAME>`
- `$loop.iteration` / `.stdout` / `.json` (inside sub-workflow loop conditions)
- `$_` — current item (inside `pipeline: where`)

Allowlisted functions: `length(x)` / `len`, `lower(s)`, `upper(s)`, `contains(s, sub)`, `startsWith(s, p)`, `endsWith(s, p)`, `not(x)`.

No `eval`, no JS access, no prototype walking. Only own properties of the context object are reachable.

## Secrets

Same model as skill scripts:

1. Declare the secret in the **skill**'s `SKILL.md` frontmatter under `scripts.<file>.secrets`.
2. Reference the script from a workflow `script:` step.
3. Kellix injects `KELLIX_CRED_*` env vars at execution time.

Workflows themselves don't take credentials directly — keep them in skills.

## Creating one via the agent

```
manage_workflows action=validate yaml=<content>     # pre-check
manage_workflows action=define name=<n> yaml=<content>  # write
manage_workflows action=run name=<n> [args=...]     # manual trigger
manage_workflows action=view name=<n>               # inspect def
manage_workflows action=view instanceId=<id>        # inspect run
manage_workflows action=resume instanceId=<id> response="Yes"
```

Pre-flight: always `validate` before `define`. The runner refuses to write an invalid YAML and returns line-number error messages.

## Anatomy of a watchdog

The canonical pattern: cheap deterministic check every N minutes, escalate to the LLM only on anomaly, gate write actions on approval.

```yaml
name: grafana-watchdog
triggers:
  - cron: "*/5 * * * *"
concurrency: { mode: skip }
steps:
  - id: poll
    script: skills/grafana-monitor/scripts/check-alerts.sh
    args: ["${userName}"]
  - id: filter
    pipeline: where "$_.severity == 'critical'"
    input: "$steps.poll.json"
  - id: summarize
    when: "$steps.filter.json.length > 0"
    llm:
      prompt: "Summarize these critical alerts for Robert:\n${$steps.filter.json}"
  - id: gate
    when: "$steps.summarize.stdout != ''"
    approval:
      reason: "${$steps.summarize.stdout}\n\nPage on-call?"
      timeout_ms: 600000
      buttons: [["Page", "Acknowledge", "Ignore"]]
  - id: page
    when: "$steps.gate.approved && $steps.gate.response == 'Page'"
    script: skills/pagerduty/scripts/page.sh
    args: ["${userName}"]
```

Healthy 99% of the time = pure shell + a one-step pipeline. Alerts firing = LLM + human gate. Costs scale with incidents, not with poll frequency.

## When something goes wrong

- Workflow status `error` with `interrupted_at_boot`: kellix restarted mid-run. Re-trigger manually.
- `approval_timeout`: the gate exceeded `timeout_ms` without a response. Re-run the workflow.
- Step `error` with `on_error: continue`: previous step failed but advancement happened — check the audit log for context.
- Validation refusing your YAML: errors include line + column. Look at the `pipeline:`, `run:`, or `approval:` keys for misplaced characters (especially `{` in plain scalars).

## See also

- `SCHEMA.json` — JSON Schema for tooling integration.
- `examples/grafana-watchdog.workflow.yaml` — the full version of the snippet above.
- `examples/deploy-with-approval.workflow.yaml` — multi-stage deploy with required-different-approver.
- `examples/daily-summary.workflow.yaml` — daily cron that runs an LLM summarization and posts to Telegram.
