/**
 * dsh-approval-first — plugin tests against a FAITHFUL fake context.
 *
 * The fake implements Cordis's contract, not just its happy-path shape
 * (guide 08, Case 22): `ctx.<service>` property access THROWS unless the
 * service is declared in `inject`, `get` returns undefined for undeclared
 * optionals, and `on`/`emit`/`waterfall` behave as real event surfaces.
 * The mkCtx skeleton is the one specified in spec.md §7, extended with the
 * `sandboxPolicy` guarded name (a service this plugin reads) and working
 * `on`/`emit`/`waterfall` methods (the plugin dispatches fs-intent
 * waterfalls and fs/observed emits through them).
 *
 * Run: node test/plugin.test.mjs   (exit 0 = all assertions green)
 */

import assert from 'node:assert/strict'
import { dirname as pathDirname, resolve as pathResolve } from 'node:path'
import * as plugin from '../lib/index.js'

const CONTRACT_NAME = plugin.name
const CONTRACT_INJECT = plugin.inject
const CONTRACT_CONFIG = plugin.Config

// ---------------------------------------------------------------------------
// The faithful fake context (spec §7 mkCtx + working event surface)
// ---------------------------------------------------------------------------

const mkEventBus = () => {
  const listenersByType = new Map()
  return {
    on(type, listener) {
      if (!listenersByType.has(type)) listenersByType.set(type, new Set())
      listenersByType.get(type).add(listener)
      return () => { listenersByType.get(type)?.delete(listener) }
    },
    emit(type, ...eventArguments) {
      for (const listener of listenersByType.get(type) ?? []) listener(...eventArguments)
    },
    async waterfall(type, ...waterfallArguments) {
      const fallback = waterfallArguments.pop()
      const handlers = [...(listenersByType.get(type) ?? [])]
      const dispatch = (handlerIndex) => handlerIndex >= handlers.length
        ? Promise.resolve(typeof fallback === 'function' ? fallback() : fallback)
        : Promise.resolve(handlers[handlerIndex](...waterfallArguments, () => dispatch(handlerIndex + 1)))
      return dispatch(0)
    },
    listenerCount(type) {
      return listenersByType.get(type)?.size ?? 0
    },
  }
}

const mkCtx = (injectList, provided) => {
  const declared = new Set(injectList || [])
  const eventBus = mkEventBus()
  const ctx = {
    inject: injectList,
    get: (name) => (declared.has(name) ? provided[name] : undefined),
    provide: (name, api) => { provided[name] = api },
    on: eventBus.on,
    emit: eventBus.emit,
    waterfall: eventBus.waterfall,
    __eventBus: eventBus,
  }
  for (const name of ['approval', 'fs', 'tools', 'sessions', 'agents', 'sandboxPolicy']) {
    Object.defineProperty(ctx, name, {
      get() {
        if (!declared.has(name)) throw new Error('cannot get property "' + name + '" without inject')
        return provided[name]
      },
    })
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Fake services
// ---------------------------------------------------------------------------

const EDIT_BEFORE = 'alpha\nbeta\ngamma\n'
const EDIT_AFTER = 'alpha\nBETA\ngamma\n'

const mkApprovalService = (outcome, options = {}) => {
  const requests = []
  return {
    request: async (requestArguments) => {
      requests.push(requestArguments)
      if (options.throwInstead) throw new Error('approval seam is broken')
      return outcome
    },
    __requests: requests,
  }
}

const mkFsService = (options = {}) => {
  const mutationCalls = []
  const sandboxRoot = options.sandboxRoot ?? '/w'
  return {
    sandboxMode: 'sandboxMode' in options ? options.sandboxMode : 'read-only',
    resolve: async (requestedPath, resolveOptions) => {
      const resolved = pathResolve(resolveOptions?.cwd ?? sandboxRoot, requestedPath)
      return { displayPath: resolved, targetKey: 'target-key:' + resolved }
    },
    processPath: (target) => target.displayPath,
    editText: async (target, edit, expected, signal, sandboxPolicy) => {
      mutationCalls.push({ kind: 'editText', target, edit, expected, signal, sandboxPolicy })
      if (options.denyWhen?.(sandboxPolicy)) {
        throw Object.assign(
          new Error('cannot write "' + target.displayPath + '": file access denied under workspace-write mode'),
          { name: 'FsError', code: 'FS_SANDBOX_DENIED' },
        )
      }
      if (options.editTextThrows) throw options.editTextThrows
      return { version: 'version-edit-1', before: EDIT_BEFORE, after: EDIT_AFTER }
    },
    writeText: async (target, content, expected, signal, sandboxPolicy) => {
      mutationCalls.push({ kind: 'writeText', target, content, expected, signal, sandboxPolicy })
      if (options.denyWhen?.(sandboxPolicy)) {
        throw Object.assign(
          new Error('cannot write "' + target.displayPath + '": file access denied under workspace-write mode'),
          { name: 'FsError', code: 'FS_SANDBOX_DENIED' },
        )
      }
      if (options.writeTextThrows) throw options.writeTextThrows
      return { version: 'version-write-1', operation: content === '' ? 'create' : 'create', before: null, after: content }
    },
    __mutationCalls: mutationCalls,
  }
}

const mkSandboxPolicyService = (mode) => ({
  resolve: ({ session } = {}) => ({
    mode,
    workspaceRoot: session?.header?.cwd ?? '/w',
    ...(session !== undefined ? { sessionId: session.id } : {}),
  }),
})

/** A policy fake whose folded mode can be switched mid-test, like a live session. */
const mkSwitchableSandboxPolicy = (initialMode) => {
  const policyState = { mode: initialMode }
  return {
    policyState,
    service: {
      resolve: ({ session } = {}) => ({
        mode: policyState.mode,
        workspaceRoot: session?.header?.cwd ?? '/w',
        ...(session !== undefined ? { sessionId: session.id } : {}),
      }),
    },
  }
}

const mkAgentsService = (agents) => ({
  list: () => [...agents],
})

// ---------------------------------------------------------------------------
// Shipped-global fixtures: emulate what the REAL tool-fs registers today
// (the runtime tripwire compares against the live definitions; these
// fixtures let the tests exercise the tripwire itself deterministically).
// ---------------------------------------------------------------------------

const shippedEditParameters = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Path to edit, resolved by the filesystem backend.' },
    old_string: { type: 'string', description: 'Literal text to replace. Must match exactly.' },
    new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
    replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
    sandbox_permissions: {
      type: 'string',
      description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry of an operation the sandbox just denied; requires justification and user approval.',
      enum: ['workspace-write', 'danger-full-access'],
    },
    justification: {
      type: 'string',
      description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access.',
    },
  },
  required: ['file_path', 'old_string', 'new_string'],
}

