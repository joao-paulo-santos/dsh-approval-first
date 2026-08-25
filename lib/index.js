/**
 * dsh-approval-first — host half.
 *
 * Interim shim that replaces the deny-then-retry escalation dance for the
 * `edit` and `write` tools with an APPROVAL-FIRST flow: one model turn, no
 * red sandbox-denial error, no model-authored justification. Where the
 * shipped tools under a confining sandbox run
 *
 *   call -> FS_SANDBOX_DENIED (red error) -> model re-sends the identical
 *   call with sandbox_permissions + justification -> approval -> write,
 *
 * the shadows registered by this plugin ask FIRST — but only when the
 * standing policy would deny the mutation anyway. The ask rule is uniform:
 * ask iff the resolved target is NOT writable under the standing policy
 * (the fence's own allow-list: the session workspace plus /tmp and the
 * platform temp dir under `workspace-write`; nothing under `read-only`;
 * everything under `danger-full-access`, where the shadow degrades to a
 * passthrough). So:
 *
 *   - `read-only` stance: every edit/write asks before mutating;
 *   - `workspace-write` stance: in-workspace (and /tmp) writes stay
 *     SILENT — identical to the shipped tools — and only out-of-workspace
 *     targets ask first (the case that today costs the red error + retry);
 *   - on `allowed-once` the mutation runs under a per-call
 *     { mode: 'workspace-write', workspaceRoot: <parent dir of the target> }
 *     grant — narrower than the classic retry, which for out-of-workspace
 *     targets needs danger-full-access;
 *   - every other outcome (rejected / cancelled / unavailable) returns a
 *     NORMAL, non-error result ("<tool> rejected by the user; file
 *     unchanged" &c). A user decision never throws.
 *
 * If a silent (judged in-policy) attempt is still refused by the fence —
 * an alias/casing containment miss — the refusal converts into the ask
 * instead of erroring into the deny-retry loop this plugin exists to
 * remove.
 *
 * Drift tripwire (see maintenance.md): because the shadows are frozen
 * copies, activation compares them against the LIVE global definitions
 * (`ctx.tools.get`, no scope) — description, parameters (order-sensitive),
 * and output schema modulo the documented deltas. Under driftMode 'fail'
 * (the default) boot-time drift throws (loud row failure) and later drift
 * self-disables (every agent falls back to the shipped tools); 'warn'
 * logs and keeps serving. Rename/removal upstream is caught through the
 * `read` witness; absence of the whole fs tool family stays pending and
 * re-checks on every tools/change.
 *
 * NOT a new sandbox mode. The harness owns the modes
 * (read-only / workspace-write / danger-full-access); this plugin only
 * shadows two tool calls under a configurable standing mode. Deletion
 * condition: the day the platform grows one-turn escalation as a
 * first-class status, this bundle is obsolete — remove it.
 *
 * Registration mechanism (per-agent, the sanctioned interception seam):
 * a tool registered through an agent's OWN context (`agent.ctx.tools`,
 * `packages/core/tools/src/index.ts` — "Scoped tools shadow globals") wins
 * over the same-name global registration for that agent only, while a
 * same-name GLOBAL registration would collide and throw. Every agent gets
 * its shadows at `agent/created` (plus a one-time sweep of already-live
 * agents at plugin activation) and loses them when it is disposed (the
 * registrations are effects on the agent's scoped fiber) or when this
 * plugin unloads. Pattern copied from `packages/schedule/schedule/src/index.ts`.
 *
 * Registration is LIVE, not a birth snapshot: every standing-mode switch
 * is a durable `'sandbox/mode'` session event
 * (`sandbox-policy/src/session-mode.ts`), and this plugin re-evaluates
 * each affected agent's registration on commit through the `session/event`
 * firehose — switching the mode mid-session arms or disarms the shadows
 * in place.
 *
 * Standing-mode source: `ctx.sandboxPolicy.resolve({ session })`
 * (`packages/sandbox/sandbox-policy/src/index.ts`) — the session's last
 * `sandbox/mode` override, else the deployment default. That resolved mode
 * is exactly what the runtime-context snapshot states as the file policy.
 *
 * Behavioral identity: the shadows copy the shipped tools' code paths
 * (`packages/fs/tool-fs/src/edit.ts` / `write.ts` / `sandbox.ts` /
 * `session-cwd.ts` / `diff.ts` / `error.ts`) verbatim — parameter and output
 * schemas, argument validation texts, escalation-arg pairing checks,
 * fs/write-intent / fs/edit-intent waterfall participation, fs/observed
 * recording, success phrasing, and guarded-mutation error remediation —
 * inserting only the approval step and swapping the per-call policy. The
 * model must not detect the difference except by the absence of denials.
 * Known deliberate divergences (both model-invisible or user-decision-only,
 * see README): the output schema carries an optional `unchangedReason`
 * field so a non-allowed outcome can render as a normal result, and valid
 * escalation args are accepted-but-ignored (the approval-first ask already
 * covers them with a narrower grant).
 *
 * Zero runtime imports beyond node builtins: the profile installs this
 * bundle as a `link:` dependency, and module resolution from the symlink
 * target cannot see the profile's node_modules — so this file must be
 * self-contained. `static Config` is therefore a hand-rolled Standard
 * Schema V1 validator (the same interface `@deepseek-ai/schemastery`
 * objects expose to the cordis loader) instead of a schemastery object.
 */

import { realpathSync } from 'node:fs'
import { stat as statPath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, sep } from 'node:path'

export const name = 'approval-first'

/** Hard dependencies: the fiber waits until every one is provided. */
export const inject = ['approval', 'fs', 'agents', 'sandboxPolicy', 'tools']

// ---------------------------------------------------------------------------
// Config (Standard Schema V1, hand-rolled — see header note)
// ---------------------------------------------------------------------------

/** The closed sandbox-mode vocabulary (`packages/fs/fs-sandbox/src`). */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * Default `activeModes`: every confining stance. `danger-full-access` (where
 * nothing asks anyway) stays inactive, so the plugin is on in any session
 * without full access and a plain install needs no configuration.
 */
const DEFAULT_ACTIVE_MODES = ['read-only', 'workspace-write']

/** Every accepted `driftMode`. */
const DRIFT_MODES = ['fail', 'warn']

