import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import lilac from '../dist/index.js'

const listen = () => new Promise(resolve => {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
      res.writeHead(200).end('{}')
    })
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` }))
})

test('a terminal capture sends OTLP spans to /v1/ingest/otlp with the key', async () => {
  const { server, received, url } = await listen()
  try {
    lilac.init({ agentId: 'test-agent', endpoint: `${url}/v1/`, apiKey: 'k' })
    const response = {
      model: 'gpt-test',
      created: Math.floor(Date.now() / 1000),
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello there.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }
    await lilac.capture(response, {
      input: [{ role: 'user', content: 'Hi' }],
      conversationId: 'c1', userId: 'u1', terminal: true,
    })

    assert.equal(received.length, 1)
    const { url: path, auth, body } = received[0]
    assert.equal(path, '/v1/ingest/otlp')
    assert.equal(auth, 'Bearer k')
    const scope = body.resourceSpans[0].scopeSpans[0]
    assert.equal(scope.scope.name, 'lilac-sdk')
    const names = scope.spans.map(s => s.name)
    assert.ok(names.includes('turn'))
    assert.ok(names.some(n => n.startsWith('chat')))
    const attrs = Object.fromEntries(scope.spans.flatMap(s => s.attributes).map(a => [a.key, a.value]))
    assert.deepEqual(attrs['gen_ai.conversation.id'], { stringValue: 'c1' })
    assert.deepEqual(attrs['user.id'], { stringValue: 'u1' })
    assert.deepEqual(attrs['gen_ai.usage.input_tokens'], { intValue: '12' })
  } finally {
    server.close()
  }
})
