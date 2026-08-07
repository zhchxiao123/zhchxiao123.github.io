# AI Chat Worker

Cloudflare Worker backend for the blog AI chat widget.

## Deploy

```bash
cd worker
# Login once
wrangler login

# Set the API key (choose one provider)
wrangler secret put GROQ_API_KEY
# or
wrangler secret put ANTHROPIC_API_KEY
# or
wrangler secret put OPENAI_API_KEY

# Deploy
wrangler deploy
```

## Optional KV for rate limiting

To enable per-IP rate limiting, create a KV namespace and bind it as `RATE_LIMIT`:

```bash
wrangler kv:namespace create "RATE_LIMIT"
# Then add the binding in wrangler.toml:
# [[kv_namespaces]]
# binding = "RATE_LIMIT"
# id = "<namespace-id>"
```

## Configuration

Edit `wrangler.toml` `[vars]` to change:

- `MODEL_PROVIDER`: `groq`, `anthropic`, or `openai`
- `MODEL_NAME`: e.g. `llama-3.3-70b-versatile`, `claude-3-5-haiku-20241022`, `gpt-4o-mini`
- `ALLOWED_ORIGINS`: comma-separated CORS origins
- `RATE_LIMIT_PER_HOUR`: max requests per IP per hour (requires KV binding)
- `MAX_MESSAGE_LENGTH`: max user message length

## Health check

```bash
curl https://<worker-subdomain>.workers.dev/api/health
```