/**
 * Plugin config: `activeModes` — the standing sandbox modes under which the
 * shadows activate (under any other standing mode this plugin registers
 * NOTHING and the shipped tools serve unchanged) — and `driftMode` — what
 * happens when the shipped global `edit`/`write` definitions no longer
 * match the frozen copies (`'fail'` refuses to activate at boot and
 * self-disables if drift appears later; `'warn'` logs and keeps serving
 * the frozen shadows).
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-approval-first',
    validate(config) {
      if (config === undefined || config === null) {
        return { value: { activeModes: [...DEFAULT_ACTIVE_MODES], driftMode: 'fail' } }
      }
      if (typeof config !== 'object' || Array.isArray(config)) {
        return { issues: [{ message: 'expected a config object', path: [] }] }
      }
      const issues = []
      const resolved = {}
      const requestedModes = config.activeModes
      if (requestedModes === undefined) {
        resolved.activeModes = [...DEFAULT_ACTIVE_MODES]
      } else if (!Array.isArray(requestedModes)) {
        issues.push({ message: 'expected an array of sandbox mode strings', path: ['activeModes'] })
      } else {
        for (const requestedMode of requestedModes) {
          if (!SANDBOX_MODES.includes(requestedMode)) {
            issues.push({
              message: 'unknown sandbox mode ' + JSON.stringify(requestedMode)
                + ' (known: ' + SANDBOX_MODES.join(', ') + ')',
              path: ['activeModes'],
            })
          }
        }
        resolved.activeModes = [...requestedModes]
      }
      const requestedDriftMode = config.driftMode
      if (requestedDriftMode === undefined) {
        resolved.driftMode = 'fail'
      } else if (!DRIFT_MODES.includes(requestedDriftMode)) {
        issues.push({
          message: 'unknown driftMode ' + JSON.stringify(requestedDriftMode)
            + ' (known: ' + DRIFT_MODES.join(', ') + ')',
          path: ['driftMode'],
        })
      } else {
        resolved.driftMode = requestedDriftMode
      }
      if (issues.length > 0) return { issues }
      return { value: resolved }
    },
  },
}

// ---------------------------------------------------------------------------
// Vocabulary copied from the harness (verbatim — model-visible texts)
// ---------------------------------------------------------------------------

/** `ApprovalService` outcomes (`packages/interaction/user-approval/src/index.ts`). */
const APPROVAL_ALLOWED_ONCE = 'allowed-once'

/** Every escalation target a confining composition may advertise (`dsh-sandbox`). */
const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']

/** `[sandbox: …]` denial marker, exactly as the model sees it (`dsh-sandbox`). */
const sandboxDenialMarker = (mode) => '[sandbox: file access denied under ' + mode + ' mode]'

/** The same-turn escalation hint for a filesystem mutation, verbatim. */
const ESCALATION_HINT_FOR_OPERATION = '[sandbox: escalation available — retry this exact operation once '
  + 'with sandbox_permissions (the narrowest wider mode that suffices) + justification; '
  + 'the approval prompt asks the user]'

/** Remedies appended to guarded-mutation failures (`tool-fs/src/error.ts`). */
const GUARDED_MUTATION_REMEDIES = {
  FS_STALE_VERSION: 're-read the file, then retry',
  FS_NOT_OBSERVED: 'read the file, then retry',
}

/** Result phrasings for the non-allowed outcomes (normal results, never errors). */
const UNCHANGED_RESULT_PHRASES = {
  rejected: (toolName) => toolName + ' rejected by the user; file unchanged',
  cancelled: (toolName) => toolName + ' cancelled; file unchanged',
  unavailable: () => 'approval unavailable; file unchanged',
}

// ---------------------------------------------------------------------------
// Parameter schemas — the same DSL the shipped tools feed to defineTool,
// compiled here with the same projection rules
// (`dsh-tools/src/schema.ts`: parameterSchemaSpecToJsonSchema)
// ---------------------------------------------------------------------------

