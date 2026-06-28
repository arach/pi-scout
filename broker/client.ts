import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  CollaborationEvent,
  CollaborationEventKind,
  CollaborationProgress,
  CollaborationWaitingOn,
  FlightRecord,
  WorkItemRecord,
} from "@openscout/protocol";
import type {
  BrokerSnapshot,
  DeliverParams,
  PiScoutDeliverResponse,
  ScoutEvent,
  WorkItemUpdateParams,
} from "../types.ts";
import { resolveBrokerHttpUrl, resolveSocketPaths } from "../config.ts";

// ─── HTTP-over-socket ─────────────────────────────────────────────────────────

async function socketRequest<T>(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  opts?: { acceptedStatuses?: number[] },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: {
          accept: "application/json",
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload).toString(),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const bodyText = Buffer.concat(chunks).toString("utf8");
          const acceptedStatuses = new Set(opts?.acceptedStatuses ?? []);
          if (status >= 400 && !acceptedStatuses.has(status)) {
            reject(new Error(`HTTP ${status}: ${bodyText.slice(0, 200)}`));
            return;
          }

          try {
            resolve(bodyText.length > 0 ? JSON.parse(bodyText) as T : undefined as T);
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error(`Socket request timeout: ${method} ${path}`));
    }, 10_000);

    request.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    request.on("close", () => {
      clearTimeout(timeout);
    });

    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

