// `approval:` step — pauses the workflow, sends a Telegram (or other channel)
// prompt with inline buttons, persists waiting state, resumes on
// button-click / text-reply / web approve / timeout. Output:
// $stepId.approved, $stepId.approved_by, $stepId.response.

import type { ApprovalStep, Step, WorkflowInstance } from "../types.js";
import type { StepHandler, StepResult, StepRuntime } from "../runner.js";

const DENY_RESPONSES = new Set(["no", "cancel", "deny", "reject", "abort"]);

/** Build the callback_data payload used by Telegram inline buttons.
 *  Encoded as `wf:<instanceId>:<stepId>:<labelBase64>` so the bot's
 *  callback_query handler can decode and route back to engine.resume. */
export function encodeApprovalPayload(instanceId: string, stepId: string, label: string): string {
  return `wf:${instanceId}:${stepId}:${Buffer.from(label, "utf-8").toString("base64url")}`;
}

export function decodeApprovalPayload(payload: string): { instanceId: string; stepId: string; label: string } | null {
  if (!payload.startsWith("wf:")) return null;
  const parts = payload.split(":");
  if (parts.length < 4) return null;
  try {
    const [, instanceId, stepId, b64] = parts;
    const label = Buffer.from(b64, "base64url").toString("utf-8");
    return { instanceId, stepId, label };
  } catch {
    return null;
  }
}

export class ApprovalStepHandler implements StepHandler {
  async run(step: Step, instance: WorkflowInstance, runtime: StepRuntime): Promise<StepResult> {
    if (step.type !== "approval") return { status: "error", error: `wrong handler for ${step.type}` };
    const s = step as ApprovalStep;

    const prompt = runtime.interpolate(s.reason);
    const requiredApprover = s.requiredApprover ? runtime.interpolate(s.requiredApprover) : undefined;
    const timeoutMs = s.timeoutMs;
    const deadline = timeoutMs ? new Date(Date.now() + timeoutMs).toISOString() : undefined;
    const buttons = s.buttons ?? [["Approve", "Deny"]];

    // Build channel button specs with workflow-routed callback payloads.
    const buttonSpecs = buttons.map((row) => row.map((label) => ({
      label,
      payload: encodeApprovalPayload(instance.id, step.id, label),
    })));

    try {
      await runtime.deps.channel.sendMessage(instance.userName, prompt, {
        agentId: instance.agentId,
        buttons: buttonSpecs,
      });
    } catch (err) {
      return { status: "error", error: `failed to send approval prompt: ${err instanceof Error ? err.message : String(err)}` };
    }

    try {
      const resp = await runtime.pauseForResume(step.id, {
        stepId: step.id,
        kind: "approval",
        prompt,
        requiredApprover,
        requireDifferentApprover: s.requireDifferentApprover,
        deadline,
        buttons,
        requestedAt: new Date().toISOString(),
      });

      const response = resp.response || "";
      const approvedBy = resp.approvedBy;

      // Enforce require_different_approver
      if (s.requireDifferentApprover && approvedBy) {
        const previous = (instance.approverHistory ?? []);
        if (previous.includes(approvedBy)) {
          return { status: "error", approved: false, response, approvedBy, error: `${approvedBy} already approved an earlier gate; require_different_approver` };
        }
      }

      // Enforce required_approver
      if (requiredApprover && approvedBy && approvedBy !== requiredApprover) {
        return { status: "error", approved: false, response, approvedBy, error: `only ${requiredApprover} may approve` };
      }

      const denied = DENY_RESPONSES.has(response.trim().toLowerCase());
      const approved = !denied;
      if (approvedBy && instance.approverHistory) instance.approverHistory.push(approvedBy);
      return { status: "ok", approved, approvedBy, response };
    } catch (err) {
      if (err instanceof Error && err.message === "approval_timeout") {
        return { status: "error", error: "approval_timeout" };
      }
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