/** Convert a per-property spec map into the model-visible JSON Schema. */
function parameterSchemaFrom(specs) {
  const properties = {}
  const required = []
  for (const [parameterName, spec] of Object.entries(specs)) {
    const schemaNode = { type: spec.type }
    if (Object.hasOwn(spec, 'description')) schemaNode.description = spec.description
    if (Object.hasOwn(spec, 'enum')) schemaNode.enum = [...spec.enum]
    properties[parameterName] = schemaNode
    if (spec.required === true) required.push(parameterName)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** The two escalation fields, spread into a spec map under a confining backend. */
function escalationParameterSpecs() {
  return {
    sandbox_permissions: {
      type: 'string',
      enum: [...ESCALATION_TARGETS],
      description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry '
        + 'of an operation the sandbox just denied; requires justification and user approval.',
    },
    justification: {
      type: 'string',
      description: 'Required with sandbox_permissions: one sentence for the user explaining '
        + 'why this exact file operation needs the wider access.',
    },
  }
}

const EDIT_PARAMETER_SPECS = {
  file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
  old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
  new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
  replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
}

const WRITE_PARAMETER_SPECS = {
  file_path: { type: 'string', required: true, description: 'Path to write, resolved by the filesystem backend.' },
  content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
}

/**
 * Validate tool arguments against a spec map with the same violation texts
 * and ordering as `validateJsonSchemaValue` on the compiled schema
 * (required-missing in `required` order, then per-property type/enum issues
 * in declaration order).
 * @returns the violations array; empty means valid.
 */
function argumentViolationsFrom(specs, args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return ['"arguments" must be an object']
  }
  const violations = []
  for (const [parameterName, spec] of Object.entries(specs)) {
    if (spec.required === true && args[parameterName] === undefined) {
      violations.push('missing required property "' + parameterName + '"')
    }
  }
  for (const [parameterName, spec] of Object.entries(specs)) {
    const value = args[parameterName]
    if (value === undefined) continue
    if (typeof value !== spec.type) {
      violations.push('"' + parameterName + '" must be a ' + spec.type)
      continue
    }
    if (spec.enum !== undefined && !spec.enum.includes(value)) {
      violations.push('"' + parameterName + '" must be one of ' + JSON.stringify(spec.enum))
    }
  }
  return violations
}

/**
 * Throw the `ToolArgsError`-shaped failure defineTool produces for invalid
 * arguments (`name`/`code` mirror the harness class; message verbatim).
 */
function assertValidToolArguments(specs, args) {
  const violations = argumentViolationsFrom(specs, args)
  if (violations.length === 0) return
  const toolArgumentsError = new Error('invalid arguments: ' + violations.join('; '))
  toolArgumentsError.name = 'ToolArgsError'
  toolArgumentsError.code = 'INVALID_ARGS'
  throw toolArgumentsError
}

/**
 * The escalation argument pairing a schema cannot express, verbatim from
 * `dsh-sandbox/escalation.ts` `validateEscalationArgs`.
 */
function assertValidEscalationArguments(sandboxPermissions, justification) {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

// ---------------------------------------------------------------------------
// Argument parsing and result phrasing (verbatim from tool-fs edit.ts/write.ts)
// ---------------------------------------------------------------------------

/** `edit` arguments after defaulting (`parseEditArgs`). */
function parseEditArguments(args) {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
  return {
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
  }
}

/** `write` arguments (`parseWriteArgs`). */
function parseWriteArguments(args) {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  return { filePath: args.file_path, content: args.content }
}

/** `formatEditOutput` — the shipped success phrasing. */
function formatEditOutput(displayPath, replaceAll) {
  return replaceAll
    ? 'The file ' + displayPath + ' has been updated. All occurrences were successfully replaced.'
    : 'The file ' + displayPath + ' has been updated successfully.'
}

/** `formatWriteOutput` — the shipped success envelope. */
function formatWriteOutput(displayPath, outcome) {
  const verb = outcome.operation === 'create' ? 'Created' : 'Updated'
  return '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' + verb + ' file\n</content>'
}

// ---------------------------------------------------------------------------
// Path helpers (verbatim semantics from tool-fs session-cwd.ts)
// ---------------------------------------------------------------------------

/** Resolve filesystem identity before lexical normalization erases it (`dsh-sandbox/roots.ts`). */
function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * The roots a confined execution may WRITE under — the mode's meaning as a
 * canonical allow-list, ported verbatim from `dsh-sandbox/roots.ts`
 * `writableRoots`: `workspace-write` allows the policy's workspace root, the
 * host `/tmp`, and `os.tmpdir()`; every other mode allows nothing (this
 * helper is only consulted for the ask/silent decision, and `read-only`
 * allowing nothing is exactly "every mutation asks").
 */
function writableRootsOf(policy) {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
}

const MISSING_STAT_CODES = new Set(['ENOENT', 'ENOTDIR'])

async function statIfPresent(path) {
  try {
    return await statPath(path, { bigint: true })
  } catch (error) {
    if (MISSING_STAT_CODES.has(error !== null && typeof error === 'object' ? error.code : undefined)) {
      return undefined
    }
    throw error
  }
}

const sameStatIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino

function isLexicallyUnder(path, root, caseSensitive) {
  const comparableTarget = caseSensitive ? path : path.toLowerCase()
  const comparableRoot = caseSensitive ? root : root.toLowerCase()
  if (comparableTarget === comparableRoot) return true
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep
  return comparableTarget.startsWith(prefix)
}

/**
 * Whether a canonical target is a writable root or lies beneath it — ported
 * verbatim from `dsh-fs-sandbox/src/containment.ts` `isPathUnder`: the
 * lexical fast path, then filesystem-identity comparison against the root
 * for alias-equivalent spellings (casing, 8.3 names).
 */
async function isPathUnder(path, root) {
  const caseSensitive = process.platform !== 'win32'
  if (isLexicallyUnder(path, root, caseSensitive)) return true
  const rootInfo = await statIfPresent(root)
  if (rootInfo === undefined) return false
  let ancestor = path
  for (;;) {
    const ancestorInfo = await statIfPresent(ancestor)
    if (ancestorInfo !== undefined && sameStatIdentity(ancestorInfo, rootInfo)) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}

const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

/** The calling agent's session cwd, or undefined for a non-agent caller. */
function sessionCwd(exec, requestedPath) {
  const cwd = exec.agent?.session?.header?.cwd
  if (cwd === undefined || (!PARENT_PATH_SEGMENT.test(cwd) && !PARENT_PATH_SEGMENT.test(requestedPath))) {
    return cwd
  }
  return canonicalPath(cwd)
}

/** Provider resolution options for the current tool call. */
function sessionResolveOptions(exec, requestedPath) {
  const cwd = sessionCwd(exec, requestedPath)
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  }
}

// ---------------------------------------------------------------------------
// Error mapping (duck-typed on `code`; verbatim texts from tool-fs)
// ---------------------------------------------------------------------------

/** `remediateFsError`: append the guarded-mutation remedy, keep the code. */
function remediateGuardedMutationError(error) {
  const remedy = error !== null && typeof error === 'object'
    ? GUARDED_MUTATION_REMEDIES[error.code]
    : undefined
  if (remedy === undefined) return error
  const remediated = new Error(error.message + ' — ' + remedy)
  remediated.name = typeof error.name === 'string' ? error.name : 'FsError'
  remediated.code = error.code
  return remediated
}

/** `FsSandboxController.mapError`: the denial marker + escalation hint. */
function mapSandboxDenialError(error, policyMode) {
  const isSandboxDenial = error !== null && typeof error === 'object' && error.code === 'FS_SANDBOX_DENIED'
  if (!isSandboxDenial) return error
  const denial = new Error(sandboxDenialMarker(policyMode) + '\n' + ESCALATION_HINT_FOR_OPERATION)
  denial.name = 'FsError'
  denial.code = 'FS_SANDBOX_DENIED'
  return denial
}

// ---------------------------------------------------------------------------
// Contextual diff presentation (parity with `diff`'s structuredPatch,
// context 3 — the presentation basis of tool-fs/src/diff.ts)
// ---------------------------------------------------------------------------

/** Context lines shown on each side of an applied hunk (`DIFF_CONTEXT`). */
const DIFF_CONTEXT = 3

/** One diff token: a line plus whether it is newline-terminated. */
function splitIntoLineTokens(text) {
  if (text === '') return []
  const parts = text.split('\n')
  const terminated = text.endsWith('\n')
  const lines = terminated ? parts.slice(0, -1) : parts
  return lines.map((line, index) => ({
    text: line,
    terminated: index < lines.length - 1 || terminated,
  }))
}

const sameLineToken = (left, right) => left.text === right.text && left.terminated === right.terminated

/**
 * Myers O(ND) diff over line tokens, reduced to an operation list
 * ('=' shared, '-' removed, '+' added). Common prefix/suffix are trimmed
 * first so the quadratic-trace core stays tiny for ordinary edits.
 */
function lineDiffOperations(beforeTokens, afterTokens) {
  let prefixLength = 0
  const maxLength = Math.min(beforeTokens.length, afterTokens.length)
  while (prefixLength < maxLength && sameLineToken(beforeTokens[prefixLength], afterTokens[prefixLength])) {
    prefixLength += 1
  }
  let suffixLength = 0
  while (
    suffixLength < maxLength - prefixLength
    && sameLineToken(beforeTokens[beforeTokens.length - 1 - suffixLength], afterTokens[afterTokens.length - 1 - suffixLength])
  ) {
    suffixLength += 1
  }
  const coreBefore = beforeTokens.slice(prefixLength, beforeTokens.length - suffixLength)
  const coreAfter = afterTokens.slice(prefixLength, afterTokens.length - suffixLength)
  const operations = []
  for (let index = 0; index < prefixLength; index += 1) {
    operations.push({ operation: '=', token: beforeTokens[index] })
  }
  operations.push(...myersCoreOperations(coreBefore, coreAfter))
  for (let index = 0; index < suffixLength; index += 1) {
    operations.push({ operation: '=', token: beforeTokens[beforeTokens.length - suffixLength + index] })
  }
  return operations
}

/**
 * The Myers greedy shortest-edit-script backtrack over the token cores.
 * Cores beyond a generous size fall back to one whole-core replacement
 * (presentation-only containment; ordinary edits never reach it).
 */
const DIFF_CORE_LINE_LIMIT = 20000

function myersCoreOperations(coreBefore, coreAfter) {
  if (coreBefore.length === 0 && coreAfter.length === 0) return []
  if (coreBefore.length === 0) {
    return coreAfter.map((token) => ({ operation: '+', token }))
  }
  if (coreAfter.length === 0) {
    return coreBefore.map((token) => ({ operation: '-', token }))
  }
  if (coreBefore.length > DIFF_CORE_LINE_LIMIT || coreAfter.length > DIFF_CORE_LINE_LIMIT) {
    return [
      ...coreBefore.map((token) => ({ operation: '-', token })),
      ...coreAfter.map((token) => ({ operation: '+', token })),
    ]
  }
  const beforeLength = coreBefore.length
  const afterLength = coreAfter.length
  const offset = beforeLength + afterLength
  const frontier = new Int32Array(2 * offset + 1)
  const trace = []
  let reachedDepth = -1
  search: for (let depth = 0; depth <= offset; depth += 1) {
    trace.push(frontier.slice())
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      let xCoordinate
      if (
        diagonal === -depth
        || (diagonal !== depth && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1])
      ) {
        xCoordinate = frontier[offset + diagonal + 1]
      } else {
        xCoordinate = frontier[offset + diagonal - 1] + 1
      }
      let yCoordinate = xCoordinate - diagonal
      while (
        xCoordinate < beforeLength && yCoordinate < afterLength
        && sameLineToken(coreBefore[xCoordinate], coreAfter[yCoordinate])
      ) {
        xCoordinate += 1
        yCoordinate += 1
      }
      frontier[offset + diagonal] = xCoordinate
      if (xCoordinate >= beforeLength && yCoordinate >= afterLength) {
        reachedDepth = depth
        break search
      }
    }
  }
  if (reachedDepth < 0) {
    // Unreachable for finite inputs; the containment fallback keeps it total.
    return [
      ...coreBefore.map((token) => ({ operation: '-', token })),
      ...coreAfter.map((token) => ({ operation: '+', token })),
    ]
  }
  const operations = []
  let xCoordinate = beforeLength
  let yCoordinate = afterLength
  for (let depth = reachedDepth; depth > 0; depth -= 1) {
    const previousFrontier = trace[depth]
    const diagonal = xCoordinate - yCoordinate
    let previousDiagonal
    if (
      diagonal === -depth
      || (diagonal !== depth
        && previousFrontier[offset + diagonal - 1] < previousFrontier[offset + diagonal + 1])
    ) {
      previousDiagonal = diagonal + 1
    } else {
      previousDiagonal = diagonal - 1
    }
    const previousX = previousFrontier[offset + previousDiagonal]
    const previousY = previousX - previousDiagonal
    while (xCoordinate > previousX && yCoordinate > previousY) {
      xCoordinate -= 1
      yCoordinate -= 1
      operations.push({ operation: '=', token: coreBefore[xCoordinate] })
    }
    if (previousDiagonal === diagonal + 1) {
      yCoordinate -= 1
      operations.push({ operation: '+', token: coreAfter[yCoordinate] })
    } else {
      xCoordinate -= 1
      operations.push({ operation: '-', token: coreBefore[xCoordinate] })
    }
  }
  while (xCoordinate > 0 && yCoordinate > 0) {
    xCoordinate -= 1
    yCoordinate -= 1
    operations.push({ operation: '=', token: coreBefore[xCoordinate] })
  }
  while (xCoordinate > 0) {
    xCoordinate -= 1
    operations.push({ operation: '-', token: coreBefore[xCoordinate] })
  }
  while (yCoordinate > 0) {
    yCoordinate -= 1
    operations.push({ operation: '+', token: coreAfter[yCoordinate] })
  }
  operations.reverse()
  return operations
}

