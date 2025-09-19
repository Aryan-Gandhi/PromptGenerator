# Prompt Transform Worker

Cloudflare Worker that accepts a raw prompt and returns a structured prompt by
calling an LLM (default: OpenAI `gpt-4o-mini`). It is designed to be called from
the Prompt Structurer browser extension.

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set your OpenAI API key for the dev environment:

   ```bash
   npx wrangler secret put OPENAI_API_KEY
   ```

3. Run the worker locally (defaults to <https://localhost:8787>):

   ```bash
   npm run dev
   ```

   Example request:

   ```bash
   curl -X POST http://127.0.0.1:8787/transform \
        -H "content-type: application/json" \
        -d '{"prompt":"Plan a team offsite","mode":"universal"}'
   ```

4. Deploy when ready:

   ```bash
   npm run deploy
   ```

## Environment variables

- `OPENAI_API_KEY` (secret): API key used to call OpenAI.
- `DEFAULT_MODEL` (plain text var, optional): override model name if you prefer
a different default than `gpt-4o-mini`.

## Response format

The worker responds with JSON:

```json
{
  "structuredPrompt": "Role: ...",
  "model": "gpt-4o-mini",
  "usage": {
    "totalTokens": 123
  }
}
```

If an error occurs, the worker returns an `error` field and additional metadata
(`status`, `retryable`, and in many cases the parsed upstream payload).

### Mock mode (no OpenAI key required)

Set **either** `MOCK_TRANSFORM=true` **or** `OPENAI_API_KEY=MOCK` to force the
worker to generate a structured scaffold locally. The response will include
`"mocked": true`, and the browser popup displays `Transformed with … (mock)` so
you can confirm offline mode is active. This is useful when developing without
network access or when you want deterministic fixtures for tests.

### Health endpoint & monitoring

- `GET /health` returns JSON with the latest success timestamp, the most recent
  error (if any), and whether the worker is running in mock mode. The endpoint
  responds with HTTP `503` when the worker has not completed a successful
  transform since the last failure.
- All failed upstream calls are logged via `console.error` and recorded for the
  health check, so you can inspect them with `wrangler tail` or any logging tool
  wired to Cloudflare Workers.
