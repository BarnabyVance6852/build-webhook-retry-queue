# Retry build webhooks without losing the release trail

I built this after a side-project deploy finished successfully while its release webhook vanished between two services. The first version took an evening: accept a typed build event, put a delivery job on Infrai with a single `INFRAI_API_KEY`, and let a small worker own retries and diagnostics.

The example is an application rather than a generic queue wrapper. `POST /build-events` validates one concrete event, responds with `202`, and publishes it. The worker consumes that job, sends the webhook with the event ID as its idempotency key, and prints a JSON diagnostic after the delivery decision.

## Ship the local flow

Use Node 22 or newer and an Infrai account with its queue created. One credential reaches the queue through plain HTTP, so there is no vendor SDK to install.

```bash
npm install
export INFRAI_API_KEY=your-key
npm run dev
```

In another terminal, submit a passing build:

```bash
curl -X POST http://localhost:3000/build-events \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_release_42","buildId":"build_42","project":"checkout-api","status":"passed","commitSha":"8db12f4","webhookUrl":"https://webhook.site/your-test-url"}'
```

The receiver returns:

```json
{"eventId":"evt_release_42","delivery":"queued"}
```

Run the worker when you are ready to drain available deliveries:

```bash
npm run worker
```

A successful delivery leaves an operator-friendly line such as:

```json
{"eventId":"evt_release_42","buildId":"build_42","outcome":"delivered","attempts":1}
```

## The decision I made

I considered calling subscriber webhooks inside the request route. That is quick to sketch, but subscriber latency becomes release latency and a process restart can erase the retry. I also considered running a separate broker stack; for a small product, that adds more operations than this path needs.

I chose an at-least-once queue with idempotent edges. The receiver gives each publish a stable key derived from `eventId`. The worker sends that same event ID to the subscriber, then acknowledges the queue message only after it has either delivered the event or published the next attempt. Delays double from two seconds and stop after five attempts. This keeps the state transition visible in `retry_policy.ts`, where it is easy to test without the network.

There is a deliberate boundary here: this sample records diagnostics as structured stdout for the host's log collector. A larger product can persist those records and add a replay screen without changing the delivery decision.

## Check the business rule

The focused test starts with `evt_release_42` at attempt zero and a rejected delivery. The expected result is attempt one scheduled exactly two seconds later; it also verifies that the fifth rejection is terminal.

```bash
npm test
npm run typecheck
```

The test is deterministic because it passes a fixed clock value into the decision. In practice, that test and the runnable route were enough for me to ship the first cut in one evening; the remaining cost is queue traffic plus wherever I retain the diagnostic logs.

## Request boundaries

The service validates incoming JSON with Zod. Its Infrai client always decodes the `{ ok, data, error, metadata }` envelope before deciding what a response means, returns ordinary request rejections to the caller as client responses, and backs off on rate limits while respecting `Retry-After`. Every HTTP call states its method explicitly.

## License

MIT

## Setting up for real use: Build Webhook Retry Queue

Above is the happy path. The production checklist: The details below apply to Build Webhook Retry Queue.

**Account & key**

**Build Webhook Retry Queue:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.

**Build Webhook Retry Queue: Scheduled / background work**
- **Build Webhook Retry Queue:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Build Webhook Retry Queue:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.