/** One hunk: the change operations plus bounded leading/trailing context. */
function groupChangeRunsIntoHunks(operations, contextLineCount) {
  const changeRuns = []
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    if (operations[operationIndex].operation === '=') continue
    const lastRun = changeRuns[changeRuns.length - 1]
    if (lastRun !== undefined && lastRun.lastOperationIndex === operationIndex - 1) {
      lastRun.lastOperationIndex = operationIndex
    } else {
      changeRuns.push({ firstOperationIndex: operationIndex, lastOperationIndex: operationIndex })
    }
  }
  const groups = []
  for (const changeRun of changeRuns) {
    const previousGroup = groups[groups.length - 1]
    if (
      previousGroup !== undefined
      && changeRun.firstOperationIndex - previousGroup.lastOperationIndex - 1 <= 2 * contextLineCount
    ) {
      previousGroup.lastOperationIndex = changeRun.lastOperationIndex
    } else {
      groups.push({ firstOperationIndex: changeRun.firstOperationIndex, lastOperationIndex: changeRun.lastOperationIndex })
    }
  }
  return groups.map((group) => ({
    leadingContextOperations: operations.slice(
      Math.max(0, group.firstOperationIndex - contextLineCount),
      group.firstOperationIndex,
    ),
    changedOperations: operations.slice(group.firstOperationIndex, group.lastOperationIndex + 1),
    trailingContextOperations: operations.slice(
      group.lastOperationIndex + 1,
      group.lastOperationIndex + 1 + contextLineCount,
    ),
  }))
}

/**
 * One FileDiff per applied hunk between `before` and `after`, each carrying
 * the applied change plus `DIFF_CONTEXT` context lines — the same projection
 * as `computeHunkDiffs` over `structuredPatch(..., { context: 3 })`.
 */
function computeHunkDiffs(path, before, after) {
  if (before === after) return []
  const operations = lineDiffOperations(splitIntoLineTokens(before), splitIntoLineTokens(after))
  const diffs = []
  for (const hunk of groupChangeRunsIntoHunks(operations, DIFF_CONTEXT)) {
    const oldLines = []
    const newLines = []
    for (const diffOperation of [
      ...hunk.leadingContextOperations,
      ...hunk.changedOperations,
      ...hunk.trailingContextOperations,
    ]) {
      if (diffOperation.operation === '-') {
        oldLines.push(diffOperation.token.text)
      } else if (diffOperation.operation === '+') {
        newLines.push(diffOperation.token.text)
      } else {
        oldLines.push(diffOperation.token.text)
        newLines.push(diffOperation.token.text)
      }
    }
    diffs.push({
      path,
      oldText: oldLines.length > 0 ? oldLines.join('\n') : null,
      newText: newLines.join('\n'),
    })
  }
  return diffs
}

/** `isFileDiff` — defensive narrowing from opaque result metadata. */
function isFileDiff(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
}

/** `diffsFromMeta` — narrow replayed metadata to non-empty file diffs. */
function diffsFromMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = meta.diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}

// ---------------------------------------------------------------------------
// Shadow tool definitions
// ---------------------------------------------------------------------------

/** Render the normal-result text for a value that may carry `unchangedReason`. */
function renderEditableResultText(toolName, value, formatUpdatedOutput, args) {
  if (value.unchangedReason === undefined) {
    return formatUpdatedOutput(value, args)
  }
  const phraseFor = UNCHANGED_RESULT_PHRASES[value.unchangedReason]
  return (phraseFor ?? UNCHANGED_RESULT_PHRASES.unavailable)(toolName)
}

/** Every non-grant outcome the unchanged value may name (fail-closed). */
const UNCHANGED_REASONS = ['rejected', 'cancelled', 'unavailable']

