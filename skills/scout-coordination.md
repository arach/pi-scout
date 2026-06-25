# Scout Coordination

## Overview

This skill provides patterns for using Scout to coordinate with other agents from within pi.

Use Scout when work needs a durable broker record, a routed message, a delegated task, or a tracked work item. Do not hide routing in message text; pass routing fields explicitly.

## Tools

### `scout_send`

Send a one-way message, status update, or FYI to a Scout agent.

```
target: Known agent label (for example "@hudson") or agent ID
body: Message text
channel: Optional explicit channel for group coordination
```

### `scout_ask`

Ask an agent to do work, review, investigate, decide, or report back.

```
target: Known agent label or ID when the exact target is already known
targetSessionId: Exact Scout session id when continuing prior context
projectPath: Project/worktree path for fresh project routing
harness: Optional capability hint such as "claude" or "codex"
body: Task description
replyMode: "inline" (bounded wait), "notify" (return receipt), "none" (receipt only)
workItem: Optional durable work item with title, summary, priority, labels, parentId, acceptanceState, and metadata
```

Project paths are routing context, not durable identities. Use `projectPath` when the codebase is known but the concrete worker is not. Add `harness` when the capability matters. Follow up with returned handles such as `flightId`, `conversationId`, `workId`, `ref`, or `session:<id>`.

### `scout_work_update`

Update an existing durable Scout work item.

```
workId: Work item id returned by scout_ask
state: "working", "waiting", "review", "done", or "cancelled"
progress: Optional checkpoint/summary/step/percent payload
waitingOn: Required when state is "waiting"
nextMoveOwnerId: Who owns the next move
eventSummary: Short collaboration event summary
```

Use `scout_work_update` for material progress, waiting, review, done, or cancellation transitions instead of sending a second ad hoc status message.

### `scout_who`

List all known Scout agents with their state and harness.

## Commands

### `/scout who`
List all known Scout agents.

### `/scout send <target> <message>`
Send a message to a specific known agent.

### `/scout ask <target> <task>`
Ask a specific known agent to do something and wait according to the configured reply mode.

### `/scout` (no args)
Open the agent picker, select an agent, compose a message, and send.

The slash command parser stays intentionally small. Use the tools directly for project-routed asks, exact session continuity, work item details, and work updates.

## Patterns

### Direct Agent Messaging
```
/scout send @hudson Can you review the parser changes?
```

### Project-Routed Work
```
Use scout_ask with projectPath: "/Users/arach/dev/openscout", harness: "codex"
```

### Exact Session Continuity
```
Use scout_ask with targetSessionId: "session-..."
```

### Work Item With Ask
```
Use scout_ask with workItem: { title: "Review PR #42", acceptanceState: "pending" }
```

### Work Progress
```
Use scout_work_update with state: "working", progress: { summary: "Tests are passing" }
```

### Waiting
```
Use scout_work_update with state: "waiting", waitingOn: { kind: "actor", label: "operator approval" }
```

### Review
```
Use scout_work_update with state: "review", nextMoveOwnerId: "operator"
```

### Done
```
Use scout_work_update with state: "done", eventSummary: "Implemented and verified."
```

## Agent Selectors

| Pattern | Meaning |
|---|---|
| `@hudson` | Agent with label "hudson" |
| `hudson.main.arts-mac-mini-local` | Full agent ID |
| `session:<id>` / `targetSessionId` | Exact prior harness session |
| `projectPath` + `harness` | Fresh project/capability routing |

Use `scout_who` only when you need to inspect available known agents. For fresh capability work, prefer project routing over guessing generic names like `claude.main`.
