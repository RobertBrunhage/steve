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
  const { writeWorkflow, readWorkflow, listWorkflows, deleteWorkflow } = await import("../src/workflows/storage.js");
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
