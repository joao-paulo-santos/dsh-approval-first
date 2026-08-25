# maintenance.md: keeping dsh-approval-first honest across DSH updates

This bundle **mirrors the shipped `edit`/`write` tools by frozen copy**
(spec Law 4: "copy the shipped tool's code path and insert the approval
step"). That makes its behavior provably identical *today* and dependent on
re-synchronisation *tomorrow*. This file is the playbook: what is copied,
what watches for drift automatically, and exactly what to do when drift is
detected.

The plugin is an **interim shim**. The day the platform grows one-turn
escalation as a first-class status, delete this bundle
(`dsh plugin --profile web remove dsh-approval-first`); nothing else needs
cleanup.

## 1. What is copied, and from where

Every frozen piece in `lib/index.js` has exactly one upstream source. When
re-syncing, diff the upstream file against the named section; do not
re-implement from memory.

| Frozen piece (lib/index.js) | Upstream source | Notes |
| --- | --- | --- |
| `EDIT_PARAMETER_SPECS`, `WRITE_PARAMETER_SPECS`, `escalationParameterSpecs`, descriptions | `packages/fs/tool-fs/src/edit.ts` / `write.ts` / `sandbox.ts` (`schemaFields`) | byte-identity, incl. property order |
| `parameterSchemaFrom` | `packages/core/tools/src/schema.ts` (`parameterSchemaSpecToJsonSchema` + compiler key order: type → annotations → enum/const) | order-sensitive |
| `argumentViolationsFrom`, `assertValidToolArguments` | `packages/core/tools/src/json-schema.ts` (`validateJsonSchemaValue` message texts) + `schema.ts` (`ToolArgsError`) | message texts pinned |
| `assertValidEscalationArguments` | `packages/sandbox/sandbox/src/escalation.ts` (`validateEscalationArgs`) | verbatim texts |
| `parseEditArguments` / `parseWriteArguments` | `edit.ts` / `write.ts` (`parseEditArgs` / `parseWriteArgs`) | verbatim texts |
| `formatEditOutput` / `formatWriteOutput` | `edit.ts` / `write.ts` | verbatim phrasing |
| `sessionCwd`, `sessionResolveOptions` | `packages/fs/tool-fs/src/session-cwd.ts` | incl. `canonicalPath` fallback logic |
| `remediateGuardedMutationError` | `packages/fs/tool-fs/src/error.ts` (`remediateFsError`) | remedies table |
| `mapSandboxDenialError`, `sandboxDenialMarker`, hint | `tool-fs/src/sandbox.ts` (`mapError`) + `sandbox/src/escalation.ts` markers | verbatim |
| `computeHunkDiffs` + Myers engine | `tool-fs/src/diff.ts` over `diff`'s `structuredPatch(context: 3)` | parity suite is the oracle |
| output schemas (shipped parts) | `edit.ts` / `write.ts` `output.schema` | plus documented deltas |
| approval outcome vocabulary | `packages/interaction/user-approval/src/index.ts` (`OUTCOMES`, grant = `allowed-once`) | union member names |
| `writableRootsOf`, `isPathUnder`, `canonicalPath` | `packages/sandbox/sandbox/src/roots.ts`, `packages/fs/fs-sandbox/src/containment.ts` | verbatim ports |
| standing-policy resolve | `packages/sandbox/sandbox-policy/src/index.ts` (`resolve({ session })`) | read-only usage |
| `sandbox/mode` switch listener (live arm/disarm, v0.4.0) | `packages/sandbox/sandbox-policy/src/session-mode.ts` (`'sandbox/mode'` event, payload under `event.data`) + the `session/event` envelope convention (guide 04, workspace-history pattern) | event type + envelope shape |
| `gateRefusesUnobservedEdit` probe (unobserved-edit skip, v0.6.0) | `packages/fs/fs-observation-policy/src/index.ts` `editIntent`: a pure WeakMap lookup (owner `actor?.agent?.session`) occupying the single `fs/edit-intent` decision slot. Dispatch contract: `await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)`; resolves `{version}` (observed) or `undefined` (no listener composed); throws `FS_NOT_OBSERVED` (never read) / `FS_NOT_FOUND` (confirmed absent) | waterfall dispatch signature + return/throw codes |
| per-agent registration | `packages/schedule/schedule/src/index.ts` pattern over `agent.ctx.tools.register` | mechanism, not text |

## 2. What watches for drift automatically (and what cannot)

The **drift tripwire** (v0.3.0) compares, at activation and on every
`tools/change`, the frozen `description`, `parameters` (order-sensitive),
and output schema (modulo the documented `unchangedReason` / relaxed
`operation` deltas) against the live global definitions via
`ctx.tools.get('edit'/'write')`. Rename/removal upstream is caught through
the `read` witness. Behavior per `driftMode` is in the README.

**Blind spots: the tripwire cannot see inside closures.**

- success phrasing (`formatEditOutput` / `formatWriteOutput`),
- validation and remedy texts,
- the escalation flow / policy plumbing,
- intent-waterfall and `fs/observed` participation,
- service-shape changes (`approval.request`, `sandboxPolicy.resolve`,
  `agent/created`, `tools.register`).

These fail **quietly** (see §4) and are only caught by the manual ritual
(§3) or by noticing behavior change. The test fixtures pin *our* copies,
not upstream's, so a green suite proves nothing about upstream drift.

## 3. The update ritual (after every DSH update)

1. `node test/plugin.test.mjs && node test/diff-parity.test.mjs`. The
   diff-parity suite re-oracles itself against the harness's own `diff`
   package, so an engine drift is caught here.
2. Restart the profile and **watch the boot row**: `approval-first` must
   come up active. Under `driftMode: 'fail'` a drifted plugin refuses to
   boot; that refusal IS the alarm working.
3. Quick manual smoke: fresh session, in-workspace edit (silent), an
   out-of-workspace `write` (card on first call), reject one (calm
   unchanged result).
4. When updating the checkout, skim the table in §1 for the files that
   changed upstream (`git diff` the tool-fs / sandbox / user-approval /
   core-tools paths between the old and new harness versions).

## 4. Failure-mode table: symptom, cause, action

| Symptom | Cause | Action |
| --- | --- | --- |
| Boot row `approval-first` failed, message names tool + path | tripwire: schema/description/output drift | Re-sync the named frozen piece from §1's table; update the fixture in `test/plugin.test.mjs`; bump version; re-run suites |
| Boot row failed, "renamed or removed upstream" | `edit`/`write` no longer exist (read witness present) | If renamed: follow the rename in `SHADOWED_TOOL_NAMES` + specs (or remove the bundle if one-turn escalation shipped natively) |
| stderr "drift detected … (disabled…)" after boot | late drift (HMR / late registration) under fail mode | same as the boot-row case |
| Every ask returns `approval unavailable; file unchanged` | `approval.request` signature/outcome vocabulary changed | re-read `user-approval/src/index.ts`, update `requestApprovalForMutation` + `APPROVAL_ALLOWED_ONCE` |
| Every call asks, even in-workspace | `sandboxPolicy.resolve` shape changed (mode key) | re-read `sandbox-policy/src/index.ts`, update `resolveStandingPolicyForCall` / `writableRootsOf` |
| Classic deny-retry behavior returned, no errors anywhere | `agent/created`/`agent.ctx` mechanism changed → shadows never register; OR the `session/event` firehose or the `'sandbox/mode'` event type changed → live arm/disarm stopped (registration still works at agent birth); OR drifted-and-disabled | re-read `core/agent` + `schedule/src/index.ts` + `sandbox-policy/src/session-mode.ts`; check boot row; grep stderr; switch modes in a live session to probe the listener |
| Writes behave subtly differently (intents/staleness/observed) | fs service contract changed | re-read `fs/src/index.ts` mutators, re-sync the execute paths |
| Diffs wrong in cards | `diff` engine/semantics changed upstream | the parity suite fails first; port the delta into the Myers engine or re-baseline |

## 5. Known acceptable states

- **Deployment without tool-fs** (no global edit/write, no `read`): the
  tripwire stays *pending* and the shadows serve as the only edit/write.
  That predates the tripwire and is unchanged; consider removing the bundle
  in such a deployment.
- **Another plugin's scoped edit/write shadow wins** for an agent: ours
  skips that agent (half-registration reversed, stderr note). Expected.
- **Probe/real target-key divergence** (v0.6.0 caveat, by design): the probe
  resolves its target with `sessionResolveOptions(exec, filePath)` while the
  shipped edit resolves with an extra `sandboxPolicy?.workspaceRoot`
  argument, so in exotic setups (symlinked roots) the derived `targetKey`
  can differ and the probe's answer can disagree with the real call's. Both
  directions degrade safely: wrongly doomed → skip → real gate returns a
  version → fence denies → the containment-miss fallback asks (a wasted
  cycle, then the normal card); wrongly observed → ask → allow → real gate
  throws (one wasted click, the status quo before this feature). No input
  combination mutates without a human decision. Documented, not engineered
  around.
- The declared `@deepseek-ai/cordis` dependency is inert (the bundle imports
  no npm packages, see guide 08 Case 24); it exists for convention. If the
  checkout path ever disappears on this machine, drop the dependency.
