import { newId, type Span } from './spans.js'

export type StepKind =
  | 'retrieval' | 'memory' | 'reasoning' | 'delegation'
  | 'guardrail' | 'human_approval' | 'wait' | 'code_execution'

export interface StepDetails {
  name?: string
  action?: string
  subject?: string
  input?: unknown
  output?: unknown
  approver?: string
  category?: string
  reason?: string
  failed?: boolean
  language?: string
  exit?: number
  ms?: number
}

const STANDARD_OPERATION: Partial<Record<StepKind, string>> = {
  retrieval: 'retrieval',
  memory: 'search_memory',
  reasoning: 'plan',
  delegation: 'invoke_agent',
}

export function stepSpan (
  kind: StepKind, details: StepDetails, ctx: { traceId: string; conversationId: string; agentId: string; atNs: bigint; parentSpanId?: string },
): Span {
  const operation = STANDARD_OPERATION[kind]
  const name = details.name ?? kind
  const took = details.ms !== undefined && Number.isFinite(details.ms) ? BigInt(Math.max(0, Math.round(details.ms))) * 1_000_000n : 0n
  return {
    name: operation ? `${operation} ${name}`.trim() : `${kind} ${name}`.trim(),
    spanId: newId(8), traceId: ctx.traceId,
    ...(ctx.parentSpanId ? { parentSpanId: ctx.parentSpanId } : {}),
    startNs: ctx.atNs - took, endNs: ctx.atNs,
    attributes: {
      'gen_ai.conversation.id': ctx.conversationId,
      'gen_ai.agent.name': ctx.agentId,
      ...(operation ? { 'gen_ai.operation.name': operation } : {}),
      ...(operation ? {} : { 'lilac.event_type': kind }),
      'lilac.event.name': name,
      ...(details.action ? { 'lilac.event.action': details.action } : {}),
      ...(details.subject ? { 'lilac.event.subject': details.subject } : {}),
      ...(details.input !== undefined ? { 'lilac.event.input': details.input } : {}),
      ...(details.output !== undefined ? { 'lilac.event.output': details.output } : {}),
      ...(details.approver ? { 'lilac.human_approval.approver': details.approver } : {}),
      ...(kind === 'guardrail' && details.category ? { 'lilac.guardrail.category': details.category } : {}),
      ...(kind === 'wait' && (details.reason ?? details.category) ? { 'lilac.wait.reason': details.reason ?? details.category } : {}),
      ...(kind === 'code_execution' && details.language ? { 'lilac.code_execution.language': details.language } : {}),
      ...(kind === 'code_execution' && details.exit !== undefined && Number.isFinite(details.exit) ? { 'lilac.code_execution.exit': details.exit } : {}),
      ...(details.failed === true ? { 'lilac.status.code': 'error' } : {}),
      ...(details.ms === undefined
        ? {
            'lilac.inferred': {
              'span.start_time': { rule: 'not_timed', from: ['the caller did not time it'], basis: 'recorded when it finished, with no ms, so it has no duration of its own' },
            },
          }
        : {}),
    },
  }
}

export const STEP_KINDS: ReadonlySet<string> = new Set<StepKind>([
  'retrieval', 'memory', 'reasoning', 'delegation', 'guardrail', 'human_approval', 'wait', 'code_execution',
])