/** The unchanged (non-allowed outcome) result value for a resolved target. */
function unchangedResultValue(valueFields, outcome) {
  return {
    ...valueFields,
    unchangedReason: UNCHANGED_REASONS.includes(outcome) ? outcome : 'unavailable',
  }
}

/**
 * The ask/silent decision, uniform across modes: ask iff the resolved target
 * is NOT writable under the standing policy. `read-only` (or an unreadable
 * policy) has no writable roots, so every mutation asks; `workspace-write`
 * asks only for targets outside the fence's own allow-list, so in-workspace
 * writes keep today's silent behavior; `danger-full-access` permits
 * everything, so the shadow degrades to a passthrough of the shipped tool.
 */
async function mutationRequiresApproval(target, standingPolicy) {
  if (standingPolicy === undefined) return true
  if (standingPolicy.mode === 'danger-full-access') return false
  const roots = writableRootsOf(standingPolicy)
  if (roots.length === 0) return true
  const canonicalTargetPath = canonicalPath(target.displayPath)
  for (const writableRoot of roots) {
    if (await isPathUnder(canonicalTargetPath, writableRoot)) return false
  }
  return true
}

/** The standing per-call policy exactly as the shipped tool resolves it. */
function resolveStandingPolicyForCall(context, exec) {
  try {
    const policyRequest = exec.agent !== undefined ? { session: exec.agent.session } : {}
    const policy = context.sandboxPolicy.resolve(policyRequest)
    return policy !== undefined && typeof policy.mode === 'string' ? policy : undefined
  } catch (error) {
    console.error('approval-first: sandboxPolicy.resolve failed at call time', error)
    return undefined
  }
}

/** Whether a thrown value is a `FS_SANDBOX_DENIED` from the fence. */
function isSandboxDenialError(error) {
  return error !== null && typeof error === 'object' && error.code === 'FS_SANDBOX_DENIED'
}

/**
 * Put the approval question (the only ask in this plugin). The reason names
 * the tool and basename, and under a `workspace-write` stance appends the
 * outside-workspace note so the card explains WHY it is asking. A throwing
 * approval seam fails CLOSED with the normal unavailable phrasing — a red
 * error here would recreate exactly the noise this plugin exists to remove.
 */
async function requestApprovalForMutation(context, toolName, target, exec, standingPolicy) {
  if (exec.agent === undefined) {
    return { grant: false, outcome: 'unavailable' }
  }
  const outsideWorkspaceNote = standingPolicy !== undefined && standingPolicy.mode === 'workspace-write'
    ? ' — outside the writable workspace'
    : ''
  const requestArguments = {
    agent: exec.agent,
    toolName,
    ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
    reason: toolName + ' ' + basename(target.displayPath) + outsideWorkspaceNote,
    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
  }
  let outcome
  try {
    outcome = await context.approval.request(requestArguments)
  } catch (error) {
    console.error('approval-first: approval.request threw for ' + toolName, error)
    outcome = 'unavailable'
  }
  return { grant: outcome === APPROVAL_ALLOWED_ONCE, outcome }
}

/**
 * Plan one mutation: resolve the target first (exactly as the shipped tool
 * resolves it), then either the silent path (mutation under the standing
 * policy — identical to the shipped tool for in-policy targets) or the ask
 * path (BEFORE any mutation; an allowed ask mutates under the narrow
 * parent-directory grant).
 */
async function planMutation(context, toolName, filePath, exec) {
  const target = await context.fs.resolve(filePath, sessionResolveOptions(exec, filePath))
  const standingPolicy = resolveStandingPolicyForCall(context, exec)
  if (!await mutationRequiresApproval(target, standingPolicy)) {
    return {
      target,
      standingPolicy,
      approvalRequired: false,
      grant: undefined,
      outcome: undefined,
      mutationPolicy: standingPolicy,
    }
  }
  const decision = await requestApprovalForMutation(context, toolName, target, exec, standingPolicy)
  return {
    target,
    standingPolicy,
    approvalRequired: true,
    grant: decision.grant,
    outcome: decision.outcome,
    mutationPolicy: decision.grant
      ? perCallMutationPolicy(context, target)
      : undefined,
  }
}

/** The per-call mutation policy: workspace-write scoped to the target's parent directory. */
function perCallMutationPolicy(context, target) {
  return { mode: 'workspace-write', workspaceRoot: dirname(context.fs.processPath(target)) }
}

/** Build the `edit` shadow definition closing over the plugin context. */
function createEditShadowTool(context, advertiseEscalationFields) {
  const parameterSpecs = {
    ...EDIT_PARAMETER_SPECS,
    ...(advertiseEscalationFields ? escalationParameterSpecs() : {}),
  }
  return {
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: parameterSchemaFrom(parameterSpecs),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          before: { type: 'string' },
          after: { type: 'string' },
          unchangedReason: { type: 'string', enum: ['rejected', 'cancelled', 'unavailable'] },
        },
        required: ['path', 'before', 'after'],
      },
      render: (args, value) => [{
        type: 'text',
        text: renderEditableResultText('edit', value, (resolvedValue) =>
          formatEditOutput(resolvedValue.path, args.replace_all ?? false), args),
      }],
      presentationMeta: (args, value) => ({
        diffs: value.unchangedReason === undefined
          ? computeHunkDiffs(args.file_path, value.before, value.after)
            .map(({ path, oldText, newText }) => ({ path, oldText, newText }))
          : [],
        ...(value.unchangedReason !== undefined ? { unchanged: true } : {}),
      }),
    },
    async execute(args, exec) {
      assertValidToolArguments(parameterSpecs, args)
      const input = parseEditArguments(args)
      assertValidEscalationArguments(args.sandbox_permissions, args.justification)
      const plan = await planMutation(context, 'edit', input.filePath, exec)
      if (plan.approvalRequired && !plan.grant) {
        return unchangedResultValue({ path: plan.target.displayPath, before: '', after: '' }, plan.outcome)
      }
      const performEditWith = async (mutationPolicy) => {
        // Single-slot decision + guarded mutation, copied from the shipped
        // execute: the intent waterfall sits INSIDE the try (its FS_NOT_OBSERVED
        // refusal gets the remedy too).
        const intent = await context.waterfall('fs/edit-intent', plan.target, exec, () => undefined)
        return context.fs.editText(
          plan.target,
          { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
          intent,
          exec.signal,
          mutationPolicy,
        )
      }
      let mutationOutcome
      try {
        mutationOutcome = await performEditWith(plan.mutationPolicy)
      } catch (mutationError) {
        // A silent (judged in-policy) attempt the fence still refused means
        // the containment judgment missed (alias/casing): ask NOW instead of
        // erroring into the deny-retry loop this plugin exists to remove.
        if (!plan.approvalRequired && isSandboxDenialError(mutationError)) {
          const fallback = await requestApprovalForMutation(context, 'edit', plan.target, exec, plan.standingPolicy)
          if (!fallback.grant) {
            return unchangedResultValue({ path: plan.target.displayPath, before: '', after: '' }, fallback.outcome)
          }
          try {
            mutationOutcome = await performEditWith(perCallMutationPolicy(context, plan.target))
          } catch (retryError) {
            throw remediateGuardedMutationError(mapSandboxDenialError(retryError, 'workspace-write'))
          }
        } else {
          throw remediateGuardedMutationError(mapSandboxDenialError(mutationError, plan.mutationPolicy.mode))
        }
      }
      context.emit('fs/observed', plan.target, { kind: 'present', version: mutationOutcome.version }, exec)
      return {
        path: plan.target.displayPath,
        before: mutationOutcome.before,
        after: mutationOutcome.after,
      }
    },
    presentCall(args) {
      if (
        typeof args !== 'object' || args === null
        || typeof args.file_path !== 'string'
        || typeof args.old_string !== 'string'
        || typeof args.new_string !== 'string'
      ) return undefined
      return {
        card: 'diff',
        title: 'Edit ' + args.file_path,
        diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }],
        locations: [{ path: args.file_path }],
      }
    },
    presentResult(args, result) {
      if (typeof args !== 'object' || args === null || typeof args.file_path !== 'string') return undefined
      if (result.isError) return undefined
      const meta = result.meta
      if (meta !== undefined && meta !== null && typeof meta === 'object' && meta.unchanged === true) {
        return undefined
      }
      const diffs = diffsFromMeta(meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: 'Edit ' + args.file_path, diffs }
    },
  }
}

