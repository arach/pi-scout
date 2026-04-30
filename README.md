# pi-scout

Scout coordination for `pi` sessions.

`pi-scout` makes a `pi` session addressable through the OpenScout broker and adds Scout-native tools for:

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

For local development:

```bash
ln -s ~/dev/pi-scout ~/.pi/agent/extensions/pi-scout
```

## Requirements

- `pi`
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
