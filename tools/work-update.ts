import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { brokerClient } from "../broker/client.ts";
import type { ScoutRuntime } from "../runtime.ts";
import type { WorkItemUpdateParams } from "../types.ts";

export function createScoutWorkUpdateTool(runtime: ScoutRuntime) {
  return {
    name: "scout_work_update",
    label: "Scout Work Update",
    description:
      "Update a durable Scout work item for progress, waiting, review, done, or cancellation. " +
      "Use this when an ask returned a workId instead of sending a second ad hoc status message.",

    parameters: {
      workId: {
        type: "string" as const,
        description: "Scout work item id returned by scout_ask",
      },
      actorId: {
        type: "string" as const,
        description: "Scout actor or agent id making this update. Defaults to OPENSCOUT_AGENT or operator.",
        required: false as const,
      },
      state: {
        type: "string" as const,
        description: "open, working, waiting, review, done, or cancelled",
        required: false as const,
      },
      title: {
        type: "string" as const,
        description: "Optional replacement title",
        required: false as const,
      },
      summary: {
        type: "string" as const,
        description: "Optional current summary",
        required: false as const,
      },
      acceptanceState: {
        type: "string" as const,
        description: "none, pending, accepted, or reopened",
        required: false as const,
      },
      ownerId: {
        type: "string" as const,
        description: "Optional current owner agent id",
        required: false as const,
      },
      nextMoveOwnerId: {
        type: "string" as const,
        description: "Optional actor or agent id that owns the next move",
        required: false as const,
      },
      priority: {
        type: "string" as const,
        description: "low, normal, high, or urgent",
        required: false as const,
      },
      labels: {
        type: "array" as const,
        description: "Optional replacement label list",
        required: false as const,
      },
      waitingOn: {
        type: "object" as const,
        description: "Required when state is waiting: { kind, label, targetId?, metadata? }",
        required: false as const,
        properties: {
          kind: { type: "string" as const, description: "actor, question, work_item, approval, artifact, or condition" },
          label: { type: "string" as const, description: "Human-readable dependency label" },
          targetId: { type: "string" as const, description: "Optional Scout id for the dependency" },
          metadata: { type: "object" as const, description: "Optional dependency metadata" },
        },
      },
      progress: {
        type: "object" as const,
        description: "Optional progress payload",
        required: false as const,
        properties: {
          completedSteps: { type: "number" as const, description: "Completed step count" },
          totalSteps: { type: "number" as const, description: "Total step count" },
          checkpoint: { type: "string" as const, description: "Current checkpoint" },
          summary: { type: "string" as const, description: "Progress summary" },
          percent: { type: "number" as const, description: "Progress percentage" },
        },
      },
      metadata: {
        type: "object" as const,
        description: "Optional metadata merged into the work item",
        required: false as const,
      },
      eventSummary: {
        type: "string" as const,
        description: "Optional collaboration event summary",
        required: false as const,
      },
    },

    async execute(
      _id: string,
      params: WorkItemUpdateParams,
      _signal: AbortSignal,
      _onUpdate: (update: any) => void,
      ctx: ExtensionContext,
    ) {
      await runtime.ensureEngaged(ctx);
      const updated = await brokerClient.updateWorkItem(params);
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated Scout work ${updated.id}: ${updated.state}`,
          },
        ],
        details: updated,
      };
    },
  };
}
