# lilac-sdk

Reports an AI agent's sessions to a [Lilac](https://trylilac.ai) deployment.

You make your model call exactly as you do now, then hand the response to `capture`. There is no
wrapper around your provider client and nothing on your agent's critical path unless you ask for it.

- No dependencies. Node builtins only.
- Node 20 or later. ESM only.
- Sends OpenTelemetry (OTLP/JSON) spans using the GenAI semantic conventions.
- Reads OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages responses.
- Never throws into your code. Failures warn once on the console and your agent carries on.

## Install

```bash
npm install lilac-sdk
```

## Quickstart

```ts
import lilac from 'lilac-sdk'
import OpenAI from 'openai'

const openai = new OpenAI()

lilac.init({
  agentId: 'support',                        // which agent these sessions belong to
  endpoint: process.env.LILAC_ENDPOINT,      // your deployment's base URL
  apiKey: process.env.LILAC_INGEST_KEY,      // your deployment's ingest key
})

const response = await openai.chat.completions.create({ model, messages, tools })

await lilac.capture(response, {
  input: messages,               // the messages as sent, including tool results
  conversationId: sessionId,     // groups turns into one session
  userId: accountId,             // who is on the other side
  tools,                         // the tool definitions you passed to the provider
})
```

## The whole surface

Five methods.

| Method | When |
|---|---|
| `init(options)` | once at startup |
| `capture(response, options)` | after each model call |
| `record(kind, details?, conversationId?)` | for a step that was not a model call |
| `conversation(id, fn)` | run `fn` with a conversation id in scope; returns what `fn` returns |
| `flush()` | send what is queued |

### `init`

```ts
lilac.init({
  agentId: 'support',                        // required
  agentVersion: process.env.GIT_SHA,         // or LILAC_AGENT_VERSION: lets trends tell a deploy from a traffic shift
  endpoint: 'https://lilac.example.com',     // or LILAC_ENDPOINT
  apiKey: process.env.LILAC_INGEST_KEY,      // or LILAC_INGEST_KEY
  tools: { issue_refund: { effect: 'irreversible', gated_by: 'manager approval' } },
  timeoutMs: 5_000,                          // per send; 5s if omitted
})
```

`endpoint` is the deployment's base URL. A trailing slash and a trailing `/v1` are both stripped;
the SDK appends `/v1/ingest/otlp` itself.

There is no default endpoint compiled in. With none set, the SDK warns once and sends nothing.

A flush is attempted on `beforeExit`. A process killed by a signal gets no such chance, so call
`flush()` from your own shutdown handler.

### `capture`

Pass the provider's response object as it came back, plus the messages you sent.

```ts
await lilac.capture(response, {
  input: messages,               // required
  conversationId: sessionId,     // or use conversation(); otherwise a new id per call
  systemPrompt: SYSTEM_PROMPT,
  tools: TOOL_DEFINITIONS,       // the array you passed to the provider
  userId: accountId,
  terminal: true,                // this was the last turn: send now rather than in the background
})
```

- **`input`** is what makes the turn legible: what the person asked, what came back from tools,
  what was dropped from the context window between turns. Pass the array you actually sent.
- **`userId`** is the only way sessions can be followed from one to the next. Without it every
  session is still read and measured as usual, but a returning person cannot be recognised. Pass
  whatever you already call them: an id, a hash, an account number. The SDK warns once if it is
  missing.
- **`tools`** are sent on as tool definitions, which is how Lilac knows what the agent was allowed
  to do and not only what it did. Without them, two checks go quiet: telling a call to a tool the
  agent never had from a call that failed, and checking that an irreversible action was gated.
- **`terminal`** awaits the send and closes the session exactly, rather than waiting for the
  deployment's quiet window. Without it `capture` returns immediately and sends in the background.
  Because it awaits, a slow or unreachable deployment delays that one `capture` by up to
  `timeoutMs`. That is the only place the SDK is ever on your agent's critical path.

Tool calls are read off the response object. A call is sent with the turn that carries its result,
which is the following `capture`. On a terminal turn, and on process exit, any call still waiting
is sent without a result rather than dropped.

