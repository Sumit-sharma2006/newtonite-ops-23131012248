import os from 'os';
import { pool } from './db/pool.js';
import { outboxRepository } from './modules/outbox/outbox.repository.js';
import { outboxService, defaultHandlers } from './modules/outbox/outbox.service.js';

const workerId = `${os.hostname()}:${process.pid}`;
const BATCH_SIZE = 10;
const SWEEPER_INTERVAL_MS = 60000; // 60 seconds
const IDLE_DELAY_MS = 1000;         // 1 second

let isRunning = true;
let isProcessingBatch = false;
let lastSweeperTime = 0;
let consecutiveErrors = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string) {
  console.log(`\n[Worker ${workerId}] Received ${signal}. Initiating graceful shutdown...`);
  isRunning = false;

  // If a batch is actively running, wait briefly for it to complete
  const maxWaitMs = 10000;
  const startWait = Date.now();
  while (isProcessingBatch && Date.now() - startWait < maxWaitMs) {
    await sleep(200);
  }

  try {
    await pool.end();
    console.log(`[Worker ${workerId}] Database connections closed cleanly.`);
  } catch (err: any) {
    console.error(`[Worker ${workerId}] Error closing database pool:`, err.message);
  }

  console.log(`[Worker ${workerId}] Outbox worker terminated gracefully.`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));
process.stdin.on('data', (d) => {
  if (d.toString().trim() === 'SIGINT' || d.toString().trim() === 'STOP') {
    shutdown('SIGINT');
  }
});

export async function startWorker() {
  console.log(`[Worker ${workerId}] PressureDesk Transactional Outbox Worker started.`);
  console.log(`[Worker ${workerId}] Configuration: BatchSize=${BATCH_SIZE}, IdleInterval=${IDLE_DELAY_MS}ms, SweeperInterval=${SWEEPER_INTERVAL_MS}ms`);

  while (isRunning) {
    try {
      const now = Date.now();

      // Periodic sweeper: recover orphaned jobs from crashed workers every 60s
      if (now - lastSweeperTime >= SWEEPER_INTERVAL_MS) {
        lastSweeperTime = now;
        const recovered = await outboxRepository.recoverStuck(300);
        if (recovered > 0) {
          console.log(`[Worker ${workerId}] Sweeper recovered ${recovered} stuck job(s) older than 5m.`);
        }
      }

      // Process batch
      isProcessingBatch = true;
      const result = await outboxService.processBatch(workerId, defaultHandlers, BATCH_SIZE);
      isProcessingBatch = false;
      consecutiveErrors = 0;

      if (result.claimedCount > 0) {
        console.log(
          `[Worker ${workerId}] Batch finished: claimed ${result.claimedCount}, succeeded ${result.succeededCount}, failed ${result.failedCount}`
        );

        // If batch was full, poll immediately again to drain queue under load
        if (result.claimedCount === BATCH_SIZE && isRunning) {
          continue;
        }
      }

      // Idle sleep when queue is empty or below limit
      if (isRunning) {
        await sleep(IDLE_DELAY_MS);
      }
    } catch (err: any) {
      isProcessingBatch = false;
      consecutiveErrors++;
      const backoffSec = Math.min(30, Math.pow(2, Math.min(consecutiveErrors, 5)));
      console.error(
        `[Worker ${workerId}] Database error in polling loop: ${err.message}. Backing off for ${backoffSec}s...`
      );
      if (isRunning) {
        await sleep(backoffSec * 1000);
      }
    }
  }
}

// Start worker automatically if executed directly as main script
const isMainModule = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('worker.ts') ||
  process.argv[1]?.endsWith('worker.js');

if (isMainModule) {
  startWorker().catch((err) => {
    console.error(`[Worker ${workerId}] Fatal error starting worker:`, err);
    process.exit(1);
  });
}
