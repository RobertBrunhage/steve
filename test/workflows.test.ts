/**
 * Workflow engine tests. Mirrors platform.test.ts style.
 *
 * Run: pnpm test
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = join(tmpdir(), `kellix-workflows-test-${Date.now()}`);
process.env.KELLIX_DIR = testDir;
process.env.KELLIX_VAULT_DIR = join(testDir, "vault");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log(`\n━━━ Kellix Workflow Tests ━━━`);
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "users", "robert", "agents", "devops", "workflows"), { recursive: true });

  const { parseWorkflow, workflowVersion } = await import("../src/workflows/parser.js");
  const { evaluate, interpolate, coerceBool } = await import("../src/workflows/expressions.js");
  const { writeWorkflow, readWorkflow, listWorkflows, deleteWorkflow } = await import("../src/workflows/storage.js");
  const { validateWorkflowYaml } = await import("../src/workflows/runner.js");

  // --- Parser: each step type round-trips ---

  const minimalRun = `name: t
steps:
  - id: a
    run: echo hi
`;
  const parsedRun = parseWorkflow(minimalRun);
  test("parser: run step parses", () => {
    assert.ok(parsedRun.def, parsedRun.errors.map((e) => e.message).join(", "));
    assert.equal(parsedRun.def?.steps[0].type, "run");
    assert.equal((parsedRun.def?.steps[0] as { run?: string }).run, "echo hi");
  });

  const parsedScript = parseWorkflow(`name: t
steps:
  - id: a
    script: skills/grafana/scripts/check.sh
    args: ["robert"]
`);
  test("parser: script step parses", () => {
    assert.ok(parsedScript.def);
    assert.equal(parsedScript.def?.steps[0].type, "script");
  });

  const parsedLlm = parseWorkflow(`name: t
steps:
  - id: a
    llm:
      prompt: "summarize the alerts"
      return: json
`);
  test("parser: llm step parses + return: json", () => {
    assert.ok(parsedLlm.def);
    const s = parsedLlm.def?.steps[0] as { type: string; prompt: string; return: string };
    assert.equal(s.type, "llm");
    assert.equal(s.return, "json");
  });

  const parsedPipeline = parseWorkflow(`name: t
steps:
  - id: a
    pipeline: where ".severity == 'high'"
`);
  test("parser: pipeline step parses", () => {
    assert.ok(parsedPipeline.def);
    assert.equal(parsedPipeline.def?.steps[0].type, "pipeline");
  });

  const parsedApproval = parseWorkflow(`name: t
steps:
  - id: gate
    approval:
      reason: "page on-call?"
      timeout_ms: 60000
      buttons: [["Yes", "No"]]
`);
  test("parser: approval step parses", () => {
    assert.ok(parsedApproval.def);
    const s = parsedApproval.def?.steps[0] as { type: string; reason: string; buttons: string[][] };
    assert.equal(s.type, "approval");
    assert.equal(s.reason, "page on-call?");
    assert.deepEqual(s.buttons, [["Yes", "No"]]);
  });

  const parsedSub = parseWorkflow(`name: t
steps:
  - id: a
    workflow: child-flow
    args:
      target: prod
`);
  test("parser: workflow (sub) step parses", () => {
    assert.ok(parsedSub.def);
    assert.equal(parsedSub.def?.steps[0].type, "workflow");
  });

  const parsedCross = parseWorkflow(`name: t
steps:
  - id: a
    cross_agent:
      agent: sysadmin
      workflow: investigate
      mode: sync
`);
  test("parser: cross_agent step parses", () => {
    assert.ok(parsedCross.def);
    assert.equal(parsedCross.def?.steps[0].type, "cross_agent");
  });

  const parsedWait = parseWorkflow(`name: t
steps:
  - id: a
    wait:
      for_ms: 5000
`);
  test("parser: wait step parses", () => {
    assert.ok(parsedWait.def);
    assert.equal(parsedWait.def?.steps[0].type, "wait");
  });

  // --- Parser: Lobster compatibility alias ---

  const lobsterAlias = parseWorkflow(`name: t
steps:
  - id: a
    pipeline: llm.invoke --prompt "hello world"
`);
  test("parser: Lobster pipeline: llm.invoke alias maps to llm step", () => {
    assert.ok(lobsterAlias.def);
    const s = lobsterAlias.def?.steps[0] as { type: string; prompt: string };
    assert.equal(s.type, "llm");
    assert.equal(s.prompt, "hello world");
  });

  // --- Parser: error cases ---

  const badYaml = parseWorkflow(`name: t
steps:
  - id: a
    run: oops
  unclosed bracket: [
`);
  test("parser: invalid YAML returns errors with line numbers", () => {
    assert.ok(badYaml.errors.length > 0);
    const fatal = badYaml.errors.find((e) => e.severity !== "warning");
    assert.ok(fatal, "expected at least one fatal error");
    assert.ok(fatal?.line && fatal.line > 0, `expected line number, got ${fatal?.line}`);
  });

  const missingName = parseWorkflow(`steps:
  - id: a
    run: echo hi
`);
  test("parser: missing name is a fatal error", () => {
    assert.ok(missingName.errors.some((e) => e.message.includes("name")));
    assert.equal(missingName.def, undefined);
  });

  const missingType = parseWorkflow(`name: t
steps:
  - id: a
    something_unknown: foo
`);
  test("parser: step without recognizable type is an error", () => {
    assert.ok(missingType.errors.some((e) => e.message.includes("unable to determine step type")));
  });

  const unknownKey = parseWorkflow(`name: t
totally_made_up_key: 42
steps:
  - id: a
    run: hi
`);
  test("parser: unknown top-level keys are warnings, not fatal", () => {
    assert.ok(unknownKey.def, "should still parse to a def");
    assert.ok(unknownKey.errors.some((e) => e.severity === "warning" && e.message.includes("totally_made_up_key")));
  });

  const dupIds = parseWorkflow(`name: t
steps:
  - id: a
    run: hi
  - id: a
    run: hi2
`);
  test("parser: duplicate step ids are an error", () => {
    assert.ok(dupIds.errors.some((e) => e.message.includes("duplicate step id")));
  });

  test("parser: workflowVersion is deterministic + short", () => {
    const v1 = workflowVersion("hello");
    const v2 = workflowVersion("hello");
    assert.equal(v1, v2);
    assert.equal(v1.length, 16);
  });

  // --- Expressions ---

  const ctxStub = { steps: { check: { id: "check", status: "ok" as const, attempt: 1, stdout: "alerts!", json: { count: 3 } } }, args: { name: "robert" } };
  test("expr: number literals", () => assert.equal(evaluate("1 + 2", ctxStub), 3));
  test("expr: string equality with type coercion", () => assert.equal(evaluate("$args.name == 'robert'", ctxStub), true));
  test("expr: number-string coercion", () => assert.equal(evaluate("3 == '3'", ctxStub), true));
  test("expr: less than", () => assert.equal(evaluate("$steps.check.json.count > 0", ctxStub), true));
  test("expr: not-equal", () => assert.equal(evaluate("$steps.check.status != 'error'", ctxStub), true));
  test("expr: and short-circuit", () => assert.equal(evaluate("true && false", ctxStub), false));
  test("expr: or short-circuit", () => assert.equal(evaluate("false || 42", ctxStub), 42));
  test("expr: missing path → null (not throw)", () => assert.equal(evaluate("$steps.unknown.stdout == null", ctxStub), true));
  test("expr: bang operator", () => assert.equal(evaluate("!false", ctxStub), true));
  test("expr: parens precedence", () => assert.equal(evaluate("(1 + 2) * 3", ctxStub), 9));
  test("expr: allowlisted contains() function", () => assert.equal(evaluate("contains($steps.check.stdout, 'alert')", ctxStub), true));
  test("expr: unknown function rejected", () => {
    let threw = false;
    try { evaluate("Math.evil()", ctxStub); } catch { threw = true; }
    assert.ok(threw, "expected unknown function to throw");
  });
  test("expr: coerceBool", () => {
    assert.equal(coerceBool(""), false);
    assert.equal(coerceBool("hello"), true);
    assert.equal(coerceBool(0), false);
    assert.equal(coerceBool([]), false);
    assert.equal(coerceBool([1]), true);
  });
  test("expr: interpolate", () => {
    assert.equal(interpolate("hello ${$args.name}", ctxStub), "hello robert");
    assert.equal(interpolate("count=${$steps.check.json.count}", ctxStub), "count=3");
  });

  // --- Storage ---

  test("storage: write + read round-trips a workflow", () => {
    writeWorkflow("robert", "devops", "test", minimalRun);
    const def = readWorkflow("robert", "devops", "test");
    assert.ok(def);
    assert.equal(def?.name, "t");
    assert.equal(def?.steps[0].type, "run");
  });

  test("storage: list returns defined workflows", () => {
    writeWorkflow("robert", "devops", "another", `name: another\nsteps:\n  - id: x\n    run: echo x\n`);
    const all = listWorkflows("robert", "devops");
    assert.ok(all.find((d) => d.name === "t"));
    assert.ok(all.find((d) => d.name === "another"));
  });

  test("storage: delete removes a workflow", () => {
    const ok = deleteWorkflow("robert", "devops", "another");
    assert.equal(ok, true);
    const all = listWorkflows("robert", "devops");
    assert.ok(!all.find((d) => d.name === "another"));
  });

  // --- validateWorkflowYaml integration ---

  test("validate: valid yaml returns ok", () => {
    const r = validateWorkflowYaml(minimalRun);
    assert.equal(r.ok, true);
  });

  test("validate: bad yaml returns errors", () => {
    const r = validateWorkflowYaml(`steps:\n  - id: a\n    something_wrong: foo\n`);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  });

  // --- Phase 2: run/script step + cron triggers ---

  const { createWorkflowEngine } = await import("../src/workflows/index.js");
  const { loadAllWorkflowTriggers, fingerprintWorkflowTriggers } = await import("../src/workflows/triggers.js");

  const mockBrain = { think: async () => undefined, thinkIsolated: async () => undefined } as any;
  const mockChannel = { name: "test", sendMessage: async () => ({ ok: true }), sendFile: async () => ({ ok: true }), editMessage: async () => ({ ok: true }) } as any;
  const engine = createWorkflowEngine({ brain: mockBrain, channel: mockChannel, vault: null, dataDir: testDir, projectRoot: process.cwd() });

  const runOk = parseWorkflow(`name: echo-flow
steps:
  - id: hello
    run: echo "hi from workflow"
`).def!;
  const runFail = parseWorkflow(`name: fail-flow
steps:
  - id: bad
    run: "false"
`).def!;
  const runContinue = parseWorkflow(`name: continue-flow
steps:
  - id: bad
    run: "false"
    on_error: continue
  - id: good
    run: echo "after"
`).def!;
  const runStop = parseWorkflow(`name: stop-flow
steps:
  - id: bad
    run: "false"
    on_error: stop
  - id: never
    run: echo "should not run"
`).def!;
  const runRetry = parseWorkflow(`name: retry-flow
steps:
  - id: bad
    run: "false"
    retry:
      max: 2
      backoff: linear
      delay_ms: 10
`).def!;

  test("run step: success captures stdout", async () => {
    const inst = await engine.run("robert", "devops", runOk);
    assert.equal(inst.status, "ok");
    assert.equal(inst.steps.hello.status, "ok");
    assert.match(String(inst.steps.hello.stdout ?? ""), /hi from workflow/);
  });

  test("run step: non-zero exit marks step + instance as error", async () => {
    const inst = await engine.run("robert", "devops", runFail);
    assert.equal(inst.status, "error");
    assert.equal(inst.steps.bad.status, "error");
  });

  test("run step: on_error continue advances to next step", async () => {
    const inst = await engine.run("robert", "devops", runContinue);
    assert.equal(inst.status, "ok");
    assert.equal(inst.steps.bad.status, "error");
    assert.equal(inst.steps.good.status, "ok");
  });

  test("run step: on_error stop halts workflow", async () => {
    const inst = await engine.run("robert", "devops", runStop);
    assert.equal(inst.status, "error");
    assert.equal(inst.steps.bad.status, "error");
    assert.equal(inst.steps.never, undefined);
  });

  test("run step: retry retries on failure up to max", async () => {
    const start = Date.now();
    const inst = await engine.run("robert", "devops", runRetry);
    const elapsed = Date.now() - start;
    assert.equal(inst.status, "error");
    assert.equal(inst.steps.bad.attempt, 3); // initial + 2 retries
    assert.ok(elapsed >= 30, `expected at least 30ms for backoff, got ${elapsed}ms`);
  });

  test("run step: ${args.X} interpolation works", async () => {
    const flow = parseWorkflow(`name: greet
steps:
  - id: hi
    run: echo "hello \${$args.name}"
`).def!;
    const inst = await engine.run("robert", "devops", flow, { args: { name: "robert" } });
    assert.equal(inst.status, "ok");
    assert.match(String(inst.steps.hi.stdout ?? ""), /hello robert/);
  });

  test("run step: when expression skips step", async () => {
    const flow = parseWorkflow(`name: skip
steps:
  - id: first
    run: echo "first"
  - id: maybe
    when: "$steps.first.stdout == 'NEVER'"
    run: echo "should not run"
  - id: last
    run: echo "last"
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    assert.equal(inst.status, "ok");
    assert.equal(inst.steps.maybe.status, "skipped");
    assert.equal(inst.steps.last.status, "ok");
  });

  test("run step: concurrency mode skip drops second invocation while first runs", async () => {
    const slow = parseWorkflow(`name: slow
concurrency: { mode: skip }
steps:
  - id: sleeper
    run: sleep 0.3
`).def!;
    const first = engine.run("robert", "devops", slow);
    // Give the first run a tick to register
    await new Promise((r) => setTimeout(r, 50));
    let secondError: unknown;
    try { await engine.run("robert", "devops", slow); } catch (err) { secondError = err; }
    assert.ok(secondError, "expected skip mode to throw for concurrent invocation");
    const inst = await first;
    assert.equal(inst.status, "ok");
  });

  // --- Trigger discovery ---

  writeWorkflow("robert", "devops", "cron-flow", `name: cron-flow
triggers:
  - cron: "*/5 * * * *"
steps:
  - id: tick
    run: echo tick
`);

  test("triggers: loadAllWorkflowTriggers discovers cron entries", () => {
    const all = loadAllWorkflowTriggers();
    const found = all.find((t) => t.workflowName === "cron-flow");
    assert.ok(found, "expected cron-flow in triggers");
    assert.equal(found?.cron, "*/5 * * * *");
  });

  test("triggers: fingerprint includes user/agent/workflow/spec", () => {
    const fp = fingerprintWorkflowTriggers([{
      userName: "robert", agentId: "devops", workflowName: "cron-flow",
      cron: "*/5 * * * *",
    }]);
    assert.equal(fp.length, 1);
    assert.match(fp[0], /workflow:robert:devops:cron-flow/);
  });

  // Cleanup
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}

  console.log(`\n━━━ Workflow Results: ${passed} passed, ${failed} failed ━━━\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
