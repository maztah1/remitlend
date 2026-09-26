import type { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';
import { deepRedact } from '../utils/logger.js';

/**
 * Middleware to log HTTP requests with structured fields for parsing and querying.
 * Logs method, url, statusCode, durationMs, and optional userAgent.
 *
 * All logged fields are passed through `deepRedact` so any sensitive value
 * that accidentally ends up in a URL query parameter, User-Agent string, or
 * forwarded IP is replaced before writing to the log transport.  This
 * provides a defence-in-depth guarantee on top of the per-field allowlist in
 * `logger.ts` — see issue #368.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const { method, originalUrl, ip } = req;
    const userAgent = req.get('user-agent') ?? undefined;
    const { statusCode } = res;

    // Redact the entire payload object so any PII that slips into a URL path
    // segment, query string, User-Agent header, or forwarded-IP field is
    // stripped before the log entry is written.  deepRedact is non-mutating
    // and always active regardless of LOG_REDACTION (#368).
    const payload = deepRedact({
      requestId: (req as any).requestId, // Safely handles custom middleware assignment
      traceId: (req as Request & { traceId?: string }).traceId,
      traceparent: (req as Request & { traceparent?: string }).traceparent,
      method,
      url: originalUrl,
      statusCode,
      durationMs,
      ...(ip && { ip }),
      ...(userAgent && { userAgent }),
    }) as Record<string, unknown>;

    if (statusCode >= 500) {
      logger.error('HTTP request', payload);
    } else if (statusCode >= 400) {
      logger.warn('HTTP request', payload);
    } else {
      logger.http('HTTP request', payload);
    }
  });

  next();
};
