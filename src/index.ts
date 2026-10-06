import { AsyncLocalStorage } from 'node:async_hooks'

import { factsOf } from './reply.js'
import { newId, personsTurn, spansOf, toolSpan, type Span, type ToolDefinition } from './spans.js'
import { contextAttributes, countsOf, droppedBetween, identitiesOf } from './context.js'
import { stepSpan, STEP_KINDS, type StepDetails, type StepKind } from './record.js'
import { send, type SendResult } from './transport.js'
import { toolCallsOf, toolResultsOf, type DerivedToolCall, type Message, type ToolAnnotation } from './tool-calls.js'

export type { Message, ToolAnnotation, StepKind, StepDetails }

export interface InitOptions {
  agentId: string
  agentVersion?: string
  endpoint?: string
  apiKey?: string
  tools?: Record<string, ToolAnnotation>
  timeoutMs?: number
}

export interface CaptureOptions {
  input: readonly Message[]
  conversationId?: string
  systemPrompt?: string
  tools?: unknown
  userId?: string
  terminal?: boolean
  advanced?: { redact?: (span: Span) => Span | null; wait?: boolean }
}

const CONVERSATIONS_HELD = 10_000
const WARNINGS_KEPT = 64

interface Held {
  traceId: string
  lastEndNs: bigint
  awaited: DerivedToolCall[]
  steps: Span[]
  window: string[]
  notes: Record<string, ToolAnnotation>
  lastPersonText?: string
}

class Lilac {
  private agentId = ''
  private agentVersion: string | undefined
  private endpoint = ''
  private apiKey: string | undefined
  private annotations: Record<string, ToolAnnotation> = {}
  private timeoutMs = 5_000
  private started = false

  private traces = new Map<string, Held>()
  private queue: { conversationId: string; spans: Span[] }[] = []
  private said = new Set<string>()

  private warnOnce (key: string, message: string): void {
    if (this.said.has(key)) return
    if (this.said.size >= WARNINGS_KEPT) return
    this.said.add(key)
    try { console.warn(`[lilac] ${message}`) } catch { }
  }

  private hold (conversationId: string, held: Held): void {
    this.traces.delete(conversationId)
    this.traces.set(conversationId, held)
    while (this.traces.size > CONVERSATIONS_HELD) {
      const oldest = this.traces.keys().next()
      if (oldest.done) break
      this.traces.delete(oldest.value)
    }
  }