const shippedWriteParameters = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Path to write, resolved by the filesystem backend.' },
    content: { type: 'string', description: 'Full UTF-8 text content to write.' },
    sandbox_permissions: {
      type: 'string',
      description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry of an operation the sandbox just denied; requires justification and user approval.',
      enum: ['workspace-write', 'danger-full-access'],
    },
    justification: {
      type: 'string',
      description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access.',
    },
  },
  required: ['file_path', 'content'],
}

const shippedEditOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
  },
  required: ['path', 'before', 'after'],
}

const shippedWriteOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    operation: { type: 'string', enum: ['create', 'update'] },
    before: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    after: { type: 'string' },
  },
  required: ['path', 'operation', 'before', 'after'],
}

const deepCopy = (value) => JSON.parse(JSON.stringify(value))

/** The live global tool definitions as today's tool-fs registers them. */
const mkShippedGlobalTools = (confining = true) => {
  const editParameters = deepCopy(shippedEditParameters)
  const writeParameters = deepCopy(shippedWriteParameters)
  if (!confining) {
    delete editParameters.properties.sandbox_permissions
    delete editParameters.properties.justification
    delete writeParameters.properties.sandbox_permissions
    delete writeParameters.properties.justification
  }
  return {
    read: { name: 'read', description: 'Read a UTF-8 text file.' },
    edit: {
      name: 'edit',
      description: 'Edit an existing UTF-8 text file by replacing literal text.',
      parameters: editParameters,
      output: { schema: deepCopy(shippedEditOutputSchema) },
    },
    write: {
      name: 'write',
      description: 'Create or fully replace a UTF-8 text file.',
      parameters: writeParameters,
      output: { schema: deepCopy(shippedWriteOutputSchema) },
    },
  }
}

const mkToolsService = (globals) => ({
  get: (toolName) => globals[toolName],
})

/** Capture console.error lines while `body` runs (restored in finally). */
const captureConsoleError = async (body) => {
  const originalConsoleError = console.error
  const lines = []
  console.error = (...logged) => { lines.push(logged.map(String).join(' ')) }
  try {
    const result = await body()
    return { result, lines }
  } finally {
    console.error = originalConsoleError
  }
}

const mkAgent = (identifier, cwd) => {
  const registeredTools = new Map()
  const agentCtx = mkCtx(['tools'], {
    tools: {
      register: (definition) => {
        registeredTools.set(definition.name, definition)
        return () => { registeredTools.delete(definition.name) }
      },
    },
  })
  return {
    id: identifier,
    session: { id: identifier, header: { cwd } },
    ctx: agentCtx,
    __registeredTools: registeredTools,
  }
}

