# AI service reference implementation (Python)

Skeleton only. Not installed, not wired up, not run by CI.

```bash
python -m venv .venv
. .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

Then point the API at it:

```
AI_PROVIDER=http_service
AI_SERVICE_URL=http://localhost:8000
```

Every endpoint currently returns `501 Not Implemented`, and `/v1/capabilities`
reports `not_implemented` for everything. Implementing a capability means
training a real model and updating its capability entry to match what is
actually behind it.

See [../contract/ai-service.md](../contract/ai-service.md).
