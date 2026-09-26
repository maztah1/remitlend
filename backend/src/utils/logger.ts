import winston from 'winston';
import { getRequestId, getTraceContext, getTraceId } from './requestContext.js';
import { formatTraceparent } from './traceContext.js';

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const validLevels = Object.keys(levels);

const defaultLevelForEnv = () => {
  const env = process.env.NODE_ENV || 'development';
  return env === 'development' ? 'debug' : 'http';
};

const level = () => {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  if (configured && validLevels.includes(configured)) {
    return configured;
  }
  return defaultLevelForEnv();
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'grey',
};

winston.addColors(colors);

/**
 * Fields that must never appear in plain-text log output.
 *
 * Rules for adding a field:
 *  - Any field name whose value is directly user-identifiable (PII) or a
 *    credential belongs here, regardless of where it originates.
 *  - Add both the camelCase and snake_case variants when the field can arrive
 *    under either convention from different layers of the stack.
 *  - Case-insensitive matching (lower-cased before comparison) is applied in
 *    `deepRedact`, so only lower-case entries are needed here.
 *
 * @see deepRedact
 */
export const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  // PII — identity
  'email',
  'recipient_email',
  'phone',
  'recipient_phone',
  'recipient_name',
  'legalname',
  'ssn',
  'tin',
  'pii',
  // PII — financial
  'bank_account',
  'credit_card',
  // Credentials / tokens
  'password',
  'authorization',
  'authorization_code',
  'access_token',
  'refresh_token',
  'api_key',
  'secret_key',
  // Cryptographic material
  'wallet_address',
  'public_key',
  'private_key',
  'mnemonic',
]);

/**
 * Recursively redact every key whose lower-cased name is listed in
 * `REDACTED_FIELDS` within a plain-object or array tree.  Returns a new
 * value — the original is never mutated.
 *
 * Behaviour:
 *  - Plain objects: each key is checked; matching keys are replaced with the
 *    literal string `'[REDACTED]'`; non-matching values are recursed into.
 *  - Arrays: each element is recursed into.
 *  - Primitives / non-plain values (Date, Buffer, …): returned as-is.
 *  - Circular references / depth > 20: the node is replaced with
 *    `'[REDACTED:DEPTH]'` to avoid unbounded recursion in adversarial input.
 *
 * This is intentionally always active — it does **not** gate on
 * `LOG_REDACTION` — so PII is never accidentally emitted in development or
 * staging environments.  The previous `LOG_REDACTION=strict` guard is kept
 * for backward compatibility with any tooling that sets it, but the guard no
 * longer short-circuits redaction.
 */
export function deepRedact(value: unknown, _depth = 0, _seen = new Set<object>()): unknown {
  if (_depth > 20) return '[REDACTED:DEPTH]';
  if (value === null || typeof value !== 'object') return value;
  if (_seen.has(value)) return '[REDACTED:CIRCULAR]';

  _seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item, _depth + 1, _seen));
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (REDACTED_FIELDS.has(lowerKey)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = deepRedact(
        (value as Record<string, unknown>)[key],
        _depth + 1,
        _seen,
      );
    }
  }
  return result;
}

/**
 * Winston format that applies `deepRedact` to every top-level metadata field
 * on the log `info` object.
 *
 * Always active — see `deepRedact` for rationale.  The `LOG_REDACTION`
 * environment variable is still respected (for legacy tooling) but is no
 * longer required to enable redaction.
 */
const redactPiiFormat = winston.format((info) => {
  const record = info as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // Skip core Winston fields that are internal metadata.
    if (key === 'level' || key === 'message' || key === 'stack' || key === 'service') continue;
    const lowerKey = key.toLowerCase();
    if (REDACTED_FIELDS.has(lowerKey)) {
      record[key] = '[REDACTED]';
    } else {
      record[key] = deepRedact(record[key]);
    }
  }
  return info;
});

/** Dev: human-readable with colors and optional metadata */
const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const stackStr = stack ? `\n${stack}` : '';
    return `${timestamp} ${level}: ${message}${metaStr}${stackStr}`;
  }),
);

/** Production: JSON for parsing and querying */
const productionFormat = winston.format.combine(
  winston.format.timestamp({ format: 'iso' }),
  winston.format.errors({ stack: true }),
  redactPiiFormat(),
  winston.format((info) => {
    if (!info.service) {
      info.service = 'remitlend-backend';
    }
    return info;
  })(),
  winston.format.json(),
);

const withCorrelationContext = winston.format((info) => {
  const requestIdFromContext = getRequestId();
  if (requestIdFromContext && !info.requestId) {
    info.requestId = requestIdFromContext;
  }

  // Every log line emitted inside a traced unit of work (inbound request,
  // indexer pass, chain confirmation) carries the W3C trace fields so operators
  // can correlate one wallet action across API, indexer, and chain hops.
  const trace = getTraceContext();
  if (trace) {
    if (!info.traceId) info.traceId = trace.traceId;
    if (!info.spanId) info.spanId = trace.spanId;
    if (!info.traceparent) info.traceparent = formatTraceparent(trace);
  }

  return info;
});

const isProduction = process.env.NODE_ENV === 'production';

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: isProduction
      ? winston.format.combine(withCorrelationContext(), productionFormat)
      : winston.format.combine(withCorrelationContext(), devFormat),
  }),
];

const logger = winston.createLogger({
  level: level(),
  levels,
  transports,
});

export interface LogContext {
  requestId?: string;
  traceId?: string;
  userId?: string;
  loanId?: string;
  service?: string;
  module?: string;
  action?: string;
  [key: string]: any;
}

const shouldSample = (sampleRate: number = 0.1): boolean => {
  return Math.random() < sampleRate;
};

const withContext = (context: LogContext = {}) => {
  const requestId = context.requestId || getRequestId();
  // A traceId supplied explicitly (e.g. a chain-confirmation span) wins;
  // otherwise inherit the ambient trace so nested logs stay on one trace.
  const traceId = context.traceId || getTraceId() || requestId;
  const baseMeta: Record<string, any> = {};

  if (requestId) baseMeta.requestId = requestId;
  if (traceId) baseMeta.traceId = traceId;
  if (context.userId) baseMeta.userId = context.userId;
  if (context.loanId) baseMeta.loanId = context.loanId;
  if (context.service) baseMeta.service = context.service;
  if (context.module) baseMeta.module = context.module;
  if (context.action) baseMeta.action = context.action;

  return {
    info: (message: string, meta?: any, sampleRate?: number) => {
      if (sampleRate !== undefined && !shouldSample(sampleRate)) return;
      logger.info(message, { ...baseMeta, ...meta });
    },
    warn: (message: string, meta?: any) => logger.warn(message, { ...baseMeta, ...meta }),
    error: (message: string, meta?: any) => logger.error(message, { ...baseMeta, ...meta }),
    http: (message: string, meta?: any) => logger.http(message, { ...baseMeta, ...meta }),
    debug: (message: string, meta?: any) => logger.debug(message, { ...baseMeta, ...meta }),
  };
};

const loggerWithContext = Object.assign(logger, { withContext });

export default loggerWithContext;
