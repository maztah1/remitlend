import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';

export const metricsRegistry = new client.Registry();

client.collectDefaultMetrics({ register: metricsRegistry });

export const traceContextCounter = new client.Counter({
  name: 'trace_context_requests_total',
  help: 'Inbound requests by trace-context resolution outcome (incoming, generated, invalid).',
  labelNames: ['source'] as const,
  registers: [metricsRegistry],
});

export const chainConfirmationCounter = new client.Counter({
  name: 'chain_confirmation_total',
  help: 'Soroban transaction confirmation outcomes observed by the API (success, failed, not_found, error).',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const chainConfirmationDurationHistogram = new client.Histogram({
  name: 'chain_confirmation_duration_seconds',
  help: 'Wall-clock seconds from transaction submission to observed chain confirmation.',
  labelNames: ['status'] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

export const indexerLastLedgerGauge = new client.Gauge({
  name: 'indexer_last_ledger',
  help: 'Last ledger successfully processed by the event indexer.',
  registers: [metricsRegistry],
});

export const indexerChainTipGauge = new client.Gauge({
  name: 'indexer_chain_tip',
  help: 'Latest ledger observed from the chain RPC.',
  registers: [metricsRegistry],
});

export const indexerLagLedgersGauge = new client.Gauge({
  name: 'indexer_lag_ledgers',
  help: 'Difference between the latest chain ledger and the last indexed ledger.',
  registers: [metricsRegistry],
});

export const webhookRetryQueueDepthGauge = new client.Gauge({
  name: 'webhook_retry_queue_depth',
  help: 'Number of webhook deliveries currently waiting for retry.',
  registers: [metricsRegistry],
});

export const scoreReconciliationLastRunTimestampGauge = new client.Gauge({
  name: 'score_reconciliation_last_run_timestamp',
  help: 'Unix timestamp in seconds for the last score reconciliation run.',
  registers: [metricsRegistry],
});

export const httpRequestDurationHistogram = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_class'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const dbQueryDurationHistogram = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds.',
  labelNames: ['operation', 'table'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

export const cacheHitRateCounter = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits.',
  labelNames: ['key_pattern'] as const,
  registers: [metricsRegistry],
});

export const cacheMissRateCounter = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses.',
  labelNames: ['key_pattern'] as const,
  registers: [metricsRegistry],
});

export const loanApprovalRateCounter = new client.Counter({
  name: 'loan_approvals_total',
  help: 'Total number of approved loans.',
  labelNames: ['loan_type'] as const,
  registers: [metricsRegistry],
});

export const loanRejectionRateCounter = new client.Counter({
  name: 'loan_rejections_total',
  help: 'Total number of rejected loans.',
  labelNames: ['rejection_reason'] as const,
  registers: [metricsRegistry],
});

export const poolUtilizationGauge = new client.Gauge({
  name: 'pool_utilization_ratio',
  help: 'Current utilization ratio of the lending pool (0-1).',
  labelNames: ['pool_id'] as const,
  registers: [metricsRegistry],
});

export const activeLoansGauge = new client.Gauge({
  name: 'active_loans_total',
  help: 'Total number of currently active loans.',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const transactionProcessingTimeHistogram = new client.Histogram({
  name: 'transaction_processing_time_seconds',
  help: 'Time taken to process a transaction on-chain.',
  labelNames: ['transaction_type'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

function routeLabel(req: Request): string {
  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    return `${req.baseUrl}${routePath}` || req.path;
  }

  if (Array.isArray(routePath)) {
    return `${req.baseUrl}${routePath.join('|')}`;
  }

  return 'unmatched';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const endTimer = httpRequestDurationHistogram.startTimer();

  res.on('finish', () => {
    endTimer({
      method: req.method,
      route: routeLabel(req),
      status_class: `${Math.floor(res.statusCode / 100)}xx`,
    });
  });

  next();
}

export function recordIndexerLedgers(lastLedger: number, chainTip: number): void {
  indexerLastLedgerGauge.set(lastLedger);
  indexerChainTipGauge.set(chainTip);
  indexerLagLedgersGauge.set(Math.max(chainTip - lastLedger, 0));
}

export function recordScoreReconciliationRun(date = new Date()): void {
  scoreReconciliationLastRunTimestampGauge.set(Math.floor(date.getTime() / 1000));
}

export async function refreshWebhookRetryQueueDepth(): Promise<void> {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS count
       FROM webhook_deliveries
       WHERE delivered_at IS NULL
         AND next_retry_at IS NOT NULL`,
      [],
    );
    webhookRetryQueueDepthGauge.set(Number(result.rows[0]?.count ?? 0));
  } catch (error) {
    logger.warn('Failed to refresh webhook retry queue depth metric', {
      error,
    });
  }
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
}

export function recordDbQueryDuration(duration: number, operation: string, table: string): void {
  dbQueryDurationHistogram.observe({ operation, table }, duration);
}

export function recordCacheHit(keyPattern: string): void {
  cacheHitRateCounter.inc({ key_pattern: keyPattern });
}

export function recordCacheMiss(keyPattern: string): void {
  cacheMissRateCounter.inc({ key_pattern: keyPattern });
}

export function recordLoanApproval(loanType: string = 'standard'): void {
  loanApprovalRateCounter.inc({ loan_type: loanType });
}

export function recordLoanRejection(rejectionReason: string = 'unknown'): void {
  loanRejectionRateCounter.inc({ rejection_reason: rejectionReason });
}

export function updatePoolUtilization(poolId: string, utilizationRatio: number): void {
  poolUtilizationGauge.set({ pool_id: poolId }, Math.max(0, Math.min(1, utilizationRatio)));
}

export function updateActiveLoans(status: string, count: number): void {
  activeLoansGauge.set({ status }, count);
}

export function recordTransactionProcessingTime(duration: number, transactionType: string): void {
  transactionProcessingTimeHistogram.observe({ transaction_type: transactionType }, duration);
}
