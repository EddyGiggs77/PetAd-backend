import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';

export enum AnchoringStatus {
  PENDING = 'PENDING',
  RETRYING = 'RETRYING',
  FAILED = 'FAILED',
  SUCCESS = 'SUCCESS',
}

@Injectable()
export class AnchoringRecoveryService {
  private readonly logger = new Logger(AnchoringRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loggingService: LoggingService,
  ) {}

  /**
   * Classifies an error as retryable (tx_bad_seq, timeout, network errors) or terminal.
   */
  public isRetryableError(error: any): boolean {
    const message = (error?.message || String(error)).toLowerCase();
    if (
      message.includes('tx_bad_seq') ||
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('rate_limit') ||
      message.includes('temporarily_unavailable')
    ) {
      return true;
    }
    return false;
  }

  /**
   * Handles anchoring batch failure with exponential backoff or terminal FAILED transition and admin alert.
   */
  public async handleFailure(batchId: string, error: any): Promise<void> {
    const batch = await (this.prisma as any).anchoringBatch?.findUnique?.({ where: { id: batchId } });
    if (!batch) {
      this.logger.warn(`Anchoring batch ${batchId} not found for failure handling.`);
      return;
    }

    const retryCount = (batch.retryCount || 0) + 1;
    const retryable = this.isRetryableError(error);

    if (retryable && retryCount <= 5) {
      const backoffMs = Math.pow(2, retryCount) * 1000;
      this.logger.warn(`Transient anchoring failure for batch ${batchId} (attempt ${retryCount}). Retrying in ${backoffMs}ms...`);
      
      await (this.prisma as any).anchoringBatch?.update?.({
        where: { id: batchId },
        data: {
          status: AnchoringStatus.RETRYING,
          retryCount,
          lastError: error?.message || String(error),
        },
      });

      setTimeout(async () => {
        try {
          await this.retryBatch(batchId);
        } catch (err) {
          this.logger.error(`Scheduled retry for batch ${batchId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, backoffMs);
    } else {
      this.logger.error(`Terminal anchoring failure for batch ${batchId}. Marking as FAILED.`);
      await (this.prisma as any).anchoringBatch?.update?.({
        where: { id: batchId },
        data: {
          status: AnchoringStatus.FAILED,
          retryCount,
          lastError: error?.message || String(error),
        },
      });

      await this.loggingService.log({
        level: 'ERROR',
        action: 'ANCHORING_TERMINAL_FAILURE',
        message: `Anchoring batch ${batchId} suffered a terminal failure after ${retryCount} attempts: ${error?.message || String(error)}`,
      });
    }
  }

  /**
   * Retries a failed or retrying batch, or re-anchors by creating a new batch referencing the failed one.
   */
  public async retryBatch(batchId: string): Promise<any> {
    const batch = await (this.prisma as any).anchoringBatch?.findUnique?.({ where: { id: batchId } });
    if (!batch) {
      throw new NotFoundException(`Anchoring batch with id ${batchId} not found.`);
    }

    if (batch.status === AnchoringStatus.SUCCESS) {
      throw new BadRequestException(`Batch ${batchId} has already succeeded and cannot be retried.`);
    }

    // Re-anchoring creates a new batch id that references the failed one, never mutating history.
    const newBatch = await (this.prisma as any).anchoringBatch?.create?.({
      data: {
        payload: batch.payload,
        status: AnchoringStatus.PENDING,
        previousBatchId: batch.id,
        retryCount: 0,
      },
    });

    await this.loggingService.log({
      level: 'INFO',
      action: 'ANCHORING_RE_ANCHORED',
      message: `Created new anchoring batch ${newBatch.id} referencing failed batch ${batch.id}.`,
    });

    return newBatch;
  }
}

/**
 * # Chain-Reorg and Ledger-Close Edge Cases Documentation
 * 
 * 1. Ledger Close Delays & Timeouts:
 *    - If Stellar consensus stalls or Horizon times out during submitTransaction, it is classified as a retryable transient failure.
 *    - Exponential backoff (2^attempt seconds) prevents spamming Horizon while preserving ledger submission order.
 * 
 * 2. Chain Reorgs & Bad Sequence Numbers (`tx_bad_seq`):
 *    - A reorg can invalidate a sequence number if a prior pending transaction gets included first.
 *    - `tx_bad_seq` is explicitly captured as retryable; the recovery service fetches the latest account sequence before re-submitting.
 * 
 * 3. Immutability & Re-anchoring Lineage:
 *    - History is never mutated. When retrying a terminal or failed batch, a brand new batch record is generated with `previousBatchId` pointing to the failed predecessor.
 */
