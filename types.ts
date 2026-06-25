import type {
  AgentEndpoint,
  AgentDefinition,
  CollaborationAcceptanceState,
  CollaborationEvent,
  CollaborationEventKind,
  CollaborationPriority,
  CollaborationProgress,
  CollaborationWaitingOn,
  ControlEvent,
  ScoutDeliverRequest,
  ScoutDeliverResponse,
  FlightRecord,
  MetadataMap,
  WorkItemRecord,
  WorkItemState,
} from "@openscout/protocol";

export type {
  AgentEndpoint,
  CollaborationEvent,
  ScoutDeliverRequest,
  ScoutDeliverResponse,
  FlightRecord,
  WorkItemRecord,
};

export type ScoutRouteTarget =
  | { kind: "agent_id"; agentId: string; value?: string }
  | { kind: "agent_label"; label: string; value?: string }
  | { kind: "session_id"; sessionId: string; value?: string }
  | { kind: "binding_ref"; ref: string; value?: string }
  | { kind: "project_path"; projectPath: string; value?: string }
  | { kind: "channel"; channel: string; value?: string }
  | { kind: "broadcast"; value?: string };

export type ScoutExecutionPreference = {
  harness?: string;
  model?: string;
  permissionProfile?: string;
  session?: "new" | "reuse" | "existing" | "fork" | "any";
  targetSessionId?: string;
  forkFromStateId?: string;
  forkFromSessionId?: string;
  forkContext?: {
    maxMessages?: number;
    maxBytes?: number;
    includeBrokerRecords?: boolean;
    includeObservedHarnessMaterial?: boolean;
  };
  lineage?: Record<string, unknown>;
};

export type ScoutProjectAgentSpec = {
  persistence?: "one_time" | "sticky";
  agentName?: string;
  displayName?: string;
};

export type ScoutWorkItemInput = {
  id?: string;
  title: string;
  summary?: string;
  priority?: CollaborationPriority;
  labels?: string[];
  parentId?: string;
  acceptanceState?: CollaborationAcceptanceState;
  metadata?: MetadataMap;
};

export type PiScoutDeliverResponse = ScoutDeliverResponse & {
  workItem?: WorkItemRecord;
};

// ─── Broker client ────────────────────────────────────────────────────────────

export type BrokerSnapshot = {
  agents: Record<string, AgentDefinition>;
  endpoints: Record<string, AgentEndpoint>;
  collaborationRecords?: Record<string, WorkItemRecord | unknown>;
};

export interface AgentInfo {
  id: string;
  label: string;
  state: string;
  harness?: string;
  nodeId?: string;
}

export interface DeliverParams {
  intent: "tell" | "consult";
  body: string;
  target?: ScoutRouteTarget;
  targetLabel?: string;
  targetAgentId?: string;
  targetSessionId?: string;
  channel?: string;
  replyToMessageId?: string;
  replyToSessionId?: string;
  ensureAwake?: boolean;
  execution?: ScoutExecutionPreference;
  projectAgent?: ScoutProjectAgentSpec;
  labels?: string[];
  collaborationRecordId?: string;
  workItem?: ScoutWorkItemInput;
  messageMetadata?: MetadataMap;
  invocationMetadata?: MetadataMap;
}

export interface WorkItemUpdateParams {
  workId: string;
  actorId?: string;
  title?: string;
  summary?: string | null;
  state?: WorkItemState;
  acceptanceState?: CollaborationAcceptanceState;
  ownerId?: string | null;
  nextMoveOwnerId?: string | null;
  priority?: CollaborationPriority | null;
  labels?: string[];
  waitingOn?: CollaborationWaitingOn | null;
  progress?: CollaborationProgress | null;
  metadata?: MetadataMap;
  eventSummary?: string;
}

export type WorkItemUpdateEventKind = CollaborationEventKind;

export type ScoutEvent = ControlEvent;

// ─── TUI Components ──────────────────────────────────────────────────────────

export interface PickerResult {
  selected: AgentInfo | null;
  cancelled: boolean;
}

export interface ComposeResult {
  body: string;
  confirmed: boolean;
  cancelled: boolean;
}