const mkExec = (agent, callId = 'call-7') => ({
  callId,
  rootCallId: callId,
  name: 'edit',
  arguments: {},
  ...(agent !== undefined ? { agent } : {}),
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const installPlugin = ({ agents = [], approvalOutcome = 'allowed-once', standingMode = 'read-only', activeModes, fsOptions, driftMode, toolsGlobals, sandboxPolicyService }) => {
  const approval = mkApprovalService(approvalOutcome)
  const fs = mkFsService(fsOptions)
  const confining = fs.sandboxMode !== undefined
  const provided = {
    approval,
    fs,
    agents: mkAgentsService(agents),
    sandboxPolicy: sandboxPolicyService ?? mkSandboxPolicyService(standingMode),
    tools: mkToolsService(toolsGlobals !== undefined ? toolsGlobals : mkShippedGlobalTools(confining)),
  }
  const pluginCtx = mkCtx(plugin.inject, provided)
  const rawConfig = {
    ...(activeModes !== undefined ? { activeModes } : {}),
    ...(driftMode !== undefined ? { driftMode } : {}),
  }
  const config = CONTRACT_CONFIG['~standard'].validate(Object.keys(rawConfig).length > 0 ? rawConfig : undefined).value
  const disposePlugin = plugin.apply(pluginCtx, config)
  return { pluginCtx, approval, fs, provided, disposePlugin }
}

let checksPassed = 0
const checkThunks = []
const check = (description, verify) => {
  checkThunks.push({ description, verify })
}

// Sequential await: an async verify's assertions must actually settle before
// the next check runs and before the summary line (the first version of this
// suite fired async verifies unawaited — one failing assertion escaped as an
// unhandled rejection AFTER the "all green" summary).
const runChecks = async () => {
  for (const { description, verify } of checkThunks) {
    await verify()
    checksPassed += 1
    console.log('  ok - ' + description)
  }
}

// ---------------------------------------------------------------------------
// 1. Contract snapshot + inject guard (Case-22 class)
// ---------------------------------------------------------------------------

console.log('contract + inject guard')

check('plugin contract name', () => {
  assert.equal(CONTRACT_NAME, 'approval-first')
})

check('inject declares exactly the services apply touches', () => {
  assert.deepEqual([...CONTRACT_INJECT].sort(), ['agents', 'approval', 'fs', 'sandboxPolicy', 'tools'])
})

check('mis-declared service access THROWS on the faithful fake', () => {
  const ctx = mkCtx(['fs'], { fs: mkFsService() })
  assert.throws(() => ctx.approval, /cannot get property "approval" without inject/)
  assert.throws(() => ctx.agents, /cannot get property "agents" without inject/)
  assert.throws(() => ctx.sandboxPolicy, /cannot get property "sandboxPolicy" without inject/)
  assert.equal(ctx.fs.sandboxMode, 'read-only')
  assert.equal(ctx.get('approval'), undefined)
})

check('apply runs cleanly when every inject is declared', () => {
  const { disposePlugin } = installPlugin({})
  disposePlugin()
})

// ---------------------------------------------------------------------------
// 2. Config schema
// ---------------------------------------------------------------------------

console.log('config schema')

check('undefined config defaults activeModes to [read-only] with driftMode fail', () => {
  assert.deepEqual(CONTRACT_CONFIG['~standard'].validate(undefined).value, { activeModes: ['read-only'], driftMode: 'fail' })
})

check('empty object config defaults activeModes to [read-only] with driftMode fail', () => {
  assert.deepEqual(CONTRACT_CONFIG['~standard'].validate({}).value, { activeModes: ['read-only'], driftMode: 'fail' })
})

check('a valid activeModes list passes through', () => {
  assert.deepEqual(
    CONTRACT_CONFIG['~standard'].validate({ activeModes: ['read-only', 'workspace-write'] }).value,
    { activeModes: ['read-only', 'workspace-write'], driftMode: 'fail' },
  )
})

check('a non-array activeModes is an issue', () => {
  assert.ok(CONTRACT_CONFIG['~standard'].validate({ activeModes: 'read-only' }).issues.length > 0)
})

check('an unknown mode string is an issue (loud misconfiguration)', () => {
  const issues = CONTRACT_CONFIG['~standard'].validate({ activeModes: ['read-only', 'read-only '] }).issues
  assert.ok(issues.length > 0)
  assert.match(issues[0].message, /unknown sandbox mode/)
})

// ---------------------------------------------------------------------------
// 3. Activation gating
// ---------------------------------------------------------------------------

console.log('activation gating')

check('standing mode NOT in activeModes registers NOTHING', () => {
  const agent = mkAgent('session-a', '/w')
  const { disposePlugin } = installPlugin({ agents: [agent], standingMode: 'workspace-write' })
  assert.equal(agent.__registeredTools.size, 0)
  disposePlugin()
})

check('standing mode in activeModes registers edit+write per agent (boot sweep)', () => {
  const agent = mkAgent('session-a', '/w')
  const { disposePlugin } = installPlugin({ agents: [agent], standingMode: 'read-only' })
  assert.deepEqual([...agent.__registeredTools.keys()].sort(), ['edit', 'write'])
  disposePlugin()
})

check('agents created later get their shadows through agent/created', () => {
  const { pluginCtx, disposePlugin } = installPlugin({ standingMode: 'read-only' })
  const lateAgent = mkAgent('session-late', '/w')
  pluginCtx.__eventBus.emit('agent/created', { agent: lateAgent })
  assert.deepEqual([...lateAgent.__registeredTools.keys()].sort(), ['edit', 'write'])
  disposePlugin()
})

check('an agent created later under a non-active mode gets NOTHING', () => {
  const { pluginCtx, disposePlugin } = installPlugin({ standingMode: 'danger-full-access' })
  const lateAgent = mkAgent('session-late', '/w')
  pluginCtx.__eventBus.emit('agent/created', { agent: lateAgent })
  assert.equal(lateAgent.__registeredTools.size, 0)
  disposePlugin()
})

check('a configured activeMode extends activation', () => {
  const agent = mkAgent('session-a', '/w')
  const { disposePlugin } = installPlugin({
    agents: [agent],
    standingMode: 'workspace-write',
    activeModes: ['workspace-write'],
  })
  assert.deepEqual([...agent.__registeredTools.keys()].sort(), ['edit', 'write'])
  disposePlugin()
})

check('a missing sandboxPolicy service fails safe (no registration, no crash)', () => {
  const agent = mkAgent('session-a', '/w')
  const provided = {
    approval: mkApprovalService('allowed-once'),
    fs: mkFsService(),
    agents: mkAgentsService([agent]),
    tools: mkToolsService(mkShippedGlobalTools(true)),
  }
  const pluginCtx = mkCtx(plugin.inject, provided)
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only'] })
  assert.equal(agent.__registeredTools.size, 0)
  disposePlugin()
})

// ---------------------------------------------------------------------------
// 4. Model-visible schemas mirror the shipped tools
// ---------------------------------------------------------------------------

console.log('schemas')

const expectedEditParameters = shippedEditParameters

check('edit parameters are byte-identical to the shipped projection (incl. order)', () => {
  const agent = mkAgent('session-a', '/w')
  const { disposePlugin } = installPlugin({ agents: [agent] })
  const editTool = agent.__registeredTools.get('edit')
  assert.equal(JSON.stringify(editTool.parameters), JSON.stringify(expectedEditParameters))
  assert.equal(editTool.description, 'Edit an existing UTF-8 text file by replacing literal text.')
  disposePlugin()
})

check('escalation fields are absent when the fs backend does not confine', () => {
  const agent = mkAgent('session-a', '/w')
  const { disposePlugin } = installPlugin({ agents: [agent], fsOptions: { sandboxMode: undefined } })
  const editTool = agent.__registeredTools.get('edit')
  assert.equal(editTool.parameters.properties.sandbox_permissions, undefined)
  assert.equal(editTool.parameters.properties.justification, undefined)
  disposePlugin()
})

// ---------------------------------------------------------------------------
// 5. Approval outcome branches
// ---------------------------------------------------------------------------

console.log('approval outcome branches')

const runEditCall = async ({ approvalOutcome, escalationArguments, execArguments, fsOptions, requestOptions, standingMode = 'read-only' }) => {
  const agent = mkAgent('session-a', '/w')
  const approval = mkApprovalService(approvalOutcome, requestOptions)
  const fs = mkFsService(fsOptions)
  const pluginCtx = mkCtx(plugin.inject, {
    approval,
    fs,
    agents: mkAgentsService([agent]),
    sandboxPolicy: mkSandboxPolicyService(standingMode),
    tools: mkToolsService(mkShippedGlobalTools(true)),
  })
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only', 'workspace-write', 'danger-full-access'] })
  const editTool = agent.__registeredTools.get('edit')
  const exec = mkExec(agent)
  const args = {
    file_path: '/w/src/app.js',
    old_string: 'before-text',
    new_string: 'after-text',
    ...execArguments,
    ...escalationArguments,
  }
  try {
    const value = await editTool.execute(args, exec)
    const text = editTool.output.render(args, value)[0].text
    return { value, text, fs, approval }
  } finally {
    disposePlugin()
  }
}

check('allowed-once mutates ONCE with the exact per-call policy', async () => {
  const { value, text, fs, approval } = await runEditCall({ approvalOutcome: 'allowed-once' })
  assert.equal(approval.__requests.length, 1)
  assert.equal(fs.__mutationCalls.length, 1)
  assert.deepEqual(fs.__mutationCalls[0].sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: pathDirname('/w/src/app.js'),
  })
  assert.deepEqual(value, { path: '/w/src/app.js', before: EDIT_BEFORE, after: EDIT_AFTER })
  assert.equal(text, 'The file /w/src/app.js has been updated successfully.')
})

check('the approval request carries toolName, callId, reason and agent', async () => {
  const { approval } = await runEditCall({ approvalOutcome: 'rejected' })
  const [request] = approval.__requests
  assert.equal(request.toolName, 'edit')
  assert.equal(request.callId, 'call-7')
  assert.equal(request.reason, 'edit app.js')
  assert.equal(request.agent.id, 'session-a')
})

check('rejected returns ONE normal result with the spec phrasing, no mutation, no throw', async () => {
  const { value, text, fs, approval } = await runEditCall({ approvalOutcome: 'rejected' })
  assert.equal(approval.__requests.length, 1)
  assert.equal(fs.__mutationCalls.length, 0)
  assert.equal(value.unchangedReason, 'rejected')
  assert.equal(text, 'edit rejected by the user; file unchanged')
})

check('cancelled returns a normal result, no mutation', async () => {
  const { value, text, fs } = await runEditCall({ approvalOutcome: 'cancelled' })
  assert.equal(fs.__mutationCalls.length, 0)
  assert.equal(value.unchangedReason, 'cancelled')
  assert.equal(text, 'edit cancelled; file unchanged')
})

check('unavailable returns a normal result, no mutation', async () => {
  const { value, text, fs } = await runEditCall({ approvalOutcome: 'unavailable' })
  assert.equal(fs.__mutationCalls.length, 0)
  assert.equal(value.unchangedReason, 'unavailable')
  assert.equal(text, 'approval unavailable; file unchanged')
})

check('a rogue outcome string fails closed to unavailable', async () => {
  const { value, text, fs } = await runEditCall({ approvalOutcome: 'yes' })
  assert.equal(fs.__mutationCalls.length, 0)
  assert.equal(value.unchangedReason, 'unavailable')
  assert.equal(text, 'approval unavailable; file unchanged')
})

check('a throwing approval seam fails closed with the normal unavailable result', async () => {
  const { value, text, fs } = await runEditCall({
    approvalOutcome: 'allowed-once',
    requestOptions: { throwInstead: true },
  })
  assert.equal(fs.__mutationCalls.length, 0)
  assert.equal(value.unchangedReason, 'unavailable')
  assert.equal(text, 'approval unavailable; file unchanged')
})

check('an agent-less call never asks and never mutates', async () => {
  const agent = mkAgent('session-a', '/w')
  const approval = mkApprovalService('allowed-once')
  const fs = mkFsService()
  const pluginCtx = mkCtx(plugin.inject, {
    approval,
    fs,
    agents: mkAgentsService([agent]),
    sandboxPolicy: mkSandboxPolicyService('read-only'),
    tools: mkToolsService(mkShippedGlobalTools(true)),
  })
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only'] })
  const editTool = agent.__registeredTools.get('edit')
  const value = await editTool.execute(
    { file_path: '/w/src/app.js', old_string: 'a', new_string: 'b' },
    mkExec(undefined),
  )
  assert.equal(approval.__requests.length, 0)
  assert.equal(fs.__mutationCalls.length, 0)
  assert.equal(editTool.output.render({}, value)[0].text, 'approval unavailable; file unchanged')
  disposePlugin()
})

// ---------------------------------------------------------------------------
// 6. Shipped-tool semantics: write path, intents, observed, errors, escalation
// ---------------------------------------------------------------------------

console.log('shipped-tool semantics')

const runWriteCall = async ({ approvalOutcome = 'allowed-once' } = {}) => {
  const agent = mkAgent('session-a', '/w')
  const approval = mkApprovalService(approvalOutcome)
  const fs = mkFsService()
  const pluginCtx = mkCtx(plugin.inject, {
    approval,
    fs,
    agents: mkAgentsService([agent]),
    sandboxPolicy: mkSandboxPolicyService('read-only'),
    tools: mkToolsService(mkShippedGlobalTools(true)),
  })
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only'] })
  const writeTool = agent.__registeredTools.get('write')
  const exec = mkExec(agent)
  const args = { file_path: '/w/docs/note.md', content: 'hello\nworld\n' }
  try {
    const value = await writeTool.execute(args, exec)
    const text = writeTool.output.render(args, value)[0].text
    return { value, text, fs, pluginCtx, writeTool, args }
  } finally {
    disposePlugin()
  }
}

check('write success uses the shipped envelope and per-call policy', async () => {
  const { value, text, fs } = await runWriteCall()
  assert.deepEqual(fs.__mutationCalls[0].sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: pathDirname('/w/docs/note.md'),
  })
  assert.equal(value.operation, 'create')
  assert.equal(
    text,
    '<path>/w/docs/note.md</path>\n<type>file</type>\n<content>\nCreated file\n</content>',
  )
})

