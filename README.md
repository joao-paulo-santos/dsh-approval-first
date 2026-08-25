# dsh-approval-first

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin: install it into a profile alongside your own plugins.

> [!WARNING]
> **Interim shim, expect deprecation.** This plugin works by shadowing the
> harness `edit` and `write` tools with frozen copies that add an approval
> step. When DSH grows native one-turn escalation this bundle becomes
> obsolete and should be removed. Until then a harness update can change the
> shipped tools underneath it, so the plugin ships with a drift tripwire
> that refuses to boot when the copies no longer match (see
> [Deprecation and drift](#deprecation-and-drift)).

**Approval prompts on the first call.** Under a confining sandbox, a file
mutation the policy denies fails first, then the model has to send the same
call again with `sandbox_permissions` and `justification` before the user
sees an approval prompt. This plugin shows the prompt on the first call
instead. If you like to review generated code, the review object is the
diff on the card, not model-written prose, and a rejection is a normal
result (`edit rejected by the user; file unchanged`), never a red error.

Asking only happens where the standing policy would deny the write anyway.
Inside the workspace nothing changes: writes stay silent, same as the
shipped tools.

## How to install

Requires a DeepSeek Harness checkout and a profile (here `web`):

```sh
git clone https://github.com/joao-paulo-santos/dsh-approval-first

# from the harness checkout
pnpm dsh plugin --profile web add /path/to/dsh-approval-first

# verify the profile still composes
pnpm dsh --profile web --dump-config
```

Then (re)start the harness; the host half loads at boot. No profile patch
and no configuration: the plugin is active by itself in any session whose
standing mode is not `danger-full-access`.

## What happens when

| standing mode | in-policy target (workspace, /tmp) | out-of-policy target |
|---|---|---|
| `read-only` | nothing is writable | asks first |
| `workspace-write` | silent, same as the shipped tools | asks first |
| `danger-full-access` | silent | silent |

Shadow tools are registered per agent and follow the session's current
standing mode: switching the mode mid-session arms or disarms them on the
next call, no restart needed.

Apart from the approval step the shadows mirror the shipped tools: same
schemas, same validation and error texts, same diff cards and success
phrasing. An approved write runs under a one-directory grant (the parent of
the target), never `danger-full-access`.

## Unobserved edit targets

Asking first has one exception. The shipped `edit` tool refuses a file the
session has never read (`edit requires reading "..." first`) before any
sandbox check runs, so asking approval for such an edit would spend a card
on a call that is certain to fail the moment it is allowed. The plugin
probes that same read-first gate and, when it would refuse, steps aside:
the call runs the native path and the model gets the harness's own error in
the same turn, with no prompt from anyone. *The skip never denies anything;
it only chooses who runs the check, so its errors cost a card, never a
consent.* `write` is not affected: creating a file the session considers
new is real work and still asks.

## Deprecation and drift

- When DSH grows one-turn escalation natively, remove this bundle
  (`dsh plugin --profile web remove dsh-approval-first`). No files, no
  settings, no services to clean up.
- Because the shadows are frozen copies, a harness update that changes
  `edit`/`write` would otherwise leave this plugin serving stale behavior
  with no error anywhere. The drift tripwire compares the copies against
  the live tool definitions at boot and refuses to activate on mismatch.
  `driftMode: 'warn'` downgrades that to a logged warning. Renames and
  removals upstream are caught too, so the plugin never serves tools that
  no longer exist.
- [maintenance.md](maintenance.md) holds the copied-from inventory (each
  frozen piece mapped to its upstream source file), the post-update ritual
  and a table of symptoms, causes and fixes.

Scope: `edit` and `write` only. Bash keeps the classic escalation path. If
another plugin already shadows these tools for an agent, that agent is
skipped.

## Testing

Plain Node scripts, no build step. The fake context enforces the Cordis
inject guard, so the suite can actually fail:

```sh
node test/plugin.test.mjs        # 74 checks
node test/diff-parity.test.mjs   # 31 cases, oracles against the harness's own diff package
```

## Maintenance

After every harness update, run the ritual in
[maintenance.md](maintenance.md): both suites, check the boot row (a failed
`approval-first` row is the tripwire working), one manual smoke of each
column in the behavior table.
