import { z } from "zod";
import { infraiFromEnvironment } from "./infrai_queue";
import { decideDelivery, type DeliveryJob } from "./retry_policy";

const messageSchema = z.object({
  message_id: z.string(),
  payload: z.object({
    event: z.object({
      eventId: z.string(),
      buildId: z.string(),
      project: z.string(),
      status: z.enum(["passed", "failed"]),
      commitSha: z.string(),
      webhookUrl: z.string().url()
    }),
    attempt: z.number().int().nonnegative(),
    notBefore: z.string().datetime()
  })
});

const consumeSchema = z.union([
  z.array(messageSchema),
  z.object({ messages: z.array(messageSchema) }).transform(({ messages }) => messages)
]);

const infrai = infraiFromEnvironment();

async function pauseUntil(isoTime: string): Promise<void> {
  const delayMs = Math.max(0, new Date(isoTime).getTime() - Date.now());
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function deliverOnce(): Promise<boolean> {
  const messages = consumeSchema.parse(await infrai.queue.consume(1, 60));
  const message = messages[0];
  if (!message) return false;

  await pauseUntil(message.payload.notBefore);
  let delivered = false;
  try {
    const response = await fetch(message.payload.event.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": message.payload.event.eventId
      },
      body: JSON.stringify(message.payload.event),
      signal: AbortSignal.timeout(10_000)
    });
    delivered = response.ok;
  } catch {
    delivered = false;
  }

  const job: DeliveryJob = {
    event: {
      eventId: message.payload.event.eventId,
      buildId: message.payload.event.buildId,
      project: message.payload.event.project,
      status: message.payload.event.status,
      commitSha: message.payload.event.commitSha,
      webhookUrl: message.payload.event.webhookUrl
    },
    attempt: message.payload.attempt,
    notBefore: message.payload.notBefore
  };
  const decision = decideDelivery(job, delivered, Date.now());
  if (decision.kind === "retry") {
    await infrai.queue.publish(
      decision.next,
      `delivery-${decision.next.event.eventId}-${decision.next.attempt}`
    );
  }
  await infrai.queue.ack(message.message_id);

  console.log(JSON.stringify({
    eventId: message.payload.event.eventId,
    buildId: message.payload.event.buildId,
    outcome: decision.kind,
    attempts: decision.kind === "retry" ? decision.next.attempt : decision.attempts
  }));
  return true;
}

while (await deliverOnce()) {
  // Drain the currently available work, then exit cleanly.
}
