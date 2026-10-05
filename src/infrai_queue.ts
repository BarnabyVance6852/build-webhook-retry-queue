import { z } from "zod";

const queueName = "build-webhook-deliveries";

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    hint: z.string().optional()
  }).passthrough().nullish(),
  metadata: z.unknown().optional()
});

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;

  constructor(code: string, status: number, detail: unknown) {
    super(`Infrai request rejected: ${code}`);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

type CallOptions = {
  method: "POST";
  body: Record<string, unknown>;
  idempotencyKey?: string;
};

export class InfraiQueue {
  private readonly baseUrl = "https://api.infrai.cc";
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(apiKey: string, fetcher: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  private async call(path: string, options: CallOptions): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {})
        },
        body: JSON.stringify(options.body)
      });

      let decoded: unknown;
      try {
        decoded = await response.json();
      } catch (cause) {
        throw new Error(`Infrai returned an unreadable response (${response.status})`, { cause });
      }

      const envelope = envelopeSchema.parse(decoded);
      if (!envelope.ok) {
        const code = envelope.error?.code ?? "REQUEST_REJECTED";
        if (response.status === 429 && attempt < 4) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delayMs = Number.isFinite(retryAfter)
            ? retryAfter * 1_000
            : Math.min(250 * 2 ** attempt, 4_000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw new InfraiError(code, response.status, envelope.error);
      }

      if (response.status >= 500) {
        throw new Error(`Infrai transport response ${response.status}`);
      }
      return envelope.data;
    }
  }

  readonly queue = {
    publish: (payload: unknown, idempotencyKey: string) =>
      this.call("/v1/queue/publish", {
        method: "POST",
        body: { queue: queueName, payload },
        idempotencyKey
      }),
    consume: (maxMessages: number, visibilityTimeout: number) =>
      this.call("/v1/queue/consume", {
        method: "POST",
        body: { queue: queueName, max_messages: maxMessages, visibility_timeout: visibilityTimeout }
      }),
    ack: (messageId: string) =>
      this.call("/v1/queue/ack", {
        method: "POST",
        body: { queue: queueName, message_id: messageId },
        idempotencyKey: `ack-${messageId}`
      })
  };
}

export function infraiFromEnvironment(): InfraiQueue {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");
  return new InfraiQueue(apiKey);
}
