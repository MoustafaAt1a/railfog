/**
 * @spec Q-2
 * @spec PLAT-16
 */
export interface QueueMessage {
  id: string;
  body: unknown;
  attempts: number;
}

export interface QueueProvider {
  send(body: unknown, opts?: { delay?: number }): Promise<{ id: string }>;
  sendBatch(bodies: unknown[]): Promise<{ id: string }[]>;
  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null>;
  ack(id: string): Promise<void>;
}
