import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { brokerClient } from "../broker/client.ts";
import { loadConfig } from "../config.ts";
import type { FlightRecord } from "@openscout/protocol";
import type { ScoutRuntime } from "../runtime.ts";
import { resolveScoutTarget } from "../target.ts";
import type {
  PiScoutDeliverResponse,
  ScoutExecutionPreference,
  ScoutRouteTarget,
} from "../types.ts";

type ScoutAskParams = {
  target?: string;
  targetSessionId?: string;
  projectPath?: string;
  body: string;
  replyMode?: "none" | "inline" | "notify";
  harness?: string;
  session?: "new" | "reuse" | "existing" | "fork" | "any";
  replyToSessionId?: string;
  labels?: string[];
  workItem?: {
    id?: string;
    title: string;
    summary?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    labels?: string[];
    parentId?: string;
    acceptanceState?: "none" | "pending" | "accepted" | "reopened";
    metadata?: Record<string, unknown>;
  };
};

type ResolvedAskTarget = {
  routeTarget: ScoutRouteTarget;
  displayTarget: string;
  inferredProject: boolean;
};

export function createScoutAskTool(runtime: ScoutRuntime) {
  return {
    name: "scout_ask",
    label: "Scout Ask",
    description:
      "Ask a Scout agent to do work and wait for the result. " +
      "Use replyMode='inline' to wait for the result directly, " +
      "'notify' to get notified when done, or 'none' to return only the broker receipt.",

    parameters: {
      target: {
        type: "string" as const,
        description: "Known agent label (e.g. @hudson) or agent ID. Use projectPath for fresh project routing and targetSessionId for exact continuity.",
        required: false as const,
      },
      projectPath: {
        type: "string" as const,
        description: "Project or worktree path for fresh project/capability routing. Scout chooses or creates the concrete worker.",
        required: false as const,
      },
      targetSessionId: {
        type: "string" as const,
        description: "Exact Scout session id to continue. Use only when prior context must be reused.",
        required: false as const,
      },
      body: {
        type: "string" as const,
        description: "Task description or question",
      },
      harness: {
        type: "string" as const,
        description: "Optional capability hint for project routing, such as claude or codex",
        required: false as const,
      },
      session: {
        type: "string" as const,
        description: "Optional session policy: new, reuse, existing, fork, or any",
        required: false as const,
      },
      replyToSessionId: {
        type: "string" as const,
        description: "Scout session id that should receive the reply context",
        required: false as const,
      },
      labels: {
        type: "array" as const,
        description: "Optional labels to attach to the ask and any work item",
        required: false as const,
      },
      replyMode: {
        type: "string" as const,
        description: "How to receive the result",
        default: "inline",
        required: false as const,
      },
      workItem: {
        type: "object" as const,
        description: "Optional work item to create alongside the ask",
        required: false as const,
        properties: {
          id: { type: "string" as const, description: "Optional stable work item id" },
          title: { type: "string" as const, description: "Work item title" },
          summary: { type: "string" as const, description: "Optional work item summary" },
          priority: { type: "string" as const, description: "low, normal, high, or urgent" },
          labels: { type: "array" as const, description: "Optional work item labels" },
          parentId: { type: "string" as const, description: "Optional parent work item or question id" },
          acceptanceState: { type: "string" as const, description: "none, pending, accepted, or reopened" },
          metadata: { type: "object" as const, description: "Optional work item metadata" },
        },
      },
    },

    async execute(
      _id: string,
      params: ScoutAskParams,
      signal: AbortSignal,
      _onUpdate: (update: any) => void,
      ctx: ExtensionContext,
    ) {
      await runtime.ensureEngaged(ctx);
      let resolvedTarget: ResolvedAskTarget | null;
      try {
        resolvedTarget = await resolveAskTarget(params);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : "Invalid Scout ask route.",
            },
          ],
          details: undefined,
        };
      }
      if (!resolvedTarget) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Pick a Scout target, targetSessionId, projectPath, or harness first.",
            },
          ],
          details: undefined,
        };
      }

      const config = loadConfig();
      const replyMode = params.replyMode ?? config.defaultReplyMode;

      const response = await brokerClient.deliver({
        intent: "consult",
        body: params.body,
        target: resolvedTarget.routeTarget,
        targetLabel: resolvedTarget.displayTarget,
        targetSessionId:
          resolvedTarget.routeTarget.kind === "session_id"
            ? resolvedTarget.routeTarget.sessionId
            : undefined,
        replyToSessionId: normalizeOptionalString(params.replyToSessionId),
        ensureAwake: true,
        execution: {
          ...(params.harness?.trim()
            ? { harness: params.harness.trim() as ScoutExecutionPreference["harness"] }
            : {}),
          ...(resolvedTarget.routeTarget.kind === "session_id"
            ? { targetSessionId: resolvedTarget.routeTarget.sessionId }
            : {}),
          session: params.session
            ?? (resolvedTarget.routeTarget.kind === "session_id" || resolvedTarget.routeTarget.kind === "binding_ref"
              ? "existing"
              : "new"),
        },
        projectAgent:
          resolvedTarget.inferredProject || params.session === "new"
            ? { persistence: "one_time" }
            : undefined,
        labels: normalizeLabels(params.labels),
        workItem: params.workItem,
        messageMetadata: { source: "pi-scout" },
        invocationMetadata: { source: "pi-scout" },
      });

      if (response.kind !== "delivery") {
        return {
          content: [
            {
              type: "text" as const,
              text: describeDeliveryFailure(resolvedTarget.displayTarget, response),
            },
          ],
          details: response,
        };
      }

      // Handle reply modes
      if (replyMode === "none") {
        return {
          content: [
            {
              type: "text" as const,
              text: response.flight
                ? formatAskReceipt("Ask queued", resolvedTarget.displayTarget, response)
                : `Ask sent to ${resolvedTarget.displayTarget}`,
            },
          ],
          details: response,
        };
      }

      if (replyMode === "notify") {
        return {
          content: [
            {
              type: "text" as const,
              text: response.flight
                ? `${formatAskReceipt("Ask queued", resolvedTarget.displayTarget, response)}. You'll be notified when it's done.`
                : `Ask sent to ${resolvedTarget.displayTarget}`,
            },
          ],
          details: response,
        };
      }

      // inline — wait for flight completion
      if (!response.flight) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Ask sent to ${resolvedTarget.displayTarget}`,
            },
          ],
          details: response,
        };
      }

      const result = await brokerClient.waitForFlight(response.flight.id, {
        signal,
        timeoutMs: 300_000,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: describeFlightResult(result),
          },
        ],
        details: result,
      };
    },
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeLabels(labels: string[] | undefined): string[] | undefined {
  if (!labels) return undefined;
  const normalized = labels.map((label) => label.trim()).filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : undefined;
}

async function resolveAskTarget(params: ScoutAskParams): Promise<ResolvedAskTarget | null> {
  const target = normalizeOptionalString(params.target);
  const targetSessionId = normalizeOptionalString(params.targetSessionId);
  const projectPath = normalizeOptionalString(params.projectPath);
  const routeCount = [target, targetSessionId, projectPath].filter(Boolean).length;
  if (routeCount > 1) {
    throw new Error("Provide only one of target, targetSessionId, or projectPath.");
  }

  if (targetSessionId) {
    return {
      routeTarget: { kind: "session_id", sessionId: targetSessionId },
      displayTarget: `session:${targetSessionId}`,
      inferredProject: false,
    };
  }

  if (projectPath) {
    const resolvedProjectPath = resolve(projectPath);
    return {
      routeTarget: { kind: "project_path", projectPath: resolvedProjectPath },
      displayTarget: resolvedProjectPath,
      inferredProject: false,
    };
  }

  if (target) {
    const resolvedTarget = await resolveScoutTarget(target);
    return resolvedTarget
      ? { ...resolvedTarget, inferredProject: false }
      : null;
  }

  if (normalizeOptionalString(params.harness)) {
    const resolvedProjectPath = resolve(process.cwd());
    return {
      routeTarget: { kind: "project_path", projectPath: resolvedProjectPath },
      displayTarget: resolvedProjectPath,
      inferredProject: true,
    };
  }

  return null;
}

function formatAskReceipt(
  prefix: string,
  target: string,
  response: Extract<PiScoutDeliverResponse, { kind: "delivery" }>,
): string {
  const ids = [
    response.flight?.id ? `flight ${response.flight.id}` : undefined,
    response.workItem?.id ? `work ${response.workItem.id}` : undefined,
    response.conversation?.id ? `conversation ${response.conversation.id}` : undefined,
  ].filter(Boolean);
  return ids.length ? `${prefix} for ${target} (${ids.join(", ")})` : `${prefix} for ${target}`;
}

function describeDeliveryFailure(
  target: string,
  response: Exclude<PiScoutDeliverResponse, { kind: "delivery" }>,
): string {
  if (response.kind === "question") {
    return response.remediation?.detail ?? `Target ${target} is unavailable right now.`;
  }

  return response.remediation?.detail ?? `Could not reach ${target}: ${response.reason.replaceAll("_", " ")}`;
}

function describeFlightResult(result: FlightRecord): string {
  return result.output ?? result.summary ?? result.error ?? "Done.";
}