/** Build the `write` shadow definition closing over the plugin context. */
function createWriteShadowTool(context, advertiseEscalationFields) {
  const parameterSpecs = {
    ...WRITE_PARAMETER_SPECS,
    ...(advertiseEscalationFields ? escalationParameterSpecs() : {}),
  }
  return {
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file.',
    parameters: parameterSchemaFrom(parameterSpecs),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'update'] },
          before: {
            oneOf: [
              { type: 'string' },
              { type: 'null' },
            ],
          },
          after: { type: 'string' },
          unchangedReason: { type: 'string', enum: ['rejected', 'cancelled', 'unavailable'] },
        },
        required: ['path', 'before', 'after'],
      },
      render: (args, value) => [{
        type: 'text',
        text: renderEditableResultText('write', value, (resolvedValue) =>
          formatWriteOutput(resolvedValue.path, resolvedValue), args),
      }],
      presentationMeta: (args, value) => ({
        diffs: value.unchangedReason === undefined
          ? (value.before === null
            ? []
            : computeHunkDiffs(args.file_path, value.before, value.after)
              .map(({ path, oldText, newText }) => ({ path, oldText, newText })))
          : [],
        ...(value.unchangedReason !== undefined ? { unchanged: true } : {}),
      }),
    },
    async execute(args, exec) {
      assertValidToolArguments(parameterSpecs, args)
      const input = parseWriteArguments(args)
      assertValidEscalationArguments(args.sandbox_permissions, args.justification)
      const plan = await planMutation(context, 'write', input.filePath, exec)
      if (plan.approvalRequired && !plan.grant) {
        return unchangedResultValue({ path: plan.target.displayPath, before: null, after: '' }, plan.outcome)
      }
      // Copied from the shipped execute: the intent waterfall sits OUTSIDE
      // the try here — only the guarded mutation is remapped.
      const intent = await context.waterfall('fs/write-intent', plan.target, exec, () => undefined)
      const performWriteWith = (mutationPolicy) => context.fs.writeText(
        plan.target,
        input.content,
        intent,
        exec.signal,
        mutationPolicy,
      )
      let mutationOutcome
      try {
        mutationOutcome = await performWriteWith(plan.mutationPolicy)
      } catch (mutationError) {
        // Containment-miss fallback, as in the edit shadow: a silent attempt
        // the fence refused converts into the ask instead of the deny-retry
        // loop.
        if (!plan.approvalRequired && isSandboxDenialError(mutationError)) {
          const fallback = await requestApprovalForMutation(context, 'write', plan.target, exec, plan.standingPolicy)
          if (!fallback.grant) {
            return unchangedResultValue({ path: plan.target.displayPath, before: null, after: '' }, fallback.outcome)
          }
          try {
            mutationOutcome = await performWriteWith(perCallMutationPolicy(context, plan.target))
          } catch (retryError) {
            throw remediateGuardedMutationError(mapSandboxDenialError(retryError, 'workspace-write'))
          }
        } else {
          throw remediateGuardedMutationError(mapSandboxDenialError(mutationError, plan.mutationPolicy.mode))
        }
      }
      context.emit('fs/observed', plan.target, { kind: 'present', version: mutationOutcome.version }, exec)
      return {
        path: plan.target.displayPath,
        operation: mutationOutcome.operation,
        before: mutationOutcome.before,
        after: mutationOutcome.after,
      }
    },
    presentCall(args) {
      if (typeof args !== 'object' || args === null || typeof args.file_path !== 'string') return undefined
      return {
        card: 'diff',
        title: 'Write ' + args.file_path,
        diffs: [{ path: args.file_path, oldText: null, newText: args.content }],
        locations: [{ path: args.file_path }],
      }
    },
    presentResult(args, result) {
      if (
        typeof args !== 'object' || args === null || typeof args.file_path !== 'string'
        || typeof args.content !== 'string'
      ) return undefined
      if (result.isError) return undefined
      const meta = result.meta
      if (meta !== undefined && meta !== null && typeof meta === 'object' && meta.unchanged === true) {
        return undefined
      }
      const diffs = diffsFromMeta(meta)
        ?? [{ path: args.file_path, oldText: null, newText: args.content }]
      return { card: 'diff', title: 'Write ' + args.file_path, diffs }
    },
  }
}

// ---------------------------------------------------------------------------
// Drift tripwire: the frozen shadows must mirror the LIVE global tools
// ---------------------------------------------------------------------------

/** Tool names this plugin shadows (and therefore mirrors). */
const SHADOWED_TOOL_NAMES = ['edit', 'write']

/** A fs-family tool whose presence proves the tool suite registered. */
const TOOL_FAMILY_WITNESS = 'read'

/**
 * The shadow output schema's deliberate, documented deltas from the shipped
 * one, per tool: extra properties the shadow adds (`unchangedReason`) and
 * shipped-required properties the shadow relaxes (absent from every shadow
 * value, e.g. `operation` on an unchanged write).
 */
const OUTPUT_SCHEMA_ALLOWED_EXTRA_PROPERTIES = new Set(['unchangedReason'])
const OUTPUT_SCHEMA_RELAXED_REQUIRED_PROPERTIES = {
  edit: [],
  write: ['operation'],
}

/** Render a value for a drift report line (bounded length). */
const previewOf = (value) => {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? String(value) : serialized.slice(0, 160)
}

/**
 * First order-sensitive divergence between two compiled JSON Schema nodes —
 * the frozen copy promises byte-identity with the shipped projection, so
 * key ORDER counts.
 * @returns a `path: harness X vs frozen Y` line, or undefined when equal.
 */