check('write rejected keeps the file unchanged with a normal result', async () => {
  const { value, text, fs } = await runWriteCall({ approvalOutcome: 'rejected' })
  assert.equal(fs.__mutationCalls.length, 0)
  assert.equal(text, 'write rejected by the user; file unchanged')
})

check('fs/write-intent and fs/edit-intent waterfalls are dispatched, fs/observed recorded', async () => {
  const agent = mkAgent('session-a', '/w')
  const fs = mkFsService()
  const pluginCtx = mkCtx(plugin.inject, {
    approval: mkApprovalService('allowed-once'),
    fs,
    agents: mkAgentsService([agent]),
    sandboxPolicy: mkSandboxPolicyService('read-only'),
    tools: mkToolsService(mkShippedGlobalTools(true)),
  })
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only'] })
  const exec = mkExec(agent)
  const observedArguments = []
  pluginCtx.__eventBus.on('fs/observed', (...emitArguments) => observedArguments.push(emitArguments))
  await agent.__registeredTools.get('write').execute({ file_path: '/w/a.txt', content: 'x' }, exec)
  await agent.__registeredTools.get('edit').execute({ file_path: '/w/a.txt', old_string: 'x', new_string: 'y' }, exec)
  assert.equal(observedArguments.length, 2)
  assert.deepEqual(observedArguments[0][1], { kind: 'present', version: 'version-write-1' })
  assert.deepEqual(observedArguments[1][1], { kind: 'present', version: 'version-edit-1' })
  assert.equal(observedArguments[0][2], exec)
  disposePlugin()
})

