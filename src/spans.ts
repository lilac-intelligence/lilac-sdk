import { randomBytes } from 'node:crypto'
import type { DerivedToolCall, Message, ToolAnnotation } from './tool-calls.js'
import type { ReplyFacts } from './reply.js'

export interface ToolDefinition {
  name: string
  description?: string
  effect?: string
  action?: string
  gated_by?: string
}

export interface Span {
  name: string
  spanId: string
  traceId: string
  parentSpanId?: string
  startNs: bigint
  endNs: bigint
  attributes: Record<string, unknown>
}

export interface EmitInput {
  conversationId: string
  agentId: string
  traceId: string
  messages: readonly Message[] | undefined
  reply: ReplyFacts
  asked: readonly DerivedToolCall[]
  awaited: readonly DerivedToolCall[]
  results: ReadonlyMap<string, string>
  annotations: Record<string, ToolAnnotation>
  toolDefinitions?: readonly ToolDefinition[]
  agentVersion?: string
  lastPersonText?: string
  systemPrompt?: string
  userId?: string
  terminal?: boolean
  steps?: readonly Span[]
  endNs: bigint
  openedNs: bigint
}

export const newId = (bytes: number): string => randomBytes(bytes).toString('hex')

const textOf = (m: Message | undefined): string | undefined => {
  const c = m?.content
  if (typeof c === 'string' && c.trim()) return c
  if (!Array.isArray(c)) return undefined
  const said = c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
    .map((b: any) => b.text as string)
  return said.length ? said.join('\n') : undefined
}

const isPersons = (m: Message | undefined): boolean => {
  if (!['user', 'human', 'customer'].includes(String(m?.role ?? '').toLowerCase())) return false
  const c = m?.content
  if (Array.isArray(c) && c.length && c.every((b: any) => b?.type === 'tool_result')) return false
  return true
}

export function personsTurn (messages: readonly Message[] | undefined): string | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (isPersons(messages![i])) return textOf(messages![i])
  }
  return undefined
}

const standardMessage = (role: string, text: string) => ({ role, parts: [{ type: 'text', content: text }] })

const NANOS_PER_MILLISECOND = 1_000_000n
const CREDIBLE_FROM_MS = 1_577_836_800_000

function callStartNs (createdAt: number | undefined, endNs: bigint): bigint | undefined {
  if (createdAt === undefined || !Number.isFinite(createdAt)) return undefined
  const ms = createdAt > 1e12 ? createdAt : createdAt * 1000
  if (ms < CREDIBLE_FROM_MS) return undefined
  const at = BigInt(Math.round(ms)) * NANOS_PER_MILLISECOND
  return at < endNs ? at : undefined
}

const earliest = (times: readonly bigint[]): bigint | undefined =>
  times.reduce<bigint | undefined>((low, t) => (low === undefined || t < low ? t : low), undefined)

