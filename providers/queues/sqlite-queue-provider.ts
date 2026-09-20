import { DatabaseSync } from "node:sqlite";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import {
  PayloadTooLargeError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

/**
 * @spec PLAT-16 Provider abstraction
 * @spec PLAT-17 Local/production parity
 * @spec Q-1 Guarantee (at-least-once)
 * @spec Q-2 API (delay, max size)
 * @spec Q-3 Redelivery model (visibility timeout, max_receives, DLQ)
 */
export class SQLiteQueueProvider implements QueueProvider {
  private db: DatabaseSync;

  private readonly defaultVisibilityTimeoutMs = 30000;
  private readonly maxReceives = 5;

  // spec: contracts/queues.contract.md#Q-2 — delay <= 900 (15 min)
  private readonly MAX_DELAY_SECONDS = 900;
  // spec: contracts/queues.contract.md#Q-2 — Max message size 128 KB
  private readonly MAX_PAYLOAD_SIZE_BYTES = 128 * 1024;

  public readonly deadLetter: QueueProvider;

  constructor(dbPath: string = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.initDb();

    this.deadLetter = {
      send: () => Promise.resolve({ id: "" }),
      sendBatch: () => Promise.resolve([]),
      receive: () => this.receiveDlq(),
      ack: (id: string) => this.ack(id),
    };
  }

  private initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        visible_after INTEGER NOT NULL,
        is_dlq INTEGER DEFAULT 0
      );
    `);
  }

  send(body: unknown, opts?: { delay?: number }): Promise<{ id: string }> {
    if (opts?.delay !== undefined) {
      if (opts.delay > this.MAX_DELAY_SECONDS) {
        return Promise.reject(
          new ValidationFailedError(
            "VALIDATION_FAILED: Delay exceeds 900s cap. Use a schedule trigger instead per FN-2",
          ),
        );
      }
    }

    const jsonBody = JSON.stringify(body);

    const bodySize = new TextEncoder().encode(jsonBody).length;
    if (bodySize > this.MAX_PAYLOAD_SIZE_BYTES) {
      return Promise.reject(
        new PayloadTooLargeError(
          "PAYLOAD_TOO_LARGE: Payload exceeds 128KB limit",
        ),
      );
    }

    const id = generateUlid();
    const delayMs = (opts?.delay || 0) * 1000;
    const visibleAfter = Date.now() + delayMs;

    const stmt = this.db.prepare(
      "INSERT INTO messages (id, body, attempts, visible_after, is_dlq) VALUES (?, ?, 0, ?, 0)",
    );
    stmt.run(id, jsonBody, visibleAfter);

    return Promise.resolve({ id });
  }

  async sendBatch(bodies: unknown[]): Promise<{ id: string }[]> {
    const results: { id: string }[] = [];
    for (const body of bodies) {
      results.push(await this.send(body));
    }
    return results;
  }

  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    const visibilityTimeoutMs = opts?.visibilityTimeoutMs ??
      this.defaultVisibilityTimeoutMs;
    const now = Date.now();

    const stmt = this.db.prepare(`
      UPDATE messages 
      SET 
        attempts = attempts + 1,
        visible_after = ?
      WHERE id = (
        SELECT id FROM messages 
        WHERE visible_after <= ? AND is_dlq = 0 
        ORDER BY visible_after ASC 
        LIMIT 1
      )
      RETURNING id, body, attempts
    `);

    const nextVisible = now + visibilityTimeoutMs;
    const result = stmt.get(nextVisible, now) as {
      id: string;
      body: string;
      attempts: number;
    } | undefined;

    if (!result) {
      return Promise.resolve(null);
    }

    if (result.attempts > this.maxReceives) {
      const dlqStmt = this.db.prepare(
        "UPDATE messages SET is_dlq = 1, visible_after = 0 WHERE id = ?",
      );
      dlqStmt.run(result.id);

      return this.receive(opts);
    }

    return Promise.resolve({
      id: result.id,
      body: JSON.parse(result.body),
      attempts: result.attempts,
    });
  }

  ack(id: string): Promise<void> {
    const stmt = this.db.prepare("DELETE FROM messages WHERE id = ?");
    stmt.run(id);
    return Promise.resolve();
  }

  private receiveDlq(): Promise<QueueMessage | null> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE messages 
      SET visible_after = ?
      WHERE id = (
        SELECT id FROM messages 
        WHERE is_dlq = 1 AND visible_after <= ?
        ORDER BY visible_after ASC 
        LIMIT 1
      )
      RETURNING id, body, attempts
    `);

    const result = stmt.get(now + this.defaultVisibilityTimeoutMs, now) as {
      id: string;
      body: string;
      attempts: number;
    } | undefined;

    return Promise.resolve(
      result
        ? {
          id: result.id,
          body: JSON.parse(result.body),
          attempts: result.attempts,
        }
        : null,
    );
  }
}