async function socketRequestWithFallbacks<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { acceptedStatuses?: number[] },
): Promise<T> {
  let lastError: unknown;

  for (const socketPath of resolveSocketPaths()) {
    try {
      return await socketRequest<T>(socketPath, method, path, body, opts);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error(`Socket request failed: ${method} ${path}`);
}

async function requestBroker<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { acceptedStatuses?: number[] },
): Promise<T> {
  try {
    return await socketRequestWithFallbacks<T>(method, path, body, opts);
  } catch {
    return await httpFallback<T>(resolveBrokerHttpUrl(), method, path, body, opts);
  }
}

async function connectStreamSocket(paths: string[]): Promise<{
  request: ClientRequest;
  response: IncomingMessage;
}> {
  let lastError: unknown;

  for (const socketPath of paths) {
    try {
      return await new Promise<{ request: ClientRequest; response: IncomingMessage }>((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath,
            method: "GET",
            path: "/v1/events/stream",
            headers: { accept: "text/event-stream" },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            if (status >= 400) {
              reject(new Error(`HTTP ${status}: /v1/events/stream`));
              request.destroy();
              return;
            }
            resolve({ request, response });
          },
        );

        request.on("error", reject);
        request.end();
      });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("Unable to connect to Scout broker socket");
}

async function httpFallback<T>(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  opts?: { acceptedStatuses?: number[] },
): Promise<T> {
  const base = url.replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const acceptedStatuses = new Set(opts?.acceptedStatuses ?? []);
  if (!res.ok && !acceptedStatuses.has(res.status)) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ─── Broker client ────────────────────────────────────────────────────────────

let _snapshotCache: BrokerSnapshot | null = null;
let _snapshotCacheAt = 0;

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const seen = new Set<string>();
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  return normalized.length ? normalized : undefined;
}

function normalizeProgress(progress: CollaborationProgress | null | undefined): CollaborationProgress | undefined {
  if (!progress) return undefined;
  const normalized: CollaborationProgress = {};
  if (typeof progress.completedSteps === "number") normalized.completedSteps = progress.completedSteps;
  if (typeof progress.totalSteps === "number") normalized.totalSteps = progress.totalSteps;
  if (typeof progress.percent === "number") normalized.percent = progress.percent;
  if (typeof progress.checkpoint === "string" && progress.checkpoint.trim()) {
    normalized.checkpoint = progress.checkpoint.trim();
  }
  if (typeof progress.summary === "string" && progress.summary.trim()) {
    normalized.summary = progress.summary.trim();
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeWaitingOn(waitingOn: CollaborationWaitingOn | null | undefined): CollaborationWaitingOn | undefined {
  if (!waitingOn) return undefined;
  const label = waitingOn.label.trim();
  if (!label) return undefined;
  return {
    ...waitingOn,
    label,
    targetId: normalizeOptionalString(waitingOn.targetId),
  };
}

function deriveWorkItemEventKind(
  previous: WorkItemRecord,
  next: WorkItemRecord,
): CollaborationEventKind {
  if (next.acceptanceState !== previous.acceptanceState) {
    if (next.acceptanceState === "accepted") return "accepted";
    if (next.acceptanceState === "reopened") return "reopened";
  }

  if (next.state !== previous.state) {
    switch (next.state) {
      case "waiting":
        return "waiting";
      case "review":
        return "review_requested";
      case "done":
        return "done";
      case "cancelled":
        return "cancelled";
      case "working":
        return previous.state === "open" ? "claimed" : "progressed";
      case "open":
      default:
        return "progressed";
    }
  }

  if (next.ownerId !== previous.ownerId || next.nextMoveOwnerId !== previous.nextMoveOwnerId) {
    return "handoff";
  }

  return "progressed";
}

function summarizeWorkItem(record: WorkItemRecord): string {
  return record.progress?.summary?.trim()
    || record.summary?.trim()
    || record.title.trim();
}

function isWorkItemRecord(value: unknown): value is WorkItemRecord {
  return Boolean(
    value
      && typeof value === "object"
      && (value as { kind?: unknown }).kind === "work_item"
      && typeof (value as { id?: unknown }).id === "string",
  );
}

export const brokerClient = {
  async getSnapshot(force = false): Promise<BrokerSnapshot> {
    const now = Date.now();
    if (!force && _snapshotCache && now - _snapshotCacheAt < 5_000) {
      return _snapshotCache;
    }

    const raw = await requestBroker<BrokerSnapshot>(
      "GET",
      "/v1/snapshot",
    );
    const snapshot: BrokerSnapshot = {
      agents: raw.agents,
      endpoints: raw.endpoints,
      flights: raw.flights,
      collaborationRecords: raw.collaborationRecords,
    };

    _snapshotCache = snapshot;
    _snapshotCacheAt = now;
    return snapshot;
  },

  async deliver(params: DeliverParams): Promise<PiScoutDeliverResponse> {
    const payload = {
      intent: params.intent,
      body: params.body,
      caller: params.caller,
      target: params.target,
      targetLabel: params.targetLabel,
      targetAgentId: params.targetAgentId,
      targetSessionId: params.targetSessionId,
      channel: params.channel,
      replyToMessageId: params.replyToMessageId,
      replyToSessionId: params.replyToSessionId,
      ensureAwake: params.ensureAwake,
      execution: params.execution,
      projectAgent: params.projectAgent,
      labels: params.labels,
      collaborationRecordId: params.collaborationRecordId,
      workItem: params.workItem,
      messageMetadata: params.messageMetadata,
      invocationMetadata: params.invocationMetadata,
    };

    return await requestBroker<PiScoutDeliverResponse>(
      "POST",
      "/v1/deliver",
      payload,
      { acceptedStatuses: [409, 422] },
    );
  },

  async updateWorkItem(params: WorkItemUpdateParams): Promise<WorkItemRecord> {
    const workId = params.workId.trim();
    const snapshot = await this.getSnapshot(true);
    const current = snapshot.collaborationRecords?.[workId];
    if (!isWorkItemRecord(current)) {
      throw new Error(`Unknown Scout work item: ${workId}`);
    }

    const now = Date.now();
    const nextState = params.state ?? current.state;
    const nextSummary =
      params.summary === undefined
        ? current.summary
        : normalizeOptionalString(params.summary);
    const nextOwnerId =
      params.ownerId === undefined
        ? current.ownerId
        : normalizeOptionalString(params.ownerId);
    const nextMoveOwnerId =
      params.nextMoveOwnerId === undefined
        ? current.nextMoveOwnerId
        : normalizeOptionalString(params.nextMoveOwnerId);
    const nextPriority =
      params.priority === undefined
        ? current.priority
        : (params.priority ?? undefined);
    const nextLabels =
      params.labels === undefined
        ? current.labels
        : normalizeStringList(params.labels);
    const nextProgress =
      params.progress === undefined
        ? current.progress
        : normalizeProgress(params.progress);
    const waitingOn =
      params.waitingOn === undefined
        ? nextState === "waiting" ? current.waitingOn : undefined
        : normalizeWaitingOn(params.waitingOn);

    const updated: WorkItemRecord = {
      ...current,
      title: normalizeOptionalString(params.title) ?? current.title,
      summary: nextSummary,
      state: nextState,
      acceptanceState: params.acceptanceState ?? current.acceptanceState,
      ownerId: nextOwnerId,
      nextMoveOwnerId,
      priority: nextPriority,
      labels: nextLabels,
      waitingOn,
      progress: nextProgress,
      updatedAt: now,
      startedAt: current.startedAt ?? (nextState === "working" ? now : current.startedAt),
      reviewRequestedAt:
        nextState === "review"
          ? (current.reviewRequestedAt ?? now)
          : current.reviewRequestedAt,
      completedAt:
        nextState === "done" || nextState === "cancelled"
          ? (current.completedAt ?? now)
          : current.completedAt,
      metadata: params.metadata
        ? { ...(current.metadata ?? {}), ...params.metadata }
        : current.metadata,
    };

    await requestBroker("POST", "/v1/collaboration/records", updated);

    const event: CollaborationEvent = {
      id: `evt-${randomUUID()}`,
      recordId: updated.id,
      recordKind: "work_item",
      kind: deriveWorkItemEventKind(current, updated),
      actorId: normalizeOptionalString(params.actorId) ?? process.env.OPENSCOUT_AGENT ?? "operator",
      at: now,
      summary: normalizeOptionalString(params.eventSummary) ?? summarizeWorkItem(updated),
      metadata: {
        source: "pi-scout",
      },
    };

    await requestBroker("POST", "/v1/collaboration/events", event);

    _snapshotCache = null;
    return updated;
  },

  async waitForFlight(
    flightId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FlightRecord> {
    const timeoutMs = opts?.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (opts?.signal?.aborted) {
        throw new Error("waitForFlight aborted");
      }

      const snapshot = await this.getSnapshot(true);
      const flight = snapshot.flights?.[flightId];
      if (!flight) {
        throw new Error(`Flight ${flightId} is no longer available.`);
      }
      if (flight.state === "completed") return flight;
      if (flight.state === "failed") {
        throw new Error(`Flight failed: ${flight.summary ?? flight.error ?? flightId}`);
      }
      if (flight.state === "cancelled") {
        throw new Error(`Flight cancelled: ${flight.summary ?? flightId}`);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error(`waitForFlight timed out after ${timeoutMs}ms: ${flightId}`);
  },

  subscribeToEvents(
    onEvent: (event: ScoutEvent) => void,
    onError?: (err: unknown) => void,
  ): { cancel: () => void } {
    let socketRequest: ClientRequest | null = null;
    let socketResponse: IncomingMessage | null = null;
    let cancelled = false;

    const connect = () => {
      connectStreamSocket(resolveSocketPaths())
        .then(({ request, response }) => {
          if (cancelled) {
            request.destroy();
            response.destroy();
            return;
          }

          socketRequest = request;
          socketResponse = response;
          let buffer = "";

          socketRequest.on("error", (err) => {
            if (!cancelled) onError?.(err);
          });

          socketResponse.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const event = JSON.parse(line.slice(6)) as ScoutEvent;
                  onEvent(event);
                } catch {
                  // skip malformed SSE lines
                }
              }
            }
          });

          socketResponse.on("end", () => {
            if (!cancelled) setTimeout(connect, 1_000);
          });
        })
        .catch((err) => {
          if (!cancelled) onError?.(err);
        });
    };

    connect();

    return {
      cancel() {
        cancelled = true;
        socketRequest?.destroy();
        socketResponse?.destroy();
      },
    };
  },

  async upsertEndpoint(req: {
    id: string;
    agentId: string;
    nodeId: string;
    harness: string;
    transport: "local_socket" | "websocket" | "http" | "stdio";
    state: "active" | "idle" | "offline";
    displayName?: string;
    projectRoot?: string;
  }): Promise<{ ok: boolean; endpoint: unknown }> {
    return await requestBroker<{ ok: boolean; endpoint: unknown }>(
      "POST",
      "/v1/endpoints",
      req,
    );
  },

  async upsertAgentCard(card: {
    id: string;
    agentId: string;
    displayName: string;
    handle: string;
    harness: string;
    transport: "local_socket" | "websocket" | "http" | "stdio";
    projectRoot: string;
    currentDirectory?: string;
    selector?: string;
    sessionId?: string;
    nodeId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ ok: boolean; card: unknown }> {
    return await requestBroker<{ ok: boolean; card: unknown }>(
      "POST",
      "/v1/agent-cards",
      card,
    );
  },

  async getAgentCards(): Promise<unknown[]> {
    const raw = await requestBroker<{ cards: unknown[] }>(
      "GET",
      "/v1/agent-cards",
    );
    return raw.cards;
  },

  async deleteEndpoint(id: string): Promise<{ ok: boolean }> {
    return await requestBroker<{ ok: boolean }>(
      "DELETE",
      `/v1/endpoints/${encodeURIComponent(id)}`,
    );
  },
};
