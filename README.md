# pi-scout

Scout coordination for `pi` sessions.

`pi-scout` adds Scout-native tools to `pi` for:

- `scout_send`
- `scout_ask`
- `scout_who`

It prefers the local OpenScout Unix socket and falls back to HTTP when needed.

## Design Notes

- [Inbound reachability proposal](./docs/inbound-reachability-proposal.md)

## Install

From GitHub:

```bash
pi install git:github.com/arach/pi-scout
```

Then make sure Scout itself is initialized:

```bash
scout setup
```

During install, `pi-scout` tries to register the Scout MCP server with compatible local hosts when they are present. Today that means:

- Codex
- Claude Code

The package uses `scout mcp install` when the local Scout CLI supports it, and falls back to direct host registration when it does not.

If you do not want install-time host configuration, set:

```bash
PI_SCOUT_SKIP_HOST_MCP_SETUP=1
```

Manual fallback:

```bash
scout mcp install --host codex --host claude
```

If you are developing against an unreleased `openscout` checkout, you can register the repo version directly instead of a globally installed `scout` binary:

```bash
bun ~/dev/openscout/apps/desktop/bin/scout.ts mcp install --host codex --host claude --force
```

For local development of the extension itself:

```bash
ln -s ~/dev/pi-scout ~/.pi/agent/extensions/pi-scout
```

## Requirements

- Earendil `pi` (`@earendil-works/pi-coding-agent`)
- `scout`
- Node.js 20+
- A local OpenScout broker/runtime

## Config

Optional config file:

`~/.pi/agent/extensions/pi-scout/config.json`

```json
{
  "socketPath": null,
  "defaultReplyMode": "inline",
  "autoRegister": true,
  "fuzzySearch": true
}
```

If `socketPath` is `null`, `pi-scout` uses:

1. `OPENSCOUT_BROKER_SOCKET_PATH`
2. `~/Library/Application Support/OpenScout/runtime/broker.sock`
3. `~/.openscout/control-plane/runtime/broker.sock`

## Notes

- The extension stays inert until you invoke a Scout action.
- Structured broker rejections are surfaced cleanly instead of crashing the extension.
- Direct agent ID routing is supported alongside `@label` routing.
- Full inbound reachability for `pi` is still evolving; see the proposal above for the planned attach, endpoint, inbox, and reply flow.