function firstSchemaDivergence(shipped, frozen, path) {
  const at = path === '' ? 'parameters' : path
  if (shipped === null || frozen === null || typeof shipped !== 'object' || typeof frozen !== 'object') {
    return shipped === frozen ? undefined : at + ': harness ' + previewOf(shipped) + ' vs frozen ' + previewOf(frozen)
  }
  if (Array.isArray(shipped) !== Array.isArray(frozen)) {
    return at + ': harness ' + previewOf(shipped) + ' vs frozen ' + previewOf(frozen)
  }
  if (Array.isArray(shipped)) {
    if (shipped.length !== frozen.length) {
      return at + '.length: harness ' + shipped.length + ' vs frozen ' + frozen.length
    }
    for (let index = 0; index < shipped.length; index += 1) {
      const divergence = firstSchemaDivergence(shipped[index], frozen[index], at + '[' + index + ']')
      if (divergence !== undefined) return divergence
    }
    return undefined
  }
  const shippedKeys = Object.keys(shipped)
  const frozenKeys = Object.keys(frozen)
  if (shippedKeys.join('\u0000') !== frozenKeys.join('\u0000')) {
    return at + ' keys: harness [' + shippedKeys.join(', ') + '] vs frozen [' + frozenKeys.join(', ') + ']'
  }
  for (const key of shippedKeys) {
    const divergence = firstSchemaDivergence(shipped[key], frozen[key], at + '.' + key)
    if (divergence !== undefined) return divergence
  }
  return undefined
}

/**
 * Verify the shadow output schema equals the shipped one EXCEPT for the
 * documented deltas (extra `unchangedReason`, relaxed required properties).
 * @returns violation lines; empty when the invariant holds.
 */
function outputSchemaInvariantViolations(toolName, shippedOutputSchema, frozenOutputSchema) {
  const violations = []
  const shippedProperties = shippedOutputSchema.properties ?? {}
  const frozenProperties = frozenOutputSchema.properties ?? {}
  for (const [propertyName, shippedNode] of Object.entries(shippedProperties)) {
    const frozenNode = frozenProperties[propertyName]
    if (frozenNode === undefined) {
      violations.push(toolName + ' output property "' + propertyName + '" missing in the frozen copy')
      continue
    }
    const divergence = firstSchemaDivergence(shippedNode, frozenNode, '')
    if (divergence !== undefined) violations.push(toolName + ' output.' + divergence)
  }
  const relaxedRequired = OUTPUT_SCHEMA_RELAXED_REQUIRED_PROPERTIES[toolName] ?? []
  for (const propertyName of Object.keys(frozenProperties)) {
    if (Object.hasOwn(shippedProperties, propertyName)) continue
    if (OUTPUT_SCHEMA_ALLOWED_EXTRA_PROPERTIES.has(propertyName)) continue
    violations.push(toolName + ' output has unexpected extra property "' + propertyName + '"')
  }
  const expectedRequired = (shippedOutputSchema.required ?? [])
    .filter((propertyName) => !relaxedRequired.includes(propertyName)).sort()
  const frozenRequired = [...(frozenOutputSchema.required ?? [])].sort()
  if (expectedRequired.join('\u0000') !== frozenRequired.join('\u0000')) {
    violations.push(
      toolName + ' output.required: harness (minus relaxed ' + JSON.stringify(relaxedRequired) + ') ['
      + expectedRequired.join(', ') + '] vs frozen [' + frozenRequired.join(', ') + ']',
    )
  }
  if (shippedOutputSchema.additionalProperties !== frozenOutputSchema.additionalProperties) {
    violations.push(
      toolName + ' output.additionalProperties: harness '
      + previewOf(shippedOutputSchema.additionalProperties) + ' vs frozen '
      + previewOf(frozenOutputSchema.additionalProperties),
    )
  }
  return violations
}

/**
 * Compare the frozen shadows against the LIVE global tool definitions
 * (`ctx.tools.get(name)` with no scope = the global view,
 * `packages/core/tools/src/index.ts` ToolRuntime.get). Absence is only
 * conclusive when the fs tool family is registered (the `read` witness);
 * otherwise the check stays pending and re-runs on `tools/change`.
 * @returns `{ status: 'match' | 'drift' | 'pending', findings: string[] }`.
 */
function evaluateShippedToolDrift(context, frozenToolsByName) {
  const shippedToolsByName = {}
  const missingToolNames = []
  for (const toolName of SHADOWED_TOOL_NAMES) {
    const shippedTool = context.tools.get(toolName)
    if (shippedTool === undefined) {
      missingToolNames.push(toolName)
    } else {
      shippedToolsByName[toolName] = shippedTool
    }
  }
  if (missingToolNames.length > 0) {
    if (context.tools.get(TOOL_FAMILY_WITNESS) === undefined) {
      // No fs tool suite visible yet: inconclusive (activation-order race
      // or a deployment without tool-fs — see maintenance.md).
      return { status: 'pending', findings: [] }
    }
    return {
      status: 'drift',
      findings: [
        'shipped ' + missingToolNames.join('/') + ' not registered while the fs tool family is ('
        + TOOL_FAMILY_WITNESS + ' present) — renamed or removed upstream; the frozen shadows would serve ghost tools',
      ],
    }
  }
  const findings = []
  for (const toolName of SHADOWED_TOOL_NAMES) {
    const shippedTool = shippedToolsByName[toolName]
    const frozenTool = frozenToolsByName[toolName]
    if (shippedTool.description !== frozenTool.description) {
      findings.push(
        toolName + '.description: harness ' + previewOf(shippedTool.description)
        + ' vs frozen ' + previewOf(frozenTool.description),
      )
    }
    const parameterDivergence = firstSchemaDivergence(shippedTool.parameters, frozenTool.parameters, '')
    if (parameterDivergence !== undefined) findings.push(toolName + ' parameters.' + parameterDivergence)
    findings.push(...outputSchemaInvariantViolations(
      toolName,
      shippedTool.output.schema,
      frozenTool.output.schema,
    ))
  }
  return { status: findings.length > 0 ? 'drift' : 'match', findings }
}

/** The actionable drift message, identical for boot-time and late drift. */
const driftMessageOf = (findings) => 'dsh-approval-first: shipped edit/write drift detected — the frozen shadows '
  + 'no longer mirror this harness:\n  - ' + findings.join('\n  - ')
  + '\nRe-sync the copies per maintenance.md (then bump the version and re-run both test suites), '
  + 'or set driftMode: "warn" to keep serving the frozen shadows anyway.'

// ---------------------------------------------------------------------------
// Plugin apply: drift gate + activation gate + per-agent registration + reversal
// ---------------------------------------------------------------------------


/**
 * The standing sandbox mode of an agent's session, read exactly where the
 * runtime-context snapshot reads it (`sandboxPolicy.resolve`), or undefined
 * when the policy home cannot answer.
 */
