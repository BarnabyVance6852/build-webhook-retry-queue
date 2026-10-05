export type BuildEvent = {
  eventId: string;
  buildId: string;
  project: string;
  status: "passed" | "failed";
  commitSha: string;
  webhookUrl: string;
};

export type DeliveryJob = {
  event: BuildEvent;
  attempt: number;
  notBefore: string;
};

export type DeliveryDecision =
  | { kind: "delivered"; attempts: number }
  | { kind: "retry"; next: DeliveryJob; delayMs: number }
  | { kind: "exhausted"; attempts: number };

export const MAX_ATTEMPTS = 5;

export function decideDelivery(
  job: DeliveryJob,
  delivered: boolean,
  nowMs: number
): DeliveryDecision {
  const attempts = job.attempt + 1;
  if (delivered) return { kind: "delivered", attempts };
  if (attempts >= MAX_ATTEMPTS) return { kind: "exhausted", attempts };

  const delayMs = Math.min(2_000 * 2 ** job.attempt, 30_000);
  return {
    kind: "retry",
    delayMs,
    next: {
      event: job.event,
      attempt: attempts,
      notBefore: new Date(nowMs + delayMs).toISOString()
    }
  };
}
