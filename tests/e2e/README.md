# End-to-end tests

**Status: scaffolded, not running.** Playwright is not installed — it pulls
browser binaries (hundreds of MB) that this phase does not need, and an E2E
suite that asserts on empty states has little to protect yet.

`dashboard.spec.ts` is a real, runnable spec once Playwright is added. It is
excluded from `npm run test` (Vitest) and from `npm run typecheck`, so its
imports do not fail the build while the dependency is absent.

## Enabling it

```bash
npm i -D @playwright/test
npx playwright install chromium
npx playwright test
```

`playwright.config.ts` in this directory starts both the API and the web app
before the run.

## What E2E covers here, and what it does not

E2E owns the workflows a user actually performs across process boundaries:

- The dashboard loads and reaches the API.
- Strategies registered in the backend appear in the UI without frontend changes.
- Demo-mode and uncalibrated-confidence labelling is visible, not just present
  in a JSON response — the honesty guarantees are user-facing, so they need a
  user-facing test.
- Unconfigured integrations render empty states, never fabricated numbers.

It does **not** re-test indicator maths, strategy logic, confidence scoring or
risk rules. Those are unit-tested where they live, deterministically and in
milliseconds. See [docs/testing-strategy.md](../../docs/testing-strategy.md).
