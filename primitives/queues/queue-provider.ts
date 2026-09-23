/**
 * @spec Q-2
 * @spec PLAT-16
 */
export interface QueueMessage {
  id: string;
  body: unknown;
  attempts: number;
  // Delivery timestamp, stamped by the consumer at handler dispatch time.
  // Providers do not set it; the handler-facing SDK QueueMessage requires it.
  timestamp?: number;
}

export interface QueueProvider {
  send(body: unknown, opts?: { delay?: number }): Promise<{ id: string }>;
  sendBatch(bodies: unknown[]): Promise<{ id: string }[]>;
  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null>;
  ack(id: string): Promise<void>;
}