function standingSandboxModeOf(context, agent) {
  try {
    const policy = context.sandboxPolicy.resolve({ session: agent.session })
    return policy !== undefined && typeof policy.mode === 'string' ? policy.mode : undefined
  } catch (error) {
    console.error('approval-first: sandboxPolicy.resolve failed for ' + String(agent.id), error)
    return undefined
  }
}

/**
 * Install the plugin: register `edit`/`write` shadows through each agent's
 * own context while that agent's standing sandbox mode is in `activeModes`,
 * and register nothing otherwise. Every registration is reversed on unload,
 * and dies with its agent in between.
 * @param ctx - the plugin context (hard deps in {@link inject}).
 * @param config - validated config (`activeModes`).
 * @returns the plugin disposer.
 */
export function apply(ctx, config) {
  const activeModes = new Set(config.activeModes)
  const advertiseEscalationFields = ctx.fs.sandboxMode !== undefined
  const editShadowTool = createEditShadowTool(ctx, advertiseEscalationFields)
  const writeShadowTool = createWriteShadowTool(ctx, advertiseEscalationFields)

  /** Per-agent shadow disposers, so plugin unload reverses live registrations. */
  const shadowDisposers = new Map()
  let stopping = false
  /** Set when drift was detected after activation under driftMode 'fail'. */
  let driftDisabled = false

  // ---- drift tripwire: refuse to serve shadows that no longer mirror the
  // shipped tools. Boot-time drift under 'fail' THROWS (loud row failure on
  // the boot page); late drift self-disables (listener throws are contained,
  // so disabling the shadows — reverting every agent to the shipped tools —
  // is the loud-enough, safe action).
  const frozenToolsByName = { edit: editShadowTool, write: writeShadowTool }
  const disableForLateDrift = (findings) => {
    console.error(driftMessageOf(findings) + '\n(disabled: every agent falls back to the shipped tools)')
    driftDisabled = true
    const disposers = [...shadowDisposers.values()]
    shadowDisposers.clear()
    for (const disposeShadows of disposers) {
      try { disposeShadows() } catch {}
    }
  }
  let stopToolsChangeListener
  const armToolsChangeListener = () => {
    if (stopToolsChangeListener !== undefined) return
    stopToolsChangeListener = ctx.on('tools/change', () => {
      if (stopping || driftDisabled) return
      const later = evaluateShippedToolDrift(ctx, frozenToolsByName)
      if (later.status === 'match') {
        stopToolsChangeListener()
        stopToolsChangeListener = undefined
      } else if (later.status === 'drift') {
        if (config.driftMode === 'warn') {
          console.error(driftMessageOf(later.findings))
        } else {
          stopToolsChangeListener()
          stopToolsChangeListener = undefined
          disableForLateDrift(later.findings)
        }
      }
    })
  }
  const initialDrift = evaluateShippedToolDrift(ctx, frozenToolsByName)
  if (initialDrift.status === 'drift') {
    if (config.driftMode === 'warn') {
      console.error(driftMessageOf(initialDrift.findings))
    } else {
      throw new Error(driftMessageOf(initialDrift.findings))
    }
  } else if (initialDrift.status === 'pending') {
    armToolsChangeListener()
  }

  const installShadowsForAgent = (agent) => {
    if (stopping || driftDisabled || shadowDisposers.has(agent)) return
    if (!activeModes.has(standingSandboxModeOf(ctx, agent))) return
    let disposeEditShadow
    let disposeWriteShadow
    try {
      disposeEditShadow = agent.ctx.tools.register(editShadowTool)
      disposeWriteShadow = agent.ctx.tools.register(writeShadowTool)
    } catch (registrationError) {
      // A same-name scoped registration already exists (another plugin
      // shadowed the tool for this agent) or the agent scope is closing.
      // Reverse any half-registered shadow and leave the agent to the
      // existing winner — never throw out of an emit listener.
      if (disposeEditShadow !== undefined) { try { disposeEditShadow() } catch {} }
      console.error('approval-first: shadow registration failed for agent ' + String(agent.id), registrationError)
      return
    }
    shadowDisposers.set(agent, () => {
      shadowDisposers.delete(agent)
      try { disposeEditShadow() } catch {}
      try { disposeWriteShadow() } catch {}
    })
  }

  /** Disarm one agent's shadows (idempotent; also prunes the tracking map). */
  const removeShadowsForAgent = (agent) => {
    const disposeShadows = shadowDisposers.get(agent)
    if (disposeShadows !== undefined) disposeShadows()
  }

  /**
   * ONE live code path for "should this agent have shadows right now?":
   * the boot sweep, `agent/created`, and every standing-mode switch converge
   * here. Arm when the agent's CURRENT standing mode is in `activeModes`,
   * disarm when it is not — registration follows the session's live policy,
   * never a snapshot frozen at agent birth.
   */
  const syncShadowsForAgent = (agent) => {
    if (stopping || driftDisabled) return
    const armed = shadowDisposers.has(agent)
    const shouldBeArmed = activeModes.has(standingSandboxModeOf(ctx, agent))
    if (shouldBeArmed && !armed) installShadowsForAgent(agent)
    else if (!shouldBeArmed && armed) removeShadowsForAgent(agent)
  }

  // Sweep agents that are already live at activation (a permanent bundle
  // mounts at boot before any agent exists, but hot activation is covered).
  for (const agent of ctx.agents.list()) {
    syncShadowsForAgent(agent)
  }

  const stopCreated = ctx.on('agent/created', ({ agent }) => {
    syncShadowsForAgent(agent)
  })
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
    shadowDisposers.delete(agent)
  })

  // Standing-mode switches are durable session events ('sandbox/mode',
  // sandbox-policy/src/session-mode.ts) delivered here after commit via the
  // session/event firehose (envelope { type, seq, time, data }). A switch
  // re-evaluates registration for the live agent(s) of THAT session
  // immediately: changing the mode mid-session arms or disarms the shadows
  // in place — the plugin tracks the user's policy changes, not a snapshot
  // taken when the agent was born.
  const stopSessionEvent = ctx.on('session/event', (session, event) => {
    try {
      if (stopping || driftDisabled) return
      if (event === null || event === undefined || event.type !== 'sandbox/mode') return
      const switchedSessionId = session !== null && session !== undefined && session.id !== undefined
        ? String(session.id)
        : undefined
      for (const agent of ctx.agents.list()) {
        if (agent.session === session) {
          syncShadowsForAgent(agent)
        } else if (
          switchedSessionId !== undefined && agent.session !== null && agent.session !== undefined
          && String(agent.session.id) === switchedSessionId
        ) {
          syncShadowsForAgent(agent)
        }
      }
    } catch (error) {
      console.error('approval-first: sandbox/mode switch handler failed', error)
    }
  })

  return () => {
    stopping = true
    stopCreated()
    stopDisposed()
    stopSessionEvent()
    if (stopToolsChangeListener !== undefined) stopToolsChangeListener()
    const disposers = [...shadowDisposers.values()]
    shadowDisposers.clear()
    for (const disposeShadows of disposers) {
      try { disposeShadows() } catch {}
    }
  }
}
