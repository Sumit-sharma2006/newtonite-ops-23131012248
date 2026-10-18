import { OutboxJob, outboxRepository } from './outbox.repository.js';
import { notifyAssigneeHandler } from './handlers/notifyAssignee.js';

export type OutboxHandler = (job: OutboxJob) => Promise<void>;
export type HandlerRegistry = Record<string, OutboxHandler>;

export const defaultHandlers: HandlerRegistry = {
  CLAIMED: notifyAssigneeHandler,
  WORK_ITEM_CLAIMED: notifyAssigneeHandler,
  ASSIGNED: notifyAssigneeHandler,
  WORK_ITEM_ASSIGNED: notifyAssigneeHandler,
  CREATED: async () => {},
  WORK_ITEM_CREATED: async () => {},
  STATUS_CHANGED: async () => {},
  WORK_ITEM_STATUS_CHANGED: async () => {}
};

export interface ProcessBatchResult {
  claimedCount: number;
  succeededCount: number;
  failedCount: number;
  jobs: OutboxJob[];
}

export class OutboxService {
  /**
   * Claims a batch of ready outbox jobs and executes registered event handlers.
   * On success: marks job COMPLETED.
   * On failure: marks job FAILED (applies exponential backoff or moves to DEAD_LETTER).
   * 
   * Handlers can be injected for testing custom or failing scenarios.
   * Contains no sleep or timer logic.
   */
  async processBatch(
    workerId: string,
    handlers: HandlerRegistry = defaultHandlers,
    limit = 10
  ): Promise<ProcessBatchResult> {
    const jobs = await outboxRepository.claimBatch(workerId, limit);
    let succeededCount = 0;
    let failedCount = 0;

    for (const job of jobs) {
      try {
        const handler = handlers[job.event_type];
        if (!handler) {
          throw new Error(`No handler registered for outbox event type: ${job.event_type}`);
        }

        await handler(job);
        await outboxRepository.markCompleted(job.id);
        succeededCount++;
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        await outboxRepository.markFailed(job.id, errMsg);
        failedCount++;
      }
    }

    return {
      claimedCount: jobs.length,
      succeededCount,
      failedCount,
      jobs
    };
  }
}

export const outboxService = new OutboxService();