The model call is timed from the creation time the provider returns (`created`, or `created_at` on
a Responses object). A response without one is marked untimed rather than stretched across the turn.

### `record`

For steps that are not model calls. Eight kinds:

```
retrieval   memory   reasoning   delegation   guardrail   human_approval   wait   code_execution
```

```ts
lilac.record('retrieval', { name: 'policy_docs', ms: 84, output: hits })
lilac.record('guardrail', { name: 'pii_filter', category: 'pii', failed: true })
lilac.record('human_approval', { name: 'refund_over_500', approver: 'on-call' })
lilac.record('wait', { name: 'awaiting_customer', reason: 'reply', ms: 91_000 })
lilac.record('code_execution', { name: 'sandbox', language: 'python', exit: 0, ms: 240 })
```

Details, all optional: `name`, `action`, `subject`, `input`, `output`, `approver`, `category`,
`reason`, `failed`, `ms`, `language`, `exit`. `category` is read on `guardrail`, `reason` on
`wait`, and `language` and `exit` on `code_execution`; the rest are read on every kind.

- Give **`ms`** when you have it. It is counted back from the moment you call `record`. A step
  without it is marked untimed rather than instant.
- **`output` is what the step returned, not a count of it.** On a retrieval, pass the hits
  themselves. Their ids, titles and urls are what the agent's later citations are checked against;
  `output: hits.length` reads as nothing retrieved.
- **`failed: true`** marks the step as an error.

Recorded steps are held and attached to the next `capture` on that conversation, so call `record`
before the model call that follows them. Steps still waiting when a turn is marked `terminal`, or
when the process exits, are sent on their own. A step with no `conversationId` and no surrounding
`conversation()` is dropped with a warning, because nothing says which session it belongs to.

### `conversation`

Sets the conversation id for everything inside, so it does not have to be threaded through every
call. An explicit `conversationId` argument always wins.

```ts
await lilac.conversation(sessionId, async () => {
  lilac.record('retrieval', { name: 'policy_docs', output: hits })
  await lilac.capture(response, { input: messages })
})
```

### `flush`

```ts
await lilac.flush()
```

Sends everything queued. Call it before a process ends in a way `beforeExit` will not catch: a
signal, a serverless freeze, a container killed with `SIGKILL`. The SDK installs no signal handlers
of its own.

A send that fails is not retried. Those spans are dropped and the console carries one warning for
each distinct way the send failed, so an hour-long outage does not fill your logs. Your agent is
unaffected either way.

## Tool annotations

Lilac cannot tell a tool that looked something up from one that moved money by its name. Annotate
the ones where it matters, in `init` or inline on the tool definitions you pass to `capture`:

| Field | Meaning |
|---|---|
| `effect` | `read_only`, `writes`, or `irreversible` |
| `action` | the verb, if the name does not carry it |
| `gated_by` | the approval that stands in front of it (`gate` is accepted as an alias) |

```ts
lilac.init({
  agentId: 'support',
  tools: {
    lookup_order: { effect: 'read_only' },
    issue_refund: { effect: 'irreversible', gated_by: 'manager approval' },
  },
})
```

Unannotated tools are still measured; less can be said about them.

## Redaction

To drop or rewrite spans before they leave your process:

```ts
await lilac.capture(response, {
  input: messages,
  advanced: {
    redact: span => {
      if (span.attributes['gen_ai.agent.name'] === 'internal') return null   // drop it
      return span
    },
    wait: true,   // await the send without marking the turn terminal
  },
})
```

`redact` runs on every span after it is built and before it is queued. Returning `null` drops the
span. If the redactor throws, that span is dropped and not sent, with a warning.

This is the only redaction in the path. Nothing is dropped or rewritten after a span reaches the
deployment.

## Without the SDK

Any OpenTelemetry exporter that speaks OTLP/JSON over HTTP can send to
`POST <endpoint>/v1/ingest/otlp` with `authorization: Bearer <ingest key>`, using the
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). That is how to
report from Python or any other language.

## License

MIT