check('an intent guard returned by the policy slot reaches the mutation', async () => {
  const agent = mkAgent('session-a', '/w')
  const fs = mkFsService()
  const pluginCtx = mkCtx(plugin.inject, {
    approval: mkApprovalService('allowed-once'),
    fs,
    agents: mkAgentsService([agent]),
    sandboxPolicy: mkSandboxPolicyService('read-only'),
    tools: mkToolsService(mkShippedGlobalTools(true)),
  })
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only'] })
  pluginCtx.__eventBus.on('fs/write-intent', (target, actor, next) => ({ kind: 'createIfAbsent' }))
  await agent.__registeredTools.get('write').execute({ file_path: '/w/new.txt', content: 'x' }, mkExec(agent))
  assert.deepEqual(fs.__mutationCalls[0].expected, { kind: 'createIfAbsent' })
  disposePlugin()
})

check('a sandbox denial maps to the shared marker + escalation hint (edit path)', async () => {
  const { fs: caughtFs } = {}
  const agent = mkAgent('session-a', '/w')
  const fs = mkFsService({
    editTextThrows: Object.assign(new Error('cannot write "/w/a.md": file access denied under workspace-write mode'), {
      name: 'FsError',
      code: 'FS_SANDBOX_DENIED',
    }),
  })
  const pluginCtx = mkCtx(plugin.inject, {
    approval: mkApprovalService('allowed-once'),
    fs,
    agents: mkAgentsService([agent]),
    sandboxPolicy: mkSandboxPolicyService('read-only'),
    tools: mkToolsService(mkShippedGlobalTools(true)),
  })
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only'] })
  await assert.rejects(
    agent.__registeredTools.get('edit').execute(
      { file_path: '/w/a.md', old_string: 'x', new_string: 'y' },
      mkExec(agent),
    ),
    (thrownError) => {
      assert.match(thrownError.message, /^\[sandbox: file access denied under workspace-write mode\]/)
      assert.match(thrownError.message, /\[sandbox: escalation available — retry this exact operation once/)
      assert.equal(thrownError.code, 'FS_SANDBOX_DENIED')
      return true
    },
  )
  void caughtFs
  disposePlugin()
})

check('an FS_NOT_OBSERVED failure gains the model-facing remedy', async () => {
  const agent = mkAgent('session-a', '/w')
  const fs = mkFsService({
    editTextThrows: Object.assign(new Error('"/w/a.md" was never observed by this session'), {
      name: 'FsError',
      code: 'FS_NOT_OBSERVED',
    }),
  })
  const pluginCtx = mkCtx(plugin.inject, {
    approval: mkApprovalService('allowed-once'),
    fs,
    agents: mkAgentsService([agent]),
    sandboxPolicy: mkSandboxPolicyService('read-only'),
    tools: mkToolsService(mkShippedGlobalTools(true)),
  })
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only'] })
  await assert.rejects(
    agent.__registeredTools.get('edit').execute(
      { file_path: '/w/a.md', old_string: 'x', new_string: 'y' },
      mkExec(agent),
    ),
    (thrownError) => {
      assert.match(thrownError.message, / — read the file, then retry$/)
      assert.equal(thrownError.code, 'FS_NOT_OBSERVED')
      return true
    },
  )
  disposePlugin()
})

check('escalation argument pairing is validated with the shipped texts', async () => {
  await assert.rejects(
    runEditCall({ approvalOutcome: 'allowed-once', escalationArguments: { sandbox_permissions: 'workspace-write' } }),
    /invalid escalation: sandbox_permissions requires a justification/,
  )
  await assert.rejects(
    runEditCall({ approvalOutcome: 'allowed-once', escalationArguments: { justification: 'because' } }),
    /invalid escalation: justification is only valid together with sandbox_permissions/,
  )
})

check('a WELL-FORMED escalation request is absorbed by the approval-first ask', async () => {
  const { fs, text } = await runEditCall({
    approvalOutcome: 'allowed-once',
    escalationArguments: { sandbox_permissions: 'danger-full-access', justification: 'trust me' },
  })
  // Never danger-full-access: the mutation still runs the narrow per-call grant.
  assert.deepEqual(fs.__mutationCalls[0].sandboxPolicy, { mode: 'workspace-write', workspaceRoot: '/w/src' })
  assert.match(text, /has been updated successfully/)
})

check('argument violations use the registry texts', async () => {
  await assert.rejects(
    runEditCall({ approvalOutcome: 'allowed-once', execArguments: { old_string: undefined } }),
    (thrownError) => {
      assert.equal(thrownError.name, 'ToolArgsError')
      assert.equal(thrownError.code, 'INVALID_ARGS')
      assert.match(thrownError.message, /^invalid arguments: missing required property "old_string"/)
      return true
    },
  )
  await assert.rejects(
    runEditCall({ approvalOutcome: 'allowed-once', execArguments: { replace_all: 'yes' } }),
    /invalid arguments: "replace_all" must be a boolean/,
  )
})

check('parse-level value checks match the shipped texts', async () => {
  await assert.rejects(
    runEditCall({ approvalOutcome: 'allowed-once', execArguments: { old_string: 'x', new_string: 'x' } }),
    /old_string and new_string must differ/,
  )
})

check('presentCall mirrors the shipped diff cards', async () => {
  const agent = mkAgent('session-a', '/w')
  const { disposePlugin } = installPlugin({ agents: [agent] })
  const editTool = agent.__registeredTools.get('edit')
  const writeTool = agent.__registeredTools.get('write')
  assert.deepEqual(
    editTool.presentCall({ file_path: 'a.md', old_string: 'x', new_string: 'y' }),
    {
      card: 'diff',
      title: 'Edit a.md',
      diffs: [{ path: 'a.md', oldText: 'x', newText: 'y' }],
      locations: [{ path: 'a.md' }],
    },
  )
  assert.deepEqual(
    writeTool.presentCall({ file_path: 'a.md', content: 'body' }),
    {
      card: 'diff',
      title: 'Write a.md',
      diffs: [{ path: 'a.md', oldText: null, newText: 'body' }],
      locations: [{ path: 'a.md' }],
    },
  )
  assert.equal(editTool.presentCall({ file_path: 'a.md' }), undefined)
  disposePlugin()
})

check('an unchanged call presents no diff card (write keeps no fallback diff)', async () => {
  const agent = mkAgent('session-a', '/w')
  const { disposePlugin } = installPlugin({ agents: [agent] })
  const writeTool = agent.__registeredTools.get('write')
  const editTool = agent.__registeredTools.get('edit')
  const unchangedMeta = writeTool.output.presentationMeta(
    { file_path: 'a.md', content: 'body' },
    { path: '/w/a.md', before: null, after: '', unchangedReason: 'rejected' },
  )
  assert.deepEqual(unchangedMeta, { diffs: [], unchanged: true })
  assert.equal(
    writeTool.presentResult({ file_path: 'a.md', content: 'body' }, { isError: false, content: [], meta: unchangedMeta }),
    undefined,
  )
  assert.equal(
    editTool.presentResult({ file_path: 'a.md' }, { isError: false, content: [], meta: unchangedMeta }),
    undefined,
  )
  disposePlugin()
})

// ---------------------------------------------------------------------------
// 7. workspace-write gating: ask only outside the standing writable roots
// ---------------------------------------------------------------------------

console.log('workspace-write gating')

const runGatedCall = async ({ toolName = 'edit', filePath, approvalOutcome = 'allowed-once', standingMode, denyWhen, agentCwd = '/w' }) => {
  const agent = mkAgent('session-a', agentCwd)
  const approval = mkApprovalService(approvalOutcome)
  const fs = mkFsService({ denyWhen })
  const pluginCtx = mkCtx(plugin.inject, {
    approval,
    fs,
    agents: mkAgentsService([agent]),
    sandboxPolicy: mkSandboxPolicyService(standingMode),
    tools: mkToolsService(mkShippedGlobalTools(fs.sandboxMode !== undefined)),
  })
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only', 'workspace-write', 'danger-full-access'] })
  const tool = agent.__registeredTools.get(toolName)
  const exec = mkExec(agent)
  const args = toolName === 'edit'
    ? { file_path: filePath, old_string: 'x', new_string: 'y' }
    : { file_path: filePath, content: 'body\n' }
  try {
    const value = await tool.execute(args, exec)
    return { value, text: tool.output.render(args, value)[0].text, fs, approval }
  } finally {
    disposePlugin()
  }
}

check('IN-workspace write under workspace-write: NO ask, standing policy, silent success', async () => {
  const { value, text, fs, approval } = await runGatedCall({
    toolName: 'write', filePath: '/w/src/app.js', standingMode: 'workspace-write',
  })
  assert.equal(approval.__requests.length, 0)
  assert.equal(fs.__mutationCalls.length, 1)
  assert.deepEqual(fs.__mutationCalls[0].sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/w',
    sessionId: 'session-a',
  })
  assert.equal(value.unchangedReason, undefined)
  assert.match(text, /Created file/)
})

