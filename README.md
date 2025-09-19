# PromptGenerator

This repository contains two cooperating packages:

- **`prompt-structurer`** – the browser extension (Vite + React) that restructures prompts before they are sent to an LLM UI.
- **`prompt-transform-worker`** – a Cloudflare Worker that performs the LLM-powered transformation (with a built-in mock mode for offline development).

```
prompt-structurer/         # Extension source
prompt-transform-worker/   # Cloudflare Worker source
```

## Quick start

```bash
# One-time dependency installation
npm run setup

# Start the extension and worker in parallel (Ctrl+C to stop)
npm run dev

# Build the production extension bundle
npm run build:extension

# Deploy the worker (build + wrangler deploy)
npm run deploy

# Run unit tests for both packages
npm run test
```

For convenience, the repository root `package.json` exposes these shared scripts (`setup`, `dev`, `deploy`, `build:extension`, `deploy:worker`, `dev:worker`, `test`).

## Mocking the LLM (offline mode)

The worker can bypass OpenAI and return a deterministic scaffold derived from the raw prompt. Set one of the following when running or deploying the worker:

- `MOCK_TRANSFORM=true`
- `OPENAI_API_KEY=MOCK`

When mock mode is active the popup status line shows `Transformed with … (mock)` so you can tell the output came from the local rules rather than the real LLM.

## Tests and CI

- Extension tests: `npm --prefix prompt-structurer run test`
- Worker tests: `npm --prefix prompt-transform-worker run test`
- Repository-level command (`npm run test`) runs both suites.
- GitHub Actions workflow at `.github/workflows/ci.yml` installs dependencies and executes the combined test command on every push/PR to `main`/`master`.

## Additional docs

Each package has its own README with more detail about configuration, deployment, and environment variables. Start with:

- [`prompt-structurer/README.md`](prompt-structurer/README.md)
- [`prompt-transform-worker/README.md`](prompt-transform-worker/README.md)
