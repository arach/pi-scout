# Proposal: Inbound Reachability, Inbox, and Reply for `pi-scout`

## Status

Draft.

## Summary

`pi-scout` currently does outbound Scout work well enough:

- register Scout tools
- send messages
- ask and wait for flight completion
- list known agents

But inbound is only partial today.

The extension:

- subscribes to broker events after engagement
- can show live `message.posted` and `flight.updated` notifications
- creates an agent card when engaged

It does **not** currently:

- register an endpoint
- appear honestly online in `scout who`
- maintain an inbox or unread state
- support threaded read/reply flows
- offer a true broker-to-pi invocation path

This proposal recommends a **two-phase design**:

1. **Extension-first inbound messaging**
   Make `pi-scout` look alive truthfully, receive inbound messages, keep an inbox, and reply in-thread.
2. **Optional adapter-backed invocation**
   Only if we want Scout to route `consult`/invoke work directly into a pi session.

The key idea is: **basic inbound chat should not require a full pi adapter**. A full adapter is only needed for broker-owned invocation execution.

## Current State

Today, `pi-scout` engages lazily and stays quiet until first Scout use. Once engaged, it:

- starts an SSE subscription to the broker event stream
- upserts an agent card
- shows live notifications for inbound message/flight events relevant to the current session

This is good groundwork, but it is not yet a full “reachable agent” story.

### Practical gaps

1. **No endpoint registration**
   `scout_who` derives liveness from endpoints, not cards alone. Without an endpoint, pi appears effectively offline.

2. **No honest reachability contract**
   The extension can observe broker events, but it is not yet advertising what kinds of inbound work it can actually handle.

3. **No inbox**
   Live notifications are not enough. A user needs to read recent inbound messages, track unread state, and reply later.

4. **No threaded reply flow**
   Replies should preserve `conversationId` and `replyToMessageId`, rather than always creating a fresh target-only send.

5. **No invocation transport**
   The extension can read events, but Scout does not yet have a direct “invoke this pi session and stream back a result” path through `pi-scout`.

## Do We Have A Pi Adapter?

Yes, but not in this repo.

OpenScout already has a pi adapter in the monorepo at:

- `packages/agent-sessions/src/adapters/pi.ts`

That adapter is for **Scout-managed pi sessions**. It speaks to `pi --mode rpc` and is the right foundation for direct invocation later.

What it does **not** mean:

- this standalone extension can already execute broker invocations
- every arbitrary pi session running `pi-scout` is automatically adapter-backed

So the proposal is:

- **Phase 1:** do not depend on the adapter for inbound messaging
- **Phase 2:** optionally integrate with the existing adapter for true `consult`/invoke support

## Goals

### Must have

- show pi as online only when it is truly reachable
- receive inbound Scout messages while engaged
- let the user read inbound messages after they arrive
- let the user reply in-thread
- keep the extension inert until explicitly engaged

### Nice to have

- recover missed messages after temporary disconnect
- preserve unread counts across session restarts
- eventually support adapter-backed invocation

### Non-goals for Phase 1

- pretending `pi-scout` can execute arbitrary broker invocations
- starting background activity on every pi launch
- reimplementing the Scout desktop or monitor UI inside pi

## Recommended Design

## Phase 1: Extension-First Inbound Messaging

This phase makes pi truthfully “look alive” and handle inbound chat/reply without claiming full invocation support.

### 1. Engagement model

Keep the current lazy behavior by default.

`pi-scout` should only go online when one of these happens:

- the user runs `/scout`
- the user invokes a `scout_*` tool
- optionally, a future `/scout online` command explicitly arms inbound mode for the session

Recommended commands:

- `/scout online`
- `/scout offline`
- `/scout inbox`
- `/scout reply`

This preserves the “do nothing until engaged” principle while still making inbound possible when the user opts in.

### 2. Register both card and endpoint

On engagement, `pi-scout` should upsert:

- a Scout agent card
- a Scout endpoint

The endpoint is what makes the session look live to Scout.

Recommended endpoint shape:

- `id`: stable per session, for example `pi.endpoint.<session-id>`
- `agentId`: current pi session actor id
- `harness`: `pi`
- `state`: `active` while the event stream is healthy
- `projectRoot` / `cwd`: current session cwd
- `sessionId`: pi session file or synthetic session id
- `metadata`:
  - `presenceMode: "extension"`
  - `supportsInboundMessages: true`
  - `supportsReplies: true`
  - `supportsInvoke: false`
  - `engagedAt`
  - `lastSeenAt`

### 3. Be truthful about capabilities

Phase 1 should only claim:

- inbound message delivery
- inbox/read
- reply

It should **not** claim direct invoke support.

That means:

- message-style `tell` is supported
- reply-in-thread is supported
- `consult` should either be rejected cleanly or downgraded only if the broker has an explicit semantics for that

If Scout’s external registration path currently defaults pi to broader capabilities than that, we should tighten that up so `pi-scout` does not advertise `invoke` before it is real.

### 4. Liveness and stale endpoint cleanup

Registering an endpoint once is not enough. A dead pi session should not look alive forever.

Recommended behavior:

- send a lightweight endpoint refresh every 20-30 seconds while engaged
- update `metadata.lastSeenAt`
- move state from `active` to `idle` after inactivity if useful
- best-effort `DELETE /v1/endpoints/{id}` on session shutdown

Broker-side stale cleanup would still be helpful, but the extension should not rely on it.

### 5. Inbox model

`pi-scout` should maintain a small local inbox state for the engaged session.

Suggested local model:

- thread key
  - `conversationId`
- participants
  - actor ids / labels
- last message
- unread count
- last message id
- last message timestamp

Sources of truth:

- live SSE `message.posted`
- live SSE `flight.updated`
- broker replay/bootstrap for missed items

### 6. Reading inbound messages

Live notifications are not enough. The extension should support:

- `/scout inbox`
  - list threads with unread counts
- `/scout open <thread>`
  - show recent messages
- `/scout reply`
  - pick a thread and respond

#### Broker API note

The existing broker already has:

- `GET /v1/messages`
- thread snapshot/events APIs
- event streaming

But durable “messages relevant to this actor” bootstrap is still awkward if the extension does not already know the conversation ids it should hydrate.

So the cleanest long-term shape is a broker-side inbox read API, for example:

- `GET /v1/inbox?agentId=<id>&since=<ts>`

that returns:

- relevant conversations
- recent messages
- unread or last-seen hints

If we do not want a new broker API yet, a smaller first step is:

- maintain a local cache once engaged
- use current thread/message APIs only for already-known conversation ids

That works for “live while engaged,” but it is weaker for reconnect/restart recovery.

### 7. Reply flow

Replies should preserve thread context.

When replying to an inbound message, `pi-scout` should carry:

- `conversationId`
- `replyToMessageId`

through Scout delivery when available.

Recommended reply behavior:

1. user opens a thread from `/scout inbox`
2. extension composes a reply against the latest inbound message
3. outbound delivery carries `replyToMessageId`
4. if the thread target is known, reply routes to the original sender or thread participants rather than forcing manual retargeting

This is much better than turning every reply into a fresh `send @agent ...`.

### 8. UI behavior

Keep the UI lightweight and native to pi:

- toast/notify for newly arrived inbound messages
- overlay list for inbox threads
- overlay thread view for recent messages
- overlay compose for reply

Good defaults:

- a new inbound message increments unread count
- opening the thread clears unread state locally
- replies are prefilled with the active thread target

## Phase 2: Optional Adapter-Backed Invocation

If we want Scout to route `consult` work directly into pi, the extension-only model is not enough.

For that, we should use the existing OpenScout pi adapter rather than inventing a second execution plane inside the extension.

### Why the adapter path is cleaner

The adapter already knows how to:

- drive `pi --mode rpc`
- send prompts
- capture structured turn lifecycle
- map execution back into Scout-like work semantics

So for true invoke support, the right model is:

- Scout launches or owns a pi session through the adapter
- the broker routes invocations to that adapter-backed endpoint
- `pi-scout` remains the in-session UX layer for messages, inbox, and reply

### Recommended split

#### Extension (`pi-scout`)

- presence
- inbox
- message read/reply
- live notifications
- opt-in online/offline state

#### Adapter (OpenScout monorepo)

- direct invocation execution
- flight lifecycle updates
- abort / steer / follow-up semantics
- Scout-managed pi sessions

### Transport note

If adapter-backed pi invocation becomes first-class, Scout should expose that with a truthful transport label rather than pretending the message-only extension endpoint is the same thing.

That could mean:

- a new transport such as `pi_rpc`

or:

- a clearly documented reuse of an existing transport if one is semantically correct

What we should avoid is using the same endpoint shape for both:

- “this session can see broker events and reply”
- “this session can be invoked for broker-owned work”

Those are different promises.

## Recommended Milestones

### Milestone 1: Honest presence

- upsert endpoint on engagement
- refresh endpoint heartbeat
- delete endpoint on shutdown
- show pi as `active` in `scout who`

### Milestone 2: Live inbound + reply

- maintain local inbox state from SSE
- add `/scout inbox`
- add `/scout reply`
- preserve `replyToMessageId`

### Milestone 3: Recovery

- add broker-assisted inbox bootstrap
- recover missed messages after reconnect
- avoid duplicate unread items

### Milestone 4: Optional invoke

- integrate Scout-managed pi sessions through the existing pi adapter
- expose invoke capability only for adapter-backed sessions

## Open Questions

1. Should `/scout online` be explicit, or should first `/scout` use automatically arm inbound for the rest of the session?
2. Do we want a broker-side inbox API now, or is engaged-session local cache enough for v1?
3. Should Phase 1 reject inbound `consult` outright, or surface a remediation like “pi is message-reachable but not invoke-capable”?
4. If pi is reachable only while engaged, should the card or endpoint advertise that as a wake policy hint?
5. Should read/unread state live only in pi local state, or also be reflected back into Scout later?

## Recommendation

Build **Phase 1 first**.

That gets us the thing users actually feel:

- pi shows up as alive
- inbound messages arrive
- they can be read later
- replies happen in-thread

Do **not** block that on full adapter-backed invocation.

Then, if we want `consult` to run inside pi as a real Scout work target, layer that on top through the existing OpenScout pi adapter instead of teaching the extension to become its own execution harness.