check('OUT-of-workspace write under workspace-write: asks FIRST with the outside note, then parent-dir grant', async () => {
  const { fs, approval, text } = await runGatedCall({
    toolName: 'write', filePath: '/etc/dsh-demo.conf', standingMode: 'workspace-write',
  })
  assert.equal(approval.__requests.length, 1)
  assert.equal(approval.__requests[0].toolName, 'write')
  assert.equal(approval.__requests[0].reason, 'write dsh-demo.conf — outside the writable workspace')
  assert.deepEqual(fs.__mutationCalls[0].sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/etc',
  })
  assert.match(text, /Created file/)
})

check('OUT-of-workspace edit under workspace-write, rejected: unchanged, no mutation', async () => {
  const { value, text, fs, approval } = await runGatedCall({
    filePath: '/srv/data/db.conf', standingMode: 'workspace-write', approvalOutcome: 'rejected',
  })
  assert.equal(approval.__requests.length, 1)
  assert.equal(fs.__mutationCalls.length, 0)
  assert.equal(text, 'edit rejected by the user; file unchanged')
  assert.equal(value.unchangedReason, 'rejected')
})

check('a /tmp target is a standing writable root: silent under workspace-write', async () => {
  const { fs, approval } = await runGatedCall({
    filePath: '/tmp/dsh-approval-first-probe.txt', standingMode: 'workspace-write',
  })
  assert.equal(approval.__requests.length, 0)
  assert.equal(fs.__mutationCalls.length, 1)
})

check('under read-only EVERY target asks (no writable roots), reason stays plain', async () => {
  const { approval } = await runGatedCall({
    filePath: '/w/src/app.js', standingMode: 'read-only', approvalOutcome: 'rejected',
  })
  assert.equal(approval.__requests.length, 1)
  assert.equal(approval.__requests[0].reason, 'edit app.js')
})

check('danger-full-access stance: never asks, passthrough of the standing policy', async () => {
  const { fs, approval } = await runGatedCall({
    filePath: '/etc/dsh-demo.conf', standingMode: 'danger-full-access',
  })
  assert.equal(approval.__requests.length, 0)
  assert.deepEqual(fs.__mutationCalls[0].sandboxPolicy, {
    mode: 'danger-full-access',
    workspaceRoot: '/w',
    sessionId: 'session-a',
  })
})

check('containment-miss fallback: silent attempt denied by the fence converts into the ask', async () => {
  // denyWhen denies ONLY the standing policy (workspaceRoot /w), so the
  // judged-in-policy attempt fails FS_SANDBOX_DENIED and the fallback ask
  // must rescue it with the parent-dir grant (workspaceRoot /w/src).
  const { text, fs, approval } = await runGatedCall({
    filePath: '/w/src/app.js',
    standingMode: 'workspace-write',
    denyWhen: (policy) => policy?.workspaceRoot === '/w',
  })
  assert.equal(approval.__requests.length, 1)
  assert.equal(approval.__requests[0].reason, 'edit app.js — outside the writable workspace')
  assert.equal(fs.__mutationCalls.length, 2)
  assert.deepEqual(fs.__mutationCalls[1].sandboxPolicy, { mode: 'workspace-write', workspaceRoot: '/w/src' })
  assert.match(text, /has been updated successfully/)
})

check('containment-miss fallback, user rejects: unchanged result, exactly one attempt', async () => {
  const { text, fs, approval } = await runGatedCall({
    filePath: '/w/src/app.js',
    standingMode: 'workspace-write',
    approvalOutcome: 'rejected',
    denyWhen: (policy) => policy?.workspaceRoot === '/w',
  })
  assert.equal(approval.__requests.length, 1)
  assert.equal(fs.__mutationCalls.length, 1)
  assert.equal(text, 'edit rejected by the user; file unchanged')
})

