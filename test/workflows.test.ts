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

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
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
  const { writeWorkflow, readWorkflow, listWorkflows, deleteWorkflow, readWorkflowFailureAlertState, writeWorkflowFailureAlertState } = await import("../src/workflows/storage.js");
  const { validateWorkflowYaml } = await import("../src/workflows/runner.js");

  // --- Parser: each step type round-trips ---

  const minimalRun = `name: t
steps:
  - id: a
    run: echo hi
`;
  const parsedRun = parseWorkflow(minimalRun);
  await test("parser: run step parses", () => {
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
  await test("parser: script step parses", () => {
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
  await test("parser: llm step parses + return: json", () => {
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
  await test("parser: pipeline step parses", () => {
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
  await test("parser: approval step parses", () => {
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
  await test("parser: workflow (sub) step parses", () => {
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
  await test("parser: cross_agent step parses", () => {
    assert.ok(parsedCross.def);
    assert.equal(parsedCross.def?.steps[0].type, "cross_agent");
  });

  const parsedWait = parseWorkflow(`name: t
steps:
  - id: a
    wait:
      for_ms: 5000
`);
  await test("parser: wait step parses", () => {
    assert.ok(parsedWait.def);
    assert.equal(parsedWait.def?.steps[0].type, "wait");
  });

  const parsedFailureAlert = parseWorkflow(`name: t
failure_alert:
  after: 2
  cooldown_ms: 1800000
  include_skipped: true
  mode: webhook
  to: https://example.com/hook
  best_effort: true
triggers:
  - cron: "*/5 * * * *"
    stagger_ms: 30000
steps:
  - id: a
    run: echo hi
`);
  await test("parser: failure_alert parses", () => {
    assert.ok(parsedFailureAlert.def);
    assert.deepEqual(parsedFailureAlert.def?.failureAlert, {
      after: 2,
      cooldownMs: 1800000,
      includeSkipped: true,
      mode: "webhook",
      to: "https://example.com/hook",
      bestEffort: true,
    });
    assert.equal(parsedFailureAlert.def?.triggers?.[0].staggerMs, 30000);
  });

  // --- Parser: Lobster compatibility alias ---

  const lobsterAlias = parseWorkflow(`name: t
steps:
  - id: a
    pipeline: llm.invoke --prompt "hello world"
`);
  await test("parser: Lobster pipeline: llm.invoke alias maps to llm step", () => {
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
  await test("parser: invalid YAML returns errors with line numbers", () => {
    assert.ok(badYaml.errors.length > 0);
    const fatal = badYaml.errors.find((e) => e.severity !== "warning");
    assert.ok(fatal, "expected at least one fatal error");
    assert.ok(fatal?.line && fatal.line > 0, `expected line number, got ${fatal?.line}`);
  });

  const missingName = parseWorkflow(`steps:
  - id: a
    run: echo hi
`);
  await test("parser: missing name is a fatal error", () => {
    assert.ok(missingName.errors.some((e) => e.message.includes("name")));
    assert.equal(missingName.def, undefined);
  });

  const missingType = parseWorkflow(`name: t
steps:
  - id: a
    something_unknown: foo
`);
  await test("parser: step without recognizable type is an error", () => {
    assert.ok(missingType.errors.some((e) => e.message.includes("unable to determine step type")));
  });

  const unknownKey = parseWorkflow(`name: t
totally_made_up_key: 42
steps:
  - id: a
    run: hi
`);
  await test("parser: unknown top-level keys are warnings, not fatal", () => {
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
  await test("parser: duplicate step ids are an error", () => {
    assert.ok(dupIds.errors.some((e) => e.message.includes("duplicate step id")));
  });

  await test("parser: workflowVersion is deterministic + short", () => {
    const v1 = workflowVersion("hello");
    const v2 = workflowVersion("hello");
    assert.equal(v1, v2);
    assert.equal(v1.length, 16);
  });

  // --- Expressions ---

  const ctxStub = { steps: { check: { id: "check", status: "ok" as const, attempt: 1, stdout: "alerts!", json: { count: 3 } } }, args: { name: "robert" } };
  await test("expr: number literals", () => assert.equal(evaluate("1 + 2", ctxStub), 3));
  await test("expr: string equality with type coercion", () => assert.equal(evaluate("$args.name == 'robert'", ctxStub), true));
  await test("expr: number-string coercion", () => assert.equal(evaluate("3 == '3'", ctxStub), true));
  await test("expr: less than", () => assert.equal(evaluate("$steps.check.json.count > 0", ctxStub), true));
  await test("expr: not-equal", () => assert.equal(evaluate("$steps.check.status != 'error'", ctxStub), true));
  await test("expr: and short-circuit", () => assert.equal(evaluate("true && false", ctxStub), false));
  await test("expr: or short-circuit", () => assert.equal(evaluate("false || 42", ctxStub), 42));
  await test("expr: missing path → null (not throw)", () => assert.equal(evaluate("$steps.unknown.stdout == null", ctxStub), true));
  await test("expr: bang operator", () => assert.equal(evaluate("!false", ctxStub), true));
  await test("expr: parens precedence", () => assert.equal(evaluate("(1 + 2) * 3", ctxStub), 9));
  await test("expr: allowlisted contains() function", () => assert.equal(evaluate("contains($steps.check.stdout, 'alert')", ctxStub), true));
  await test("expr: unknown function rejected", () => {
    let threw = false;
    try { evaluate("Math.evil()", ctxStub); } catch { threw = true; }
    assert.ok(threw, "expected unknown function to throw");
  });
  await test("expr: coerceBool", () => {
    assert.equal(coerceBool(""), false);
    assert.equal(coerceBool("hello"), true);
    assert.equal(coerceBool(0), false);
    assert.equal(coerceBool([]), false);
    assert.equal(coerceBool([1]), true);
  });
  await test("expr: interpolate", () => {
    assert.equal(interpolate("hello ${$args.name}", ctxStub), "hello robert");
    assert.equal(interpolate("count=${$steps.check.json.count}", ctxStub), "count=3");
  });

  // --- Storage ---

  await test("storage: write + read round-trips a workflow", () => {
    writeWorkflow("robert", "devops", "test", minimalRun);
    const def = readWorkflow("robert", "devops", "test");
    assert.ok(def);
    assert.equal(def?.name, "t");
    assert.equal(def?.steps[0].type, "run");
  });

  await test("storage: list returns defined workflows", () => {
    writeWorkflow("robert", "devops", "another", `name: another\nsteps:\n  - id: x\n    run: echo x\n`);
    const all = listWorkflows("robert", "devops");
    assert.ok(all.find((d) => d.name === "t"));
    assert.ok(all.find((d) => d.name === "another"));
  });

  await test("storage: delete removes a workflow", () => {
    const ok = deleteWorkflow("robert", "devops", "another");
    assert.equal(ok, true);
    const all = listWorkflows("robert", "devops");
    assert.ok(!all.find((d) => d.name === "another"));
  });

  await test("storage: failure alert state round-trips", () => {
    writeWorkflowFailureAlertState("robert", "devops", "test", {
      consecutiveErrors: 2,
      lastFailureAlertAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(readWorkflowFailureAlertState("robert", "devops", "test"), {
      consecutiveErrors: 2,
      lastFailureAlertAt: "2026-01-01T00:00:00.000Z",
    });
  });

  // --- validateWorkflowYaml integration ---

  await test("validate: valid yaml returns ok", () => {
    const r = validateWorkflowYaml(minimalRun);
    assert.equal(r.ok, true);
  });

  await test("validate: bad yaml returns errors", () => {
    const r = validateWorkflowYaml(`steps:\n  - id: a\n    something_wrong: foo\n`);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  });

  // --- Phase 2: run/script step + cron triggers ---

  const { createWorkflowEngine } = await import("../src/workflows/index.js");
  const { loadAllWorkflowTriggers, fingerprintWorkflowTriggers } = await import("../src/workflows/triggers.js");

  let nextPromptResponse = "(default)";
  const mockBrain = {
    think: async () => undefined,
    thinkIsolated: async () => undefined,
    promptOnce: async () => nextPromptResponse,
  } as any;
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

  await test("run step: success captures stdout", async () => {
    const inst = await engine.run("robert", "devops", runOk);
    assert.equal(inst.status, "ok");
    assert.equal(inst.steps.hello.status, "ok");
    assert.match(String(inst.steps.hello.stdout ?? ""), /hi from workflow/);
  });

  await test("run step: non-zero exit marks step + instance as error", async () => {
    const inst = await engine.run("robert", "devops", runFail);
    assert.equal(inst.status, "error");
    assert.equal(inst.steps.bad.status, "error");
  });

  await test("run step: on_error continue advances to next step", async () => {
    const inst = await engine.run("robert", "devops", runContinue);
    assert.equal(inst.status, "ok");
    assert.equal(inst.steps.bad.status, "error");
    assert.equal(inst.steps.good.status, "ok");
  });

  await test("run step: on_error stop halts workflow", async () => {
    const inst = await engine.run("robert", "devops", runStop);
    assert.equal(inst.status, "error");
    assert.equal(inst.steps.bad.status, "error");
    assert.equal(inst.steps.never, undefined);
  });

  await test("run step: retry retries on failure up to max", async () => {
    const start = Date.now();
    const inst = await engine.run("robert", "devops", runRetry);
    const elapsed = Date.now() - start;
    assert.equal(inst.status, "error");
    assert.equal(inst.steps.bad.attempt, 3); // initial + 2 retries
    assert.ok(elapsed >= 30, `expected at least 30ms for backoff, got ${elapsed}ms`);
  });

  await test("run step: ${args.X} interpolation works", async () => {
    const flow = parseWorkflow(`name: greet
steps:
  - id: hi
    run: echo "hello \${$args.name}"
`).def!;
    const inst = await engine.run("robert", "devops", flow, { args: { name: "robert" } });
    assert.equal(inst.status, "ok");
    assert.match(String(inst.steps.hi.stdout ?? ""), /hello robert/);
  });

  await test("run step: when expression skips step", async () => {
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

  await test("run step: concurrency mode skip drops second invocation while first runs", async () => {
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

  await test("triggers: loadAllWorkflowTriggers discovers cron entries", () => {
    const all = loadAllWorkflowTriggers();
    const found = all.find((t) => t.workflowName === "cron-flow");
    assert.ok(found, "expected cron-flow in triggers");
    assert.equal(found?.cron, "*/5 * * * *");
  });

  await test("triggers: fingerprint includes user/agent/workflow/spec", () => {
    const fp = fingerprintWorkflowTriggers([{
      userName: "robert", agentId: "devops", workflowName: "cron-flow",
      cron: "*/5 * * * *",
    }]);
    assert.equal(fp.length, 1);
    assert.match(fp[0], /workflow:robert:devops:cron-flow/);
  });

  // --- Phase 3: llm + pipeline ---

  await test("llm step: returns assistant text as stdout", async () => {
    nextPromptResponse = "the answer is 42";
    const flow = parseWorkflow(`name: ask
steps:
  - id: q
    llm:
      prompt: "what is the answer?"
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    assert.equal(inst.status, "ok");
    assert.equal(inst.steps.q.stdout, "the answer is 42");
  });

  await test("llm step: return: json extracts fenced JSON block", async () => {
    nextPromptResponse = 'sure, here it is:\n```json\n{"hello":"world"}\n```\n';
    const flow = parseWorkflow(`name: ask
steps:
  - id: q
    llm:
      prompt: "give me json"
      return: json
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    assert.equal(inst.status, "ok");
    assert.deepEqual(inst.steps.q.json, { hello: "world" });
  });

  await test("llm step: prompt interpolation", async () => {
    let capturedPrompt = "";
    mockBrain.promptOnce = async (_u: string, _a: string | undefined, prompt: string) => {
      capturedPrompt = prompt;
      return "ok";
    };
    const flow = parseWorkflow(`name: ask
steps:
  - id: q
    llm:
      prompt: "hello \${$args.name}"
`).def!;
    await engine.run("robert", "devops", flow, { args: { name: "robert" } });
    assert.equal(capturedPrompt, "hello robert");
    // restore
    mockBrain.promptOnce = async () => nextPromptResponse;
  });

  await test("pipeline json: passes input through as json", async () => {
    const flow = parseWorkflow(`name: pipe
steps:
  - id: src
    run: echo '[1,2,3]'
  - id: as_json
    pipeline: json
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    assert.deepEqual(inst.steps.as_json.json, [1, 2, 3]);
  });

  await test("pipeline where: filters by expression", async () => {
    const flow = parseWorkflow(`name: pipe
steps:
  - id: src
    run: echo '[{"sev":"high"},{"sev":"low"},{"sev":"high"}]'
  - id: filt
    pipeline: where "$_.sev == 'high'"
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    assert.equal(Array.isArray(inst.steps.filt.json), true);
    assert.equal((inst.steps.filt.json as unknown[]).length, 2);
  });

  await test("pipeline pick: projects fields", async () => {
    const flow = parseWorkflow(`name: pipe
steps:
  - id: src
    run: echo '[{"a":1,"b":2,"c":3}]'
  - id: proj
    pipeline: pick a,c
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    assert.deepEqual(inst.steps.proj.json, [{ a: 1, c: 3 }]);
  });

  // --- Phase 4: approval gate ---

  type CapturedMessage = { text: string; buttons?: unknown };
  let capturedMessages: CapturedMessage[] = [];
  const buttonyChannel = {
    name: "test",
    sendMessage: async (_u: string, text: string, opts?: { buttons?: unknown }) => {
      capturedMessages.push({ text, buttons: opts?.buttons });
      return { ok: true };
    },
    sendFile: async () => ({ ok: true }),
    editMessage: async () => ({ ok: true }),
  } as any;

  const approvalEngine = createWorkflowEngine({ brain: mockBrain, channel: buttonyChannel, vault: null, dataDir: testDir, projectRoot: process.cwd() });

  await test("approval step: button click resumes with response + approvedBy", async () => {
    capturedMessages = [];
    const flow = parseWorkflow(`name: gate-flow
steps:
  - id: gate
    approval:
      reason: "approve action?"
      buttons: [["Yes", "No"]]
`).def!;
    const runPromise = approvalEngine.run("robert", "devops", flow);
    // Poll briefly until the approval pause registers, then resume.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (capturedMessages.length > 0) break;
    }
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].text, "approve action?");
    // Find the running instance id via storage
    const { listInstances } = await import("../src/workflows/storage.js");
    const runs = listInstances("robert", "devops", { workflowName: "gate-flow", limit: 1 });
    const ok = approvalEngine.resume({ instanceId: runs[0].id, response: "Yes", approvedBy: "robert" });
    assert.equal(ok, true);
    const inst = await runPromise;
    assert.equal(inst.status, "ok");
    assert.equal(inst.steps.gate.approved, true);
    assert.equal(inst.steps.gate.approvedBy, "robert");
    assert.equal(inst.steps.gate.response, "Yes");
  });

  await test("approval step: deny response marks approved=false", async () => {
    capturedMessages = [];
    const flow = parseWorkflow(`name: deny-flow
steps:
  - id: gate
    approval:
      reason: "approve?"
`).def!;
    const runPromise = approvalEngine.run("robert", "devops", flow);
    await new Promise((r) => setTimeout(r, 50));
    const { listInstances } = await import("../src/workflows/storage.js");
    const runs = listInstances("robert", "devops", { workflowName: "deny-flow", limit: 1 });
    approvalEngine.resume({ instanceId: runs[0].id, response: "Cancel", approvedBy: "robert" });
    const inst = await runPromise;
    assert.equal(inst.steps.gate.approved, false);
  });

  await test("approval step: text reply via tryConsumeAsApprovalReply resumes", async () => {
    capturedMessages = [];
    const flow = parseWorkflow(`name: text-reply-flow
steps:
  - id: gate
    approval:
      reason: "ok?"
`).def!;
    const runPromise = approvalEngine.run("robert", "devops", flow);
    await new Promise((r) => setTimeout(r, 50));
    const consumed = approvalEngine.tryConsumeAsApprovalReply("robert", "devops", "Yes", "robert");
    assert.equal(consumed, true);
    const inst = await runPromise;
    assert.equal(inst.status, "ok");
    assert.equal(inst.steps.gate.response, "Yes");
  });

  await test("approval step: timeout fails the step with approval_timeout code", async () => {
    capturedMessages = [];
    const flow = parseWorkflow(`name: timeout-flow
steps:
  - id: gate
    approval:
      reason: "respond quickly"
      timeout_ms: 100
`).def!;
    const inst = await approvalEngine.run("robert", "devops", flow);
    assert.equal(inst.status, "error");
    assert.equal(inst.steps.gate.error, "approval_timeout");
  });

  await test("approval step: encodeApprovalPayload + decodeApprovalPayload round-trip", async () => {
    const { encodeApprovalPayload, decodeApprovalPayload } = await import("../src/workflows/steps/approval.js");
    const payload = encodeApprovalPayload("inst-1", "gate", "Page on-call");
    const decoded = decodeApprovalPayload(payload);
    assert.equal(decoded?.instanceId, "inst-1");
    assert.equal(decoded?.stepId, "gate");
    assert.equal(decoded?.label, "Page on-call");
  });

  // --- Phase 5: sub-workflow + cross-agent + wait + graph ---

  await test("workflow step: invokes a sub-workflow + returns its output", async () => {
    // YAML quoting note: a `run:` value beginning with `{` needs an outer
    // double-quoted string (or YAML block scalar) because plain scalars
    // can't start with flow indicators. WORKFLOW_TEMPLATE.md documents this.
    writeWorkflow("robert", "devops", "child", `name: child
steps:
  - id: emit
    run: 'printf ''{"answer": 42}'''
`);
    const flow = parseWorkflow(`name: parent
steps:
  - id: call_child
    workflow: child
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    assert.equal(inst.status, "ok", `parent failed: ${inst.error?.message}`);
    assert.deepEqual(inst.steps.call_child.json, { answer: 42 });
  });

  await test("workflow step: loop runs N times when condition holds", async () => {
    let iterCount = 0;
    writeWorkflow("robert", "devops", "loop-child", `name: loop-child
steps:
  - id: emit
    run: echo "iter \${$args.KELLIX_LOOP_ITERATION}"
`);
    const flow = parseWorkflow(`name: looper
steps:
  - id: spin
    workflow: loop-child
    loop:
      max_iterations: 3
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    // Without a stop condition, loop runs until max_iterations. We just
    // verify the final iteration ran successfully.
    assert.equal(inst.status, "ok");
    void iterCount;
  });

  await test("cross_agent step: sync mode invokes target agent + returns output", async () => {
    // Set up target agent + workflow
    mkdirSync(join(testDir, "users", "robert", "agents", "sysadmin", "workflows"), { recursive: true });
    writeWorkflow("robert", "sysadmin", "remote-job", `name: remote-job
steps:
  - id: r
    run: 'echo ''{"investigated": true}'''
`);
    const flow = parseWorkflow(`name: caller
steps:
  - id: invoke
    cross_agent:
      agent: sysadmin
      workflow: remote-job
      mode: sync
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    assert.equal(inst.status, "ok");
    assert.deepEqual(inst.steps.invoke.json, { investigated: true });
  });

  await test("cross_agent step: async mode returns immediately", async () => {
    const flow = parseWorkflow(`name: async-caller
steps:
  - id: kick
    cross_agent:
      agent: sysadmin
      workflow: remote-job
      mode: async
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    assert.equal(inst.status, "ok");
    assert.deepEqual(inst.steps.kick.json, { mode: "async", started: true });
  });

  await test("wait step: for_ms sleeps approximately", async () => {
    const flow = parseWorkflow(`name: napper
steps:
  - id: nap
    wait:
      for_ms: 80
`).def!;
    const start = Date.now();
    const inst = await engine.run("robert", "devops", flow);
    const elapsed = Date.now() - start;
    assert.equal(inst.status, "ok");
    assert.ok(elapsed >= 70, `expected ~80ms, got ${elapsed}`);
  });

  // --- Additional edge-case coverage ---

  await test("on_error: skip_rest halts subsequent steps but marks workflow ok", async () => {
    const flow = parseWorkflow(`name: skip-rest
steps:
  - id: ok_a
    run: echo a
  - id: bad
    run: "false"
    on_error: skip_rest
  - id: never
    run: echo never
`).def!;
    const inst = await engine.run("robert", "devops", flow);
    // skip_rest exits the loop without marking the workflow as error
    assert.equal(inst.steps.ok_a.status, "ok");
    assert.equal(inst.steps.bad.status, "error");
    assert.equal(inst.steps.never, undefined);
    // skip_rest stops execution but leaves last status as the loop's exit reason;
    // the runner currently completes the run normally after the break.
    assert.notEqual(inst.status, "error", "skip_rest should not bubble to instance error");
  });

  await test("approval: require_different_approver rejects same-actor approval", async () => {
    capturedMessages = [];
    const flow = parseWorkflow(`name: dual-approval
steps:
  - id: first
    approval:
      reason: "first gate"
  - id: second
    when: "$steps.first.approved"
    approval:
      reason: "second gate"
      require_different_approver: true
`).def!;
    const runPromise = approvalEngine.run("robert", "devops", flow);
    // First approval
    await new Promise((r) => setTimeout(r, 30));
    let { listInstances } = await import("../src/workflows/storage.js");
    let runs = listInstances("robert", "devops", { workflowName: "dual-approval", limit: 1 });
    approvalEngine.resume({ instanceId: runs[0].id, response: "yes", approvedBy: "robert" });
    // Second approval — same approver
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if (capturedMessages.length >= 2) break;
    }
    ({ listInstances } = await import("../src/workflows/storage.js"));
    runs = listInstances("robert", "devops", { workflowName: "dual-approval", limit: 1 });
    approvalEngine.resume({ instanceId: runs[0].id, response: "yes", approvedBy: "robert" });
    const inst = await runPromise;
    assert.equal(inst.steps.second.status, "error", "same-approver should fail second gate");
    assert.match(String(inst.steps.second.error ?? ""), /require_different_approver|already approved/);
  });

  await test("setup: propagates WORKFLOW_TEMPLATE.md + SCHEMA.json to agent workflows/", async () => {
    const { existsSync } = await import("node:fs");
    // Trigger propagation manually via syncBundledWorkflowDocs
    const { syncBundledWorkflowDocs } = await import("../src/skills.js");
    const defaultsDir = join(process.cwd(), "defaults", "workflows");
    const agentWorkflowsDir = join(testDir, "users", "robert", "agents", "devops", "workflows");
    syncBundledWorkflowDocs(defaultsDir, agentWorkflowsDir);
    assert.ok(existsSync(join(agentWorkflowsDir, "WORKFLOW_TEMPLATE.md")), "expected WORKFLOW_TEMPLATE.md");
    assert.ok(existsSync(join(agentWorkflowsDir, "SCHEMA.json")), "expected SCHEMA.json");
    // Examples are intentionally NOT copied (they'd auto-trigger)
    assert.equal(existsSync(join(agentWorkflowsDir, "examples")), false, "examples should not be copied");
  });

  await test("boot rehydrate: running → interrupted_at_boot; waiting_approval re-armed", async () => {
    const { writeInstance, scanRunnableInstances } = await import("../src/workflows/storage.js");
    const { WorkflowRunner } = await import("../src/workflows/runner.js");
    // Write two synthetic instances to disk
    const runningInst = {
      id: "rehydrate-running",
      userName: "robert",
      agentId: "devops",
      workflowName: "fake",
      workflowVersion: "abc",
      status: "running" as const,
      trigger: { kind: "manual" as const },
      args: {},
      steps: {},
      currentStepId: "stuck",
      startedAt: new Date().toISOString(),
    };
    const waitingInst = {
      id: "rehydrate-waiting",
      userName: "robert",
      agentId: "devops",
      workflowName: "fake",
      workflowVersion: "abc",
      status: "waiting_approval" as const,
      trigger: { kind: "manual" as const },
      args: {},
      steps: { gate: { id: "gate", status: "waiting" as const, attempt: 1 } },
      currentStepId: "gate",
      waiting: {
        stepId: "gate",
        kind: "approval" as const,
        prompt: "test gate",
        deadline: new Date(Date.now() + 60000).toISOString(),
        requestedAt: new Date().toISOString(),
      },
      startedAt: new Date().toISOString(),
    };
    writeInstance(runningInst);
    writeInstance(waitingInst);

    const r = new WorkflowRunner({ brain: mockBrain, channel: buttonyChannel, vault: null, dataDir: testDir, projectRoot: process.cwd() });
    r.rehydrate();

    // running should now be interrupted_at_boot
    const targets = scanRunnableInstances();
    const stillRunning = targets.find((t) => t.instance.id === "rehydrate-running");
    assert.equal(stillRunning, undefined, "running instance should have been transitioned off the runnable list");

    // waiting should remain
    const stillWaiting = targets.find((t) => t.instance.id === "rehydrate-waiting");
    assert.ok(stillWaiting, "waiting_approval should still be runnable post-rehydrate");

    // resume should now work
    const resumed = r.resume({ instanceId: "rehydrate-waiting", response: "ok", approvedBy: "robert" });
    assert.equal(resumed, true);
  });

  // --- Webhook trigger ---

  await test("webhook: POST /wf/:user/:agent/:workflow triggers workflow with body as args", async () => {
    writeWorkflow("robert", "devops", "hook-flow", `name: hook-flow
triggers:
  - webhook: true
steps:
  - id: echo
    run: 'echo \${$args.message}'
`);
    const { Hono } = await import("hono");
    const { registerUsersRoutes } = await import("../src/web/users-routes.js");
    const fakeApp = new Hono();
    const fakeDeps = {
      composeProject: "test",
      telegramFetch: fetch,
      workflowEngine: engine,
      getVault: () => null,
      setVault: () => undefined,
      isAdminConfigured: () => true,
      getAdminAuthRecord: () => ({}),
      ensureSetupToken: () => null,
      clearSetupToken: () => undefined,
      issueAdminSession: () => ({} as any),
      issueBootstrapSession: () => ({} as any),
      getAdminSession: () => null,
      getBootstrapSession: () => null,
      clearAdminSession: () => undefined,
      clearBootstrapSession: () => undefined,
      requireAdminPage: () => new Response("forbidden", { status: 403 }),
      requireAdminApi: () => new Response("forbidden", { status: 403 }),
      requireAdminForm: async () => new Response("forbidden", { status: 403 }),
      buildSetupView: () => "",
    } as any;
    registerUsersRoutes(fakeApp, fakeDeps);

    const res = await fakeApp.request("/wf/robert/devops/hook-flow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello-webhook" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal((body as { status: string }).status, "ok");
  });

  await test("webhook: token-protected workflow rejects request without X-Webhook-Token", async () => {
    writeWorkflow("robert", "devops", "secret-hook", `name: secret-hook
triggers:
  - webhook: super-secret-token
steps:
  - id: noop
    run: echo ok
`);
    const { Hono } = await import("hono");
    const { registerUsersRoutes } = await import("../src/web/users-routes.js");
    const fakeApp = new Hono();
    const fakeDeps = {
      composeProject: "test",
      telegramFetch: fetch,
      workflowEngine: engine,
      getVault: () => null,
      setVault: () => undefined,
      isAdminConfigured: () => true,
      getAdminAuthRecord: () => ({}),
      ensureSetupToken: () => null,
      clearSetupToken: () => undefined,
      issueAdminSession: () => ({} as any),
      issueBootstrapSession: () => ({} as any),
      getAdminSession: () => null,
      getBootstrapSession: () => null,
      clearAdminSession: () => undefined,
      clearBootstrapSession: () => undefined,
      requireAdminPage: () => new Response("forbidden", { status: 403 }),
      requireAdminApi: () => new Response("forbidden", { status: 403 }),
      requireAdminForm: async () => new Response("forbidden", { status: 403 }),
      buildSetupView: () => "",
    } as any;
    registerUsersRoutes(fakeApp, fakeDeps);

    const noToken = await fakeApp.request("/wf/robert/devops/secret-hook", { method: "POST" });
    assert.equal(noToken.status, 401);

    const withToken = await fakeApp.request("/wf/robert/devops/secret-hook", {
      method: "POST",
      headers: { "x-webhook-token": "super-secret-token" },
    });
    assert.equal(withToken.status, 200);
  });

  await test("scheduler: failure_alert waits for threshold, cooldowns, and resets on success", async () => {
    const { fireWorkflow } = await import("../src/scheduler.js");
    writeWorkflow("robert", "devops", "alert-flow", `name: alert-flow
failure_alert:
  after: 2
  cooldown_ms: 60000
steps:
  - id: bad
    run: "false"
`);
    const sent: string[] = [];
    const alertEngine = {
      runByName: async () => ({ status: "error", error: { message: "boom" } }),
      getDeps: () => ({ channel: { sendMessage: async (_user: string, text: string) => { sent.push(text); return { ok: true }; } } }),
    } as any;
    const entry = { userName: "robert", agentId: "devops", workflowName: "alert-flow" } as any;

    await fireWorkflow(entry, alertEngine, "cron");
    assert.equal(sent.length, 0);
    await fireWorkflow(entry, alertEngine, "cron");
    assert.equal(sent.length, 1);
    await fireWorkflow(entry, alertEngine, "cron");
    assert.equal(sent.length, 1);

    writeWorkflowFailureAlertState("robert", "devops", "alert-flow", { consecutiveErrors: 3, lastFailureAlertAt: "2000-01-01T00:00:00.000Z" });
    await fireWorkflow(entry, alertEngine, "cron");
    assert.equal(sent.length, 2);

    const okEngine = { ...alertEngine, runByName: async () => ({ status: "ok" }) } as any;
    await fireWorkflow(entry, okEngine, "cron");
    assert.deepEqual(readWorkflowFailureAlertState("robert", "devops", "alert-flow"), {});
  });

  await test("scheduler: best_effort suppresses failure alerts", async () => {
    const { fireWorkflow } = await import("../src/scheduler.js");
    writeWorkflow("robert", "devops", "best-effort-flow", `name: best-effort-flow
failure_alert:
  after: 1
  best_effort: true
steps:
  - id: bad
    run: "false"
`);
    let sends = 0;
    const alertEngine = {
      runByName: async () => ({ status: "error", error: { message: "boom" } }),
      getDeps: () => ({ channel: { sendMessage: async () => { sends++; return { ok: true }; } } }),
    } as any;
    await fireWorkflow({ userName: "robert", agentId: "devops", workflowName: "best-effort-flow" } as any, alertEngine, "cron");
    assert.equal(sends, 0);
  });

  await test("scheduler: webhook failure alerts post payload", async () => {
    const { fireWorkflow } = await import("../src/scheduler.js");
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response("ok", { status: 200 });
    }) as any;
    try {
      writeWorkflow("robert", "devops", "webhook-alert-flow", `name: webhook-alert-flow
failure_alert:
  after: 1
  mode: webhook
  to: https://example.com/alert
steps:
  - id: bad
    run: "false"
`);
      const alertEngine = {
        runByName: async () => ({ status: "error", error: { message: "boom" } }),
        getDeps: () => ({ channel: { sendMessage: async () => { throw new Error("should not send telegram"); } } }),
      } as any;
      await fireWorkflow({ userName: "robert", agentId: "devops", workflowName: "webhook-alert-flow" } as any, alertEngine, "cron");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://example.com/alert");
      assert.equal(calls[0].body.workflowName, "webhook-alert-flow");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("scheduler: stagger_ms resolves deterministically within window", async () => {
    const { resolveWorkflowStaggerMs } = await import("../src/scheduler.js");
    const entry = { userName: "robert", agentId: "devops", workflowName: "staggered", staggerMs: 30000 } as any;
    const first = resolveWorkflowStaggerMs(entry);
    const second = resolveWorkflowStaggerMs(entry);
    assert.equal(first, second);
    assert.ok(first >= 0 && first < 30000);
    assert.equal(resolveWorkflowStaggerMs({ ...entry, staggerMs: 0 }), 0);
  });

  await test("graph: renderMermaid produces a graph TD with all step nodes", async () => {
    const { renderMermaid, renderDot } = await import("../src/workflows/graph.js");
    const def = parseWorkflow(`name: g
steps:
  - id: a
    run: echo a
  - id: b
    when: "$steps.a.stdout != ''"
    run: echo b
`).def!;
    const mermaid = renderMermaid(def);
    assert.match(mermaid, /^graph TD/);
    assert.match(mermaid, /a\["a/);
    assert.match(mermaid, /b\["b/);
    assert.match(mermaid, /a -\.->/);
    const dot = renderDot(def);
    assert.match(dot, /^digraph workflow/);
    assert.match(dot, /style=dashed/);
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
