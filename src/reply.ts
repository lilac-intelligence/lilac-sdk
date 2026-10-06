export interface ReplyFacts {
  text?: string
  requestModel?: string
  responseModel?: string
  provider?: string
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  createdAt?: number
  wordless: boolean
}

const s = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v : undefined
const n = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined

function textOf (r: Record<string, any>): string | undefined {
  const choice = Array.isArray(r.choices) ? r.choices[0] : undefined
  if (choice) return s(choice?.message?.content) ?? s(choice?.text)

  if (s(r.output_text)) return s(r.output_text)
  if (Array.isArray(r.output)) {
    const parts: string[] = []
    for (const item of r.output) {
      for (const block of Array.isArray(item?.content) ? item.content : []) {
        if (block?.type === 'output_text' && s(block.text)) parts.push(block.text)
      }
    }
    if (parts.length) return parts.join('')
  }

  if (Array.isArray(r.content)) {
    const parts = r.content.filter((b: any) => b?.type === 'text' && s(b.text)).map((b: any) => b.text)
    if (parts.length) return parts.join('')
  }
  return undefined
}

export function factsOf (response: unknown): ReplyFacts {
  const r = (response ?? {}) as Record<string, any>
  if (typeof r !== 'object') return { wordless: true }

  const usage = r.usage ?? {}
  const text = textOf(r)
  const finish = s(Array.isArray(r.choices) ? r.choices[0]?.finish_reason : undefined)
    ?? s(r.stop_reason) ?? s(r.status)

  const facts: ReplyFacts = {
    wordless: text === undefined,
    ...(text !== undefined ? { text } : {}),
    ...(s(r.model) ? { responseModel: s(r.model) } : {}),
    ...(finish ? { finishReason: finish } : {}),
    ...(n(usage.input_tokens ?? usage.prompt_tokens) !== undefined
      ? { inputTokens: n(usage.input_tokens ?? usage.prompt_tokens) } : {}),
    ...(n(usage.output_tokens ?? usage.completion_tokens) !== undefined
      ? { outputTokens: n(usage.output_tokens ?? usage.completion_tokens) } : {}),
    ...(n(r.created ?? r.created_at) !== undefined ? { createdAt: n(r.created ?? r.created_at) } : {}),
    ...(n(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens) !== undefined
      ? { cacheReadTokens: n(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens) } : {}),
    ...(n(usage.cache_creation_input_tokens) !== undefined
      ? { cacheWriteTokens: n(usage.cache_creation_input_tokens) } : {}),
    ...(n(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens) !== undefined
      ? { reasoningTokens: n(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens) } : {}),
  }

  if (Array.isArray(r.content) && s(r.stop_reason) !== undefined) facts.provider = 'anthropic'
  else if (Array.isArray(r.choices) || Array.isArray(r.output)) facts.provider = 'openai'
  return facts
}