check('agent-less IN-workspace call under workspace-write mutates silently (shipped parity)', async () => {
  const agent = mkAgent('session-a', '/w')
  const approval = mkApprovalService('allowed-once')
  const fs = mkFsService()
  const pluginCtx = mkCtx(plugin.inject, {
    approval,
    fs,
    agents: mkAgentsService([agent]),
    sandboxPolicy: mkSandboxPolicyService('workspace-write'),
    tools: mkToolsService(mkShippedGlobalTools(true)),
  })
  const disposePlugin = plugin.apply(pluginCtx, { activeModes: ['read-only', 'workspace-write'] })
  const writeTool = agent.__registeredTools.get('write')
  const value = await writeTool.execute(
    { file_path: '/w/note.md', content: 'x' },
    mkExec(undefined),
  )
  assert.equal(approval.__requests.length, 0)
  assert.equal(fs.__mutationCalls.length, 1)
  assert.equal(value.unchangedReason, undefined)
  disposePlugin()
})

// ---------------------------------------------------------------------------
// 8. Drift tripwire
// ---------------------------------------------------------------------------

console.log('drift tripwire')

check('an unknown driftMode is a config issue; valid values pass', () => {
  const issues = CONTRACT_CONFIG['~standard'].validate({ driftMode: 'ignore' }).issues
  assert.ok(issues.length > 0)
  assert.match(issues[0].message, /unknown driftMode/)
  assert.equal(CONTRACT_CONFIG['~standard'].validate({ driftMode: 'warn' }).value.driftMode, 'warn')
})

check('exact match against the shipped globals: activates normally', () => {
  const agent = mkAgent('session-a', '/w')
  const { disposePlugin } = installPlugin({ agents: [agent] })
  assert.deepEqual([...agent.__registeredTools.keys()].sort(), ['edit', 'write'])
  disposePlugin()
})

check('description drift: apply THROWS (default driftMode fail) naming the tool', () => {
  const globals = mkShippedGlobalTools(true)
  globals.edit.description = 'Edit an existing UTF-8 text file by replacing some text.'
  assert.throws(
    () => installPlugin({ toolsGlobals: globals }),
    (thrownError) => {
      assert.match(thrownError.message, /drift detected/)
      assert.match(thrownError.message, /edit\.description/)
      assert.match(thrownError.message, /maintenance\.md/)
      return true
    },
  )
})

check('parameter schema drift: apply THROWS with the diverging path', () => {
  const globals = mkShippedGlobalTools(true)
  globals.write.parameters.properties.content.description = 'Full text content.'
  assert.throws(
    () => installPlugin({ toolsGlobals: globals }),
    /write parameters\.parameters\.properties\.content\.description/,
  )
})

check('parameter key-order drift is caught (byte-identity promise)', () => {
  const globals = mkShippedGlobalTools(true)
  const properties = globals.edit.parameters.properties
  // Same entries, but old_string inserted before file_path.
  globals.edit.parameters.properties = {
    old_string: properties.old_string,
    file_path: properties.file_path,
    new_string: properties.new_string,
    replace_all: properties.replace_all,
    sandbox_permissions: properties.sandbox_permissions,
    justification: properties.justification,
  }
  assert.throws(() => installPlugin({ toolsGlobals: globals }), /edit parameters\.parameters\.properties keys/)
})

check('output schema drift (upstream adds a required field): apply THROWS', () => {
  const globals = mkShippedGlobalTools(true)
  globals.edit.output.schema.properties.checksum = { type: 'string' }
  globals.edit.output.schema.required = ['path', 'before', 'after', 'checksum']
  assert.throws(
    () => installPlugin({ toolsGlobals: globals }),
    (thrownError) => {
      assert.match(thrownError.message, /edit output\.required/)
      return true
    },
  )
})

check('driftMode warn: logs and still serves the frozen shadows', async () => {
  const globals = mkShippedGlobalTools(true)
  globals.write.parameters.properties.content.description = 'Changed upstream.'
  const agent = mkAgent('session-a', '/w')
  const { lines } = await captureConsoleError(async () => {
    const { disposePlugin } = installPlugin({ agents: [agent], toolsGlobals: globals, driftMode: 'warn' })
    assert.deepEqual([...agent.__registeredTools.keys()].sort(), ['edit', 'write'])
    disposePlugin()
  })
  assert.ok(lines.some((line) => line.includes('drift detected')))
})

check('rename/removal at boot (read present, edit/write gone): apply THROWS', () => {
  const globals = { read: mkShippedGlobalTools(true).read }
  assert.throws(
    () => installPlugin({ toolsGlobals: globals }),
    /renamed or removed upstream/,
  )
})

check('deployment without the fs tool suite: pending, no throw; late match keeps serving', async () => {
  const globals = {}
  const agent = mkAgent('session-a', '/w')
  const { result: installed } = await captureConsoleError(() => installPlugin({ agents: [agent], toolsGlobals: globals }))
  // pending: shadows serve meanwhile (registration predates any conclusion)
  assert.deepEqual([...agent.__registeredTools.keys()].sort(), ['edit', 'write'])
  Object.assign(globals, mkShippedGlobalTools(true))
  installed.pluginCtx.__eventBus.emit('tools/change')
  const lateAgent = mkAgent('session-late', '/w')
  installed.pluginCtx.__eventBus.emit('agent/created', { agent: lateAgent })
  assert.deepEqual([...lateAgent.__registeredTools.keys()].sort(), ['edit', 'write'])
  installed.disposePlugin()
})

check('late rename under fail mode: live shadows are disposed and new agents get none', async () => {
  const globals = {}
  const agent = mkAgent('session-a', '/w')
  const { result: installed, lines } = await captureConsoleError(async () => {
    const pendingInstall = installPlugin({ toolsGlobals: globals })
    pendingInstall.pluginCtx.__eventBus.emit('agent/created', { agent })
    assert.equal(agent.__registeredTools.size, 2)
    Object.keys(globals).forEach((toolName) => { delete globals[toolName] })
    globals.read = mkShippedGlobalTools(true).read
    pendingInstall.pluginCtx.__eventBus.emit('tools/change')
    assert.equal(agent.__registeredTools.size, 0, 'live shadows must be disposed on late drift')
    const lateAgent = mkAgent('session-late', '/w')
    pendingInstall.pluginCtx.__eventBus.emit('agent/created', { agent: lateAgent })
    assert.equal(lateAgent.__registeredTools.size, 0, 'disabled plugin must not register new shadows')
    return pendingInstall
  })
  assert.ok(lines.some((line) => line.includes('drift detected') && line.includes('disabled')))
  installed.disposePlugin()
})

// ---------------------------------------------------------------------------
// 9. Live standing-mode switches arm/disarm shadows for LIVE agents
// ---------------------------------------------------------------------------

console.log('live mode switches')

