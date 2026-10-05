import assert from "node:assert/strict";
import test from "node:test";
import { decideDelivery, type DeliveryJob } from "../src/retry_policy";

const start = Date.parse("2026-01-15T12:00:00.000Z");
const firstAttempt: DeliveryJob = {
  event: {
    eventId: "evt_release_42",
    buildId: "build_42",
    project: "checkout-api",
    status: "passed",
    commitSha: "8db12f4",
    webhookUrl: "https://hooks.example.com/builds"
  },
  attempt: 0,
  notBefore: new Date(start).toISOString()
};

test("a rejected delivery becomes a delayed second attempt", () => {
  assert.deepEqual(decideDelivery(firstAttempt, false, start), {
    kind: "retry",
    delayMs: 2_000,
    next: {
      event: firstAttempt.event,
      attempt: 1,
      notBefore: "2026-01-15T12:00:02.000Z"
    }
  });
});

test("the fifth rejection records exhaustion instead of another publish", () => {
  assert.deepEqual(decideDelivery({ ...firstAttempt, attempt: 4 }, false, start), {
    kind: "exhausted",
    attempts: 5
  });
});