export function spansOf (input: EmitInput): Span[] {
  const out: Span[] = []
  const { traceId, conversationId, agentId } = input
  const common = {
    'gen_ai.conversation.id': conversationId,
    'gen_ai.agent.name': agentId,
    ...(input.agentVersion ? { 'gen_ai.agent.version': input.agentVersion } : {}),
    ...(input.userId ? { 'user.id': input.userId } : {}),
  }

  const calledNs = callStartNs(input.reply.createdAt, input.endNs)
  const firstKnownNs = earliest([
    ...(calledNs !== undefined ? [calledNs] : []),
    ...(input.steps ?? []).map(s => s.startNs),
  ])
  const openedNs = input.openedNs < input.endNs || firstKnownNs === undefined
    || firstKnownNs > input.openedNs
    ? input.openedNs
    : firstKnownNs
  const chatOpenedNs = calledNs === undefined ? input.endNs
    : calledNs < openedNs ? openedNs : calledNs

  const said = personsTurn(input.messages)
  let personSpanId: string | undefined

  if (said !== undefined && said !== input.lastPersonText) {
    personSpanId = newId(8)
    out.push({
      name: 'turn', spanId: personSpanId, traceId,
      startNs: openedNs, endNs: openedNs,
      attributes: {
        ...common,
        'gen_ai.input.messages': [standardMessage('user', said)],
        'lilac.turn': 'user',
      },
    })
  }

  const agentTurnId = newId(8)

  const agentTurnEmitted = input.reply.text !== undefined || input.terminal
  const under = agentTurnEmitted ? agentTurnId : personSpanId

  if (agentTurnEmitted) {
    out.push({
      name: 'turn', spanId: agentTurnId, traceId,
      ...(personSpanId ? { parentSpanId: personSpanId } : {}),
      startNs: openedNs, endNs: input.endNs,
      attributes: {
        ...common,
        ...(input.reply.text !== undefined
          ? { 'gen_ai.output.messages': [standardMessage('assistant', input.reply.text)] }
          : {}),
        'lilac.turn': 'agent',
        ...(input.terminal ? { 'lilac.conversation.terminal': true } : {}),
      },
    })
  }

  out.push({
    name: `chat ${input.reply.requestModel ?? input.reply.responseModel ?? 'model'}`.trim(),
    spanId: newId(8), traceId,
    ...(under ? { parentSpanId: under } : {}),
    startNs: chatOpenedNs, endNs: input.endNs,
    attributes: {
      ...common,
      'gen_ai.operation.name': 'chat',
      ...(calledNs === undefined
        ? {
            'lilac.inferred': {
              'span.start_time': {
                rule: 'not_timed',
                from: ['the response, which carried no creation time'],
                basis: 'the call was captured after it returned, so only its end is known',
              },
            },
          }
        : calledNs < openedNs
          ? {
              'lilac.inferred': {
                'span.start_time': {
                  rule: 'held_to_the_turn',
                  from: ['the creation time on the response', 'the end of the turn before this one'],
                  basis: 'the creation time the provider sent is whole seconds, and it fell before '
                    + 'this turn opened, so the turn\'s own opening is used instead',
                },
              },
            }
          : {}),
      ...(input.reply.provider ? { 'gen_ai.provider.name': input.reply.provider } : {}),
      ...(input.reply.requestModel ? { 'gen_ai.request.model': input.reply.requestModel } : {}),
      ...(input.reply.responseModel ? { 'gen_ai.response.model': input.reply.responseModel } : {}),
      ...(input.reply.finishReason ? { 'gen_ai.response.finish_reasons': [input.reply.finishReason] } : {}),
      ...(input.reply.inputTokens !== undefined ? { 'gen_ai.usage.input_tokens': input.reply.inputTokens } : {}),
      ...(input.reply.outputTokens !== undefined ? { 'gen_ai.usage.output_tokens': input.reply.outputTokens } : {}),
      ...(input.reply.cacheReadTokens !== undefined ? { 'gen_ai.usage.cache_read.input_tokens': input.reply.cacheReadTokens } : {}),
      ...(input.reply.cacheWriteTokens !== undefined ? { 'gen_ai.usage.cache_write.input_tokens': input.reply.cacheWriteTokens } : {}),
      ...(input.reply.reasoningTokens !== undefined ? { 'gen_ai.usage.reasoning.output_tokens': input.reply.reasoningTokens } : {}),
      ...(input.systemPrompt ? { 'gen_ai.system_instructions': input.systemPrompt } : {}),
      ...(input.toolDefinitions?.length ? { 'gen_ai.tool.definitions': input.toolDefinitions } : {}),
    },
  })

  for (const call of input.awaited) {
    out.push(toolSpan(call, input.results.get(call.id), input.annotations[call.name], {
      traceId, conversationId, agentId, atNs: openedNs,
      ...(under ? { parentSpanId: under } : {}),
    }))
  }

  for (const step of input.steps ?? []) {
    out.push(under && step.parentSpanId === undefined ? { ...step, parentSpanId: under } : step)
  }
  return out
}

export function toolSpan (
  call: DerivedToolCall, result: string | undefined, note: ToolAnnotation | undefined,
  ctx: { traceId: string; conversationId: string; agentId: string; atNs: bigint; parentSpanId?: string },
): Span {
  return {
    name: `execute_tool ${call.name}`,
    spanId: newId(8), traceId: ctx.traceId,
    ...(ctx.parentSpanId ? { parentSpanId: ctx.parentSpanId } : {}),
    startNs: ctx.atNs, endNs: ctx.atNs,
    attributes: {
      'gen_ai.conversation.id': ctx.conversationId,
      'gen_ai.agent.name': ctx.agentId,
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': call.name,
      'gen_ai.tool.call.id': call.id,
      ...(call.args !== undefined ? { 'gen_ai.tool.call.arguments': call.args } : {}),
      ...(result !== undefined ? { 'gen_ai.tool.call.result': result } : {}),
      ...(note?.action ? { 'lilac.event.action': note.action } : {}),
      'lilac.inferred': {
        'gen_ai.tool.name': {
          rule: 'asked_for_in_the_reply',
          from: ['the reply that asked for it', 'the result in the next call'],
          basis: 'no step was recorded for this call',
        },
        'span.end_time': {
          rule: 'not_timed',
          from: ['the reply that asked for it'],
          basis: 'no step was recorded for this call, so nothing timed how long it ran',
        },
      },
    },
  }
}
