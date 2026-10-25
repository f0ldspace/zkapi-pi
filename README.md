# zkapi-pi

A [Pi](https://pi.dev) extension that shows your prepaid [zkAPI](https://github.com/f0ldspace/zkapi) private balance — in ETH and USD — right from the agent, with on-chain note-expiry warnings.

The zkAPI daemon's `/admin/status` only reports policy, so this extension reads the wallet companion directly: `GET <zkapi.client_url>/wallet/status` with the owner-only bridge token from `config.json`. Balance is billed in gwei (1e-9 ETH).

## Install

```bash
pi install git:github.com/f0ldspace/zkapi-pi
```

A git install follows `main`: after a new commit is pushed, update with
`pi update git:github.com/f0ldspace/zkapi-pi` (or `pi update --extensions` for
all packages). Installing with a tag (`@v0.1.0`) pins the checkout instead.

Try it for one session without installing:

```bash
pi -e git:github.com/f0ldspace/zkapi-pi
```

## Prerequisites

- A running `zkapi-clientd` with a funded private note
  (`zkapi-clientd config` writes `~/.config/zkapi-clientd/config.json` containing the
  loopback `zkapi.client_url` and owner `zkapi.bridge_token` this extension needs).
- Nothing secret is logged: only the balance, the note id and the expiry-escalation
  flags reach the transcript.

## Usage

**Command** — `/zkapi` shows a summary; `/zkapi usd` or `/zkapi eth` print just the figure.

**Tool** — `zkapi_balance` is available to the agent, so you can just ask
*"how much zkAPI credit do I have left?"*.

## Expiry escalation

The note's on-chain expiry forfeits any unspent balance, so every output shows days
left and escalates:

| Days left | Severity |
|---|---|
| > 14 | info |
| ≤ 14 | warning |
| ≤ 3 or expired | error |

## Configuration

- `ZKAPI_CLIENTD_CONFIG_DIR` — use a different config directory than the default
  (`$XDG_CONFIG_HOME/zkapi-clientd` or `~/.config/zkapi-clientd`).
- `ZKAPI_ETH_USD_PRICE` — force an ETH/USD price (otherwise: Coinbase → Binance,
  cached 60 s).
- `ZKAPI_NOW_OVERRIDE` — epoch seconds override for `now` (used by the tests to
  exercise expiry paths deterministically).

## Development

```bash
pi --extension ./extensions/zkapi-pi.ts
```

## License

MIT