  init (opts: InitOptions): void {
    this.agentId = opts.agentId
    this.agentVersion = opts.agentVersion ?? process.env.LILAC_AGENT_VERSION
    this.endpoint = (opts.endpoint ?? process.env.LILAC_ENDPOINT ?? '')
      .replace(/\/+$/, '')
      .replace(/\/v1$/, '')
    this.apiKey = opts.apiKey ?? process.env.LILAC_INGEST_KEY
    this.annotations = opts.tools ?? {}
    if (opts.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs
    if (!this.endpoint) {
      this.warnOnce('endpoint', 'no endpoint: pass endpoint= to init(), or set LILAC_ENDPOINT. '
        + 'Nothing will be sent. This build has no default — your sessions go to your own '
        + 'deployment and nowhere else.')
    }

    if (!this.started) {
      this.started = true
      try { process.once('beforeExit', () => { this.sealAll(); void this.flush() }) } catch { }
    }
  }

  async conversation<T> (conversationId: string, fn: () => Promise<T>): Promise<T> {
    return this.inside.run(conversationId, fn)
  }

  private readonly inside = new AsyncLocalStorage<string>()
  private get scoped (): string | undefined { return this.inside.getStore() }

  async capture (response: unknown, opts: CaptureOptions): Promise<void> {
    try {
      const conversationId = opts.conversationId ?? this.scoped ?? newId(16)
      const held: Held = this.traces.get(conversationId)
        ?? { traceId: newId(16), lastEndNs: 0n, awaited: [], steps: [], window: [], notes: {} }

      const reply = factsOf(response)
      const endNs = BigInt(Date.now()) * 1_000_000n

      const openedNs = held.lastEndNs > 0n ? held.lastEndNs : endNs

      const window = identitiesOf(opts.input ?? [])
      const counts = countsOf(opts.input, opts.systemPrompt)
      if (counts) {
        const dropped = droppedBetween(held.window, window)
        if (dropped !== null) counts.droppedMessages = dropped
      }

      const notes = { ...this.annotations, ...annotationsFrom(opts.tools) }
      const definitions = definitionsFrom(opts.tools, this.annotations)

      const spans = spansOf({
        conversationId, agentId: this.agentId, traceId: held.traceId,
        messages: opts.input, reply,
        asked: toolCallsOf(response),
        awaited: held.awaited,
        results: toolResultsOf(opts.input),
        annotations: notes,
        ...(this.agentVersion ? { agentVersion: this.agentVersion } : {}),
        ...(held.lastPersonText !== undefined ? { lastPersonText: held.lastPersonText } : {}),
        ...(definitions.length ? { toolDefinitions: definitions } : {}),
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
        ...(opts.userId ? { userId: opts.userId } : {}),
        ...(opts.userId ? {} : (this.warnOnce('userId',
          'no userId on this capture. Sessions will be read and measured exactly as usual, '
          + 'but nothing can be followed between them: a returning requester cannot be '
          + 'recognised, and the pages about people stay empty. Pass userId to capture() with '
          + 'whatever you already call that person — an id, a hash, an account — it is never '
          + 'shown back to them.'), {})),
        ...(opts.terminal ? { terminal: opts.terminal } : {}),
        ...(held.steps.length ? { steps: held.steps } : {}),
        endNs, openedNs,
      })

      this.hold(conversationId, {
        traceId: held.traceId, lastEndNs: endNs, awaited: toolCallsOf(response), steps: [], window, notes,
        ...((personsTurn(opts.input) ?? held.lastPersonText) !== undefined
          ? { lastPersonText: personsTurn(opts.input) ?? held.lastPersonText } : {}),
      })

      if (counts) {
        const chat = spans.find(sp => sp.attributes['gen_ai.operation.name'] === 'chat')
        if (chat) Object.assign(chat.attributes, contextAttributes(counts))
      }

      if (opts.terminal) {
        spans.push(...this.seal(conversationId))
        this.traces.delete(conversationId)
      }

      const redact = opts.advanced?.redact

      const kept = redact ? spans.map(s => { try { return redact(s) } catch { this.warnOnce('redact', 'the redactor threw; that span was dropped and not sent'); return null } }).filter((s): s is Span => s !== null) : spans
      this.queue.push({ conversationId, spans: kept })
      if (opts.terminal || opts.advanced?.wait) await this.flush()
      else void this.flush()
    } catch (err) {
      this.warnOnce('capture', `a session was not captured: ${String(err).slice(0, 160)}`)
    }
  }

  record (kind: StepKind, details: StepDetails = {}, conversationId?: string): void {
    try {
      if (!STEP_KINDS.has(kind)) {
        this.warnOnce('kind', `"${kind}" is not a kind of step this records; it was ignored. `
          + `Known: ${[...STEP_KINDS].join(', ')}.`)
        return
      }
      const id = conversationId ?? this.scoped
      if (!id) {
        this.warnOnce('record:scope', 'record() outside a conversation and with no conversationId: '
          + 'the step was dropped because nothing says which session it belongs to.')
        return
      }
      const held: Held = this.traces.get(id)
        ?? { traceId: newId(16), lastEndNs: 0n, awaited: [], steps: [], window: [], notes: {} }
      held.steps.push(stepSpan(kind, details, {
        traceId: held.traceId, conversationId: id, agentId: this.agentId,
        atNs: BigInt(Date.now()) * 1_000_000n,
      }))
      this.hold(id, held)
    } catch (err) {
      this.warnOnce('record', `a step was not recorded: ${String(err).slice(0, 160)}`)
    }
  }

  private seal (conversationId: string): Span[] {
    const held = this.traces.get(conversationId)
    if (!held || (!held.awaited.length && !held.steps.length)) return []
    const out = held.awaited.map(call => toolSpan(call, undefined, held.notes[call.name] ?? this.annotations[call.name], {
      traceId: held.traceId, conversationId, agentId: this.agentId,
      atNs: held.lastEndNs > 0n ? held.lastEndNs : BigInt(Date.now()) * 1_000_000n,
    }))
    out.push(...held.steps)
    this.traces.set(conversationId, { ...held, awaited: [], steps: [] })
    return out
  }

  private sealAll (): void {
    for (const conversationId of [...this.traces.keys()]) {
      const spans = this.seal(conversationId)
      if (spans.length) this.queue.push({ conversationId, spans })
    }
  }

  async flush (): Promise<void> {
    const batch = this.queue.splice(0, this.queue.length)
    if (!batch.length || !this.endpoint) return
    const spans = batch.flatMap(b => b.spans)
    const result = await send(this.endpoint, this.apiKey, this.agentId, spans, this.timeoutMs)
    if (!result.ok) this.warnOnce(`send:${result.status ?? 'unreachable'}`, sendFailure(result))
  }
}

function sendFailure (result: SendResult): string {
  const tail = ' These spans are dropped and not retried; your agent is unaffected.'
  if (result.status === 401 || result.status === 403) {
    return `the deployment refused the key (${result.status}). Check apiKey on init(), or `
      + `LILAC_INGEST_KEY, against LILAC_INGEST_KEY on the deployment.${tail}`
  }
  if (result.status === 404) {
    return 'the deployment has no ingest route at this endpoint (404). endpoint should be the '
      + `base URL — the SDK appends /v1/ingest/otlp itself.${tail}`
  }
  if (result.status === 413) {
    return 'the deployment refused the batch as too large (413). Capture more often, or raise '
      + `the deployment's body limit.${tail}`
  }
  if (result.status !== undefined) {
    return `the deployment answered ${result.status}.${tail}`
  }
  return `the deployment could not be reached (${result.error}). Check endpoint, and that `
    + `timeoutMs is long enough for the round trip.${tail}`
}

function definitionsFrom (tools: unknown, standing: Record<string, ToolAnnotation>): ToolDefinition[] {
  const out: ToolDefinition[] = []
  const named = new Set<string>()
  for (const t of Array.isArray(tools) ? tools : []) {
    const bag = (t as { function?: Record<string, unknown> })?.function ?? (t as Record<string, unknown>)
    const name = typeof bag?.name === 'string' ? bag.name : undefined
    if (!name) continue
    const own = (t as Record<string, unknown>) ?? {}
    const str = (k: string): string | undefined => {
      for (const from of [bag, own, standing[name] as Record<string, unknown> | undefined]) {
        const v = from?.[k]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
      return undefined
    }
    named.add(name)
    out.push({
      name,
      ...(str('description') ? { description: str('description')! } : {}),
      ...(str('effect') ? { effect: str('effect')! } : {}),
      ...(str('action') ? { action: str('action')! } : {}),
      ...((str('gated_by') ?? str('gate')) ? { gated_by: (str('gated_by') ?? str('gate'))! } : {}),
    })
  }

  for (const [name, note] of Object.entries(standing)) {
    if (named.has(name)) continue
    const keep = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined
    const gate = keep(note?.gated_by) ?? keep((note as Record<string, unknown> | undefined)?.['gate'])
    if (!keep(note?.effect) && !keep(note?.action) && !gate) continue
    out.push({
      name,
      ...(keep(note.effect) ? { effect: keep(note.effect)! } : {}),
      ...(keep(note.action) ? { action: keep(note.action)! } : {}),
      ...(gate ? { gated_by: gate } : {}),
    })
  }
  return out
}

function annotationsFrom (tools: unknown): Record<string, ToolAnnotation> {
  const out: Record<string, ToolAnnotation> = {}
  for (const t of Array.isArray(tools) ? tools : []) {
    const bag = (t as { function?: Record<string, unknown> })?.function ?? (t as Record<string, unknown>)
    const name = typeof bag?.name === 'string' ? bag.name : undefined
    if (!name) continue
    const note: ToolAnnotation = {}
    for (const k of ['effect', 'action', 'gated_by'] as const) {
      if (typeof bag[k] === 'string') note[k] = bag[k] as string
    }
    if (Object.keys(note).length) out[name] = note
  }
  return out
}

const lilac = new Lilac()
export default lilac
export { lilac }
export type { Span }
