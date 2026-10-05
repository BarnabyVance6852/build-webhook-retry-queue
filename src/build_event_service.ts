import { createServer } from "node:http";
import { z } from "zod";
import { InfraiError, infraiFromEnvironment } from "./infrai_queue";

const buildEventSchema = z.object({
  eventId: z.string().min(1),
  buildId: z.string().min(1),
  project: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  commitSha: z.string().min(7),
  webhookUrl: z.string().url()
});

const infrai = infraiFromEnvironment();
const port = Number(process.env.PORT ?? 3000);

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/build-events") {
    send(response, 404, { error: "Route not found" });
    return;
  }

  try {
    const event = buildEventSchema.parse(await readJson(request));
    const job = { event, attempt: 0, notBefore: new Date().toISOString() };
    await infrai.queue.publish(job, `build-event-${event.eventId}`);
    send(response, 202, { eventId: event.eventId, delivery: "queued" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      send(response, 400, { error: "Invalid build event", issues: error.issues });
    } else if (error instanceof InfraiError) {
      send(response, error.status >= 400 && error.status < 500 ? error.status : 502, {
        error: error.code
      });
    } else {
      send(response, 500, { error: "Could not queue build event" });
    }
  }
}).listen(port, () => {
  console.log(`Build event receiver listening on http://localhost:${port}`);
});
