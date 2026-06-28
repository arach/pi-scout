import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { brokerClient } from "./broker/client.ts";
import { loadConfig } from "./config.ts";
import type { ScoutEvent } from "./types.ts";

type ScoutNotification = {
  message: string;
  type: "info" | "warning" | "error";
};

export interface ScoutRuntime {
  ensureEngaged(ctx: ExtensionContext): Promise<void>;
  noteContext(ctx: ExtensionContext): void;
  callerContext(ctx?: ExtensionContext): {
    actorId: string;
    displayName: string;
    handle: string;
    currentDirectory?: string;
  } | undefined;
  dispose(): void;
}

export function createScoutRuntime(pi: ExtensionAPI): ScoutRuntime {
  let currentCtx: ExtensionContext | undefined;
  let currentRegistration: PiScoutRegistration | undefined;
  let warnedAboutDisconnect = false;
  let sawBrokerEvent = false;
  let engaged = false;
  let registrationActive = false;
  let subscription: { cancel: () => void } | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function noteContext(ctx: ExtensionContext): void {
    currentCtx = ctx;
    currentRegistration = registrationFor(ctx);
  }

  async function ensureEngaged(ctx: ExtensionContext): Promise<void> {
    noteContext(ctx);
    if (engaged) return;
    engaged = true;

    startEventSubscription();

    const config = loadConfig();
    if (!config.autoRegister) return;

    registrationActive = await refreshRegistration(ctx);
    startHeartbeat();
  }

  function callerContext(ctx = currentCtx): {
    actorId: string;
    displayName: string;
    handle: string;
    currentDirectory?: string;
  } | undefined {
    if (!currentRegistration || !registrationActive) return undefined;
    return {
      actorId: currentRegistration.agentId,
      displayName: currentRegistration.displayName,
      handle: currentRegistration.handle,
      currentDirectory: ctx?.cwd,
    };
  }

  function dispose(): void {
    subscription?.cancel();
    subscription = undefined;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  async function refreshRegistration(ctx = currentCtx): Promise<boolean> {
    if (!ctx || !currentRegistration) return false;
    const now = Date.now();
    try {
      await brokerClient.upsertAgentCard({
        id: currentRegistration.endpointId,
        agentId: currentRegistration.agentId,
        displayName: currentRegistration.displayName,
        handle: currentRegistration.handle,
        selector: currentRegistration.selector,
        harness: "pi",
        transport: "local_socket",
        projectRoot: ctx.cwd,
        currentDirectory: ctx.cwd,
        sessionId: currentRegistration.sessionId,
        metadata: {
          presenceMode: "extension",
          supportsInboundMessages: true,
          supportsReplies: false,
          supportsInvoke: false,
          sessionFile: currentRegistration.sessionFile,
          engagedAt: currentRegistration.engagedAt,
          lastSeenAt: now,
        },
      });
      registrationActive = true;
      return true;
    } catch {
      // Broker may not be running yet.
      registrationActive = false;
      return false;
    }
  }

  function startHeartbeat(): void {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      void refreshRegistration();
    }, 25_000);
  }

  function startEventSubscription(): void {
    if (subscription) return;

    try {
      subscription = brokerClient.subscribeToEvents(
        (event) => {
          sawBrokerEvent = true;
          warnedAboutDisconnect = false;
          const notification = summarizeScoutEvent(event, currentRegistration?.agentId);
          if (!notification || !currentCtx?.hasUI) return;
          currentCtx.ui.notify(notification.message, notification.type);
        },
        (err) => {
          if (!sawBrokerEvent && isInitialBrokerUnavailableError(err)) {
            return;
          }
          if (warnedAboutDisconnect) return;
          warnedAboutDisconnect = true;

          const message = `Scout SSE disconnected: ${formatError(err)}`;
          if (currentCtx?.hasUI) {
            currentCtx.ui.notify(message, "warning");
          } else {
            console.warn(message);
          }
        },
      );
    } catch {
      // Broker may not be running — stay quiet until an actual Scout action fails.
    }
  }

  pi.on("session_shutdown", async () => {
    const endpointId = currentRegistration?.endpointId;
    dispose();
    registrationActive = false;
    if (endpointId) {
      try {
        await brokerClient.deleteEndpoint(endpointId);
      } catch {
        // Best effort: the broker may already be down.
      }
    }
  });

  return {
    ensureEngaged,
    noteContext,
    callerContext,
    dispose,
  };
}

type PiScoutRegistration = {
  agentId: string;
  endpointId: string;
  displayName: string;
  handle: string;
  selector: string;
  sessionId: string;
  sessionFile?: string;
  engagedAt: number;
};

function registrationFor(ctx: ExtensionContext): PiScoutRegistration {
  const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  const stableInput = sessionFile ?? `${ctx.cwd}:ephemeral`;
  const hash = createHash("sha256").update(stableInput).digest("hex").slice(0, 10);
  const sessionId = sessionFile ? basename(sessionFile, ".jsonl") : `ephemeral-${hash}`;
  const handle = `pi-${hash}`;

  return {
    agentId: `pi.${hash}`,
    endpointId: `pi-scout.${hash}`,
    displayName: "pi",
    handle,
    selector: `@${handle}`,
    sessionId,
    sessionFile,
    engagedAt: Date.now(),
  };
}

function summarizeScoutEvent(
  event: ScoutEvent,
  currentAgentId?: string,
): ScoutNotification | null {
  if (event.kind === "message.posted") {
    const message = event.payload.message;
    const notifyList = message.audience?.notify ?? [];
    const visibleList = message.audience?.visibleTo ?? [];
    if (
      currentAgentId
      && !notifyList.includes(currentAgentId)
      && !visibleList.includes(currentAgentId)
    ) {
      return null;
    }

    return {
      message: `Scout message from ${message.actorId}: ${message.body}`,
      type: "info",
    };
  }

  if (event.kind === "flight.updated") {
    const flight = event.payload.flight;
    if (
      currentAgentId
      && flight.requesterId !== currentAgentId
      && flight.targetAgentId !== currentAgentId
    ) {
      return null;
    }

    if (flight.state === "completed") {
      return {
        message: flight.output ?? flight.summary ?? flight.error ?? "Done.",
        type: "info",
      };
    }

    if (flight.state === "failed") {
      return {
        message: flight.error ?? flight.summary ?? `Scout request ${flight.id} failed.`,
        type: "error",
      };
    }

    if (flight.state === "cancelled") {
      return {
        message: flight.summary ?? `Scout request ${flight.id} was cancelled.`,
        type: "warning",
      };
    }
  }

  return null;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isInitialBrokerUnavailableError(err: unknown): boolean {
  const message = formatError(err);
  return message.includes("ENOENT") || message.includes("ECONNREFUSED");
}