const emitModeSwitch = (pluginCtx, session, mode) => {
  pluginCtx.__eventBus.emit('session/event', session, {
    type: 'sandbox/mode',
    seq: 1,
    time: Date.now(),
    data: { mode },
  })
}

check('mid-session switch dfa -> workspace-write arms the LIVE agent immediately', () => {
  const agent = mkAgent('session-a', '/w')
  const { policyState, service } = mkSwitchableSandboxPolicy('danger-full-access')
  const { pluginCtx, disposePlugin } = installPlugin({
    agents: [agent],
    activeModes: ['read-only', 'workspace-write'],
    sandboxPolicyService: service,
  })
  assert.equal(agent.__registeredTools.size, 0, 'dfa stance must not arm at birth')
  policyState.mode = 'workspace-write'
  emitModeSwitch(pluginCtx, agent.session, 'workspace-write')
  assert.deepEqual([...agent.__registeredTools.keys()].sort(), ['edit', 'write'], 'switch must arm in place')
  disposePlugin()
})

check('switching back out disarms, and a later re-switch re-arms without duplicates', () => {
  const agent = mkAgent('session-a', '/w')
  const { policyState, service } = mkSwitchableSandboxPolicy('workspace-write')
  const { pluginCtx, disposePlugin } = installPlugin({
    agents: [agent],
    activeModes: ['read-only', 'workspace-write'],
    sandboxPolicyService: service,
  })
  assert.equal(agent.__registeredTools.size, 2)
  policyState.mode = 'danger-full-access'
  emitModeSwitch(pluginCtx, agent.session, 'danger-full-access')
  assert.equal(agent.__registeredTools.size, 0, 'leaving activeModes must disarm')
  policyState.mode = 'workspace-write'
  emitModeSwitch(pluginCtx, agent.session, 'workspace-write')
  assert.deepEqual([...agent.__registeredTools.keys()].sort(), ['edit', 'write'], 're-entry re-arms exactly once')
  disposePlugin()
})

check('a switch to read-only arms when read-only is active; to a non-active mode disarms', () => {
  const agent = mkAgent('session-a', '/w')
  const { policyState, service } = mkSwitchableSandboxPolicy('workspace-write')
  const { pluginCtx, disposePlugin } = installPlugin({
    agents: [agent],
    activeModes: ['read-only', 'workspace-write'],
    sandboxPolicyService: service,
  })
  policyState.mode = 'read-only'
  emitModeSwitch(pluginCtx, agent.session, 'read-only')
  assert.equal(agent.__registeredTools.size, 2)
  policyState.mode = 'workspace-write'
  emitModeSwitch(pluginCtx, agent.session, 'workspace-write')
  assert.equal(agent.__registeredTools.size, 2)
  disposePlugin()
})

check('a switch for a session with NO live agent is a no-op (no crash, no arming)', () => {
  const agent = mkAgent('session-a', '/w')
  const { pluginCtx, disposePlugin } = installPlugin({
    agents: [agent],
    standingMode: 'danger-full-access',
    activeModes: ['read-only'],
  })
  assert.equal(agent.__registeredTools.size, 0)
  emitModeSwitch(pluginCtx, { id: 'session-elsewhere', header: { cwd: '/w2' } }, 'read-only')
  assert.equal(agent.__registeredTools.size, 0, 'a foreign session switch must not arm this agent')
  disposePlugin()
})

check('unrelated session events never touch registration', () => {
  const agent = mkAgent('session-a', '/w')
  const { pluginCtx, disposePlugin } = installPlugin({
    agents: [agent],
    standingMode: 'danger-full-access',
    activeModes: ['read-only'],
  })
  assert.equal(agent.__registeredTools.size, 0)
  pluginCtx.__eventBus.emit('session/event', agent.session, { type: 'approval/policy', seq: 2, time: Date.now(), data: { policy: 'ask' } })
  pluginCtx.__eventBus.emit('session/event', agent.session, { type: 'compaction/summary', seq: 3, time: Date.now(), data: {} })
  assert.equal(agent.__registeredTools.size, 0, 'non-sandbox/mode events must not arm anything')
  disposePlugin()
})

check('a switch after plugin unload does nothing (listener removed)', () => {
  const agent = mkAgent('session-a', '/w')
  const { policyState, service } = mkSwitchableSandboxPolicy('danger-full-access')
  const { pluginCtx, disposePlugin } = installPlugin({
    agents: [agent],
    activeModes: ['read-only'],
    sandboxPolicyService: service,
  })
  disposePlugin()
  policyState.mode = 'read-only'
  emitModeSwitch(pluginCtx, agent.session, 'read-only')
  assert.equal(agent.__registeredTools.size, 0)
})

// ---------------------------------------------------------------------------
// 10. Reversibility
// ---------------------------------------------------------------------------

console.log('reversibility')

check('plugin unload removes every shadow from every agent', () => {
  const agentA = mkAgent('session-a', '/w')
  const agentB = mkAgent('session-b', '/w2')
  const { pluginCtx, disposePlugin } = installPlugin({ agents: [agentA, agentB] })
  const agentC = mkAgent('session-c', '/w3')
  pluginCtx.__eventBus.emit('agent/created', { agent: agentC })
  assert.equal(agentA.__registeredTools.size + agentB.__registeredTools.size + agentC.__registeredTools.size, 6)
  disposePlugin()
  assert.equal(agentA.__registeredTools.size, 0)
  assert.equal(agentB.__registeredTools.size, 0)
  assert.equal(agentC.__registeredTools.size, 0)
})

check('after unload, new agents get nothing (listener removed)', () => {
  const { pluginCtx, disposePlugin } = installPlugin({})
  disposePlugin()
  const lateAgent = mkAgent('session-late', '/w')
  pluginCtx.__eventBus.emit('agent/created', { agent: lateAgent })
  assert.equal(lateAgent.__registeredTools.size, 0)
})

check('agent/disposed prunes the tracking map (no stale disposers run later)', () => {
  const agent = mkAgent('session-a', '/w')
  const { pluginCtx, disposePlugin } = installPlugin({ agents: [agent] })
  pluginCtx.__eventBus.emit('agent/disposed', { agent })
  disposePlugin()
  // The agent had already lost its scope; the plugin disposer must not throw.
  assert.equal(pluginCtx.__eventBus.listenerCount('agent/created'), 0)
})

await runChecks()

console.log('\nplugin.test.mjs: ' + checksPassed + ' checks green')
