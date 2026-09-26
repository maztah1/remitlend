import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError.js';
import { cacheService } from '../services/cacheService.js';
import logger from '../utils/logger.js';

const FAILED_ATTEMPTS_PREFIX = 'auth:failed:';
const LOCKOUT_PREFIX = 'auth:lockout:';
const SUSPICIOUS_PREFIX = 'auth:suspicious:';

interface FailedAttemptsData {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
}

interface LockoutData {
  lockedUntil: number;
  reason: string;
}

interface SuspiciousActivityData {
  accountsTargeted: Set<string>;
  ipCount: number;
  firstDetected: number;
}

const MAX_FAILED_ATTEMPTS_PER_IP = 10;
const MAX_FAILED_ATTEMPTS_PER_ACCOUNT = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const PROGRESSIVE_DELAY_BASE_MS = 1000;
const SUSPICIOUS_ACCOUNT_THRESHOLD = 3;
const SUSPICIOUS_WINDOW_MS = 60 * 60 * 1000;

function getClientIdentifier(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const userAgent = req.headers['user-agent'] ?? 'unknown';
  return `${ip}:${hashString(userAgent)}`;
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

async function getFailedAttempts(key: string): Promise<FailedAttemptsData> {
  const data = await cacheService.get<FailedAttemptsData>(key);
  if (!data) {
    return { count: 0, firstAttempt: 0, lastAttempt: 0 };
  }
  return data;
}

async function incrementFailedAttempts(key: string, ttlSeconds: number): Promise<FailedAttemptsData> {
  const now = Date.now();
  const existing = await getFailedAttempts(key);
  
  const updated: FailedAttemptsData = {
    count: existing.count + 1,
    firstAttempt: existing.firstAttempt || now,
    lastAttempt: now,
  };
  
  await cacheService.set(key, updated, ttlSeconds);
  return updated;
}

async function resetFailedAttempts(key: string): Promise<void> {
  await cacheService.delete(key);
}

async function isLockedOut(key: string): Promise<LockoutData | null> {
  const data = await cacheService.get<LockoutData>(key);
  if (!data) return null;
  
  if (Date.now() >= data.lockedUntil) {
    await cacheService.delete(key);
    return null;
  }
  
  return data;
}

async function lockOut(key: string, reason: string): Promise<void> {
  const lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  await cacheService.set(key, { lockedUntil, reason }, Math.ceil(LOCKOUT_DURATION_MS / 1000));
  logger.warn('Auth lockout activated', { key, reason, lockedUntil: new Date(lockedUntil).toISOString() });
}

async function checkSuspiciousActivity(req: Request): Promise<boolean> {
  const clientId = getClientIdentifier(req);
  const key = `${SUSPICIOUS_PREFIX}${clientId}`;
  
  const data = await cacheService.get<SuspiciousActivityData>(key);
  if (!data) return false;
  
  if (data.accountsTargeted.size >= SUSPICIOUS_ACCOUNT_THRESHOLD) {
    return true;
  }
  
  return false;
}

async function trackSuspiciousActivity(req: Request, publicKey: string): Promise<void> {
  const clientId = getClientIdentifier(req);
  const key = `${SUSPICIOUS_PREFIX}${clientId}`;
  
  const existing = await cacheService.get<SuspiciousActivityData>(key);
  const now = Date.now();
  
  const accountsTargeted = existing ? new Set<string>(existing.accountsTargeted) : new Set<string>();
  accountsTargeted.add(publicKey);
  
  const updated: SuspiciousActivityData = {
    accountsTargeted,
    ipCount: (existing?.ipCount ?? 0) + 1,
    firstDetected: existing?.firstDetected ?? now,
  };
  
  await cacheService.set(key, updated, Math.ceil(SUSPICIOUS_WINDOW_MS / 1000));
  
  logger.warn('Suspicious auth activity detected', {
    clientId,
    publicKey,
    accountsTargeted: Array.from(accountsTargeted),
    ipCount: updated.ipCount,
  });
}

export async function authSecurityMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const clientId = getClientIdentifier(req);
  const publicKey = req.body?.publicKey?.toString().toLowerCase();
  
  const ipFailedKey = `${FAILED_ATTEMPTS_PREFIX}ip:${clientId}`;
  const ipLockoutKey = `${LOCKOUT_PREFIX}ip:${clientId}`;
  // Hoisted to the middleware scope so the `res.send` wrapper below can reach
  // them; both are only meaningful when a public key is present.
  const accountFailedKey = publicKey ? `${FAILED_ATTEMPTS_PREFIX}account:${publicKey}` : '';
  const accountLockoutKey = publicKey ? `${LOCKOUT_PREFIX}account:${publicKey}` : '';
  
  const ipLockout = await isLockedOut(ipLockoutKey);
  if (ipLockout) {
    const retryAfter = Math.ceil((ipLockout.lockedUntil - Date.now()) / 1000);
    res.setHeader('Retry-After', retryAfter.toString());
    logger.warn('Auth request blocked: IP locked out', { clientId, retryAfter, reason: ipLockout.reason });
    throw AppError.tooManyRequests(
      `IP temporarily locked out: ${ipLockout.reason}. Try again in ${retryAfter} seconds.`
    );
  }
  
  if (publicKey) {
    const accountLockout = await isLockedOut(accountLockoutKey);
    if (accountLockout) {
      const retryAfter = Math.ceil((accountLockout.lockedUntil - Date.now()) / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      logger.warn('Auth request blocked: Account locked out', { publicKey, retryAfter, reason: accountLockout.reason });
      throw AppError.tooManyRequests(
        `Account temporarily locked out: ${accountLockout.reason}. Try again in ${retryAfter} seconds.`
      );
    }
    
    const suspicious = await checkSuspiciousActivity(req);
    if (suspicious) {
      await trackSuspiciousActivity(req, publicKey);
      
      res.setHeader('X-Captcha-Required', 'true');
      res.setHeader('X-Suspicious-Activity', 'true');
    }
  }
  
  const originalSend = res.send;
  // The wrapper awaits Redis-backed counters/lockout bookkeeping before
  // delegating to the original `send`. Express does not consume the return
  // value of `res.send` (and Express 5 tolerates a promise from a handler), so
  // the wrapper is async and cast back to Express's declared signature.
  res.send = (async function patchedSend(this: Response, body?: any): Promise<Response> {
    const statusCode = res.statusCode;
    
    if (statusCode === 401 || statusCode === 400) {
      const errorBody = typeof body === 'string' ? JSON.parse(body) : body;
      const errorCode = errorBody?.errorCode || errorBody?.message;
      
      const isAuthFailure = 
        errorCode === 'INVALID_SIGNATURE' ||
        errorCode === 'CHALLENGE_EXPIRED' ||
        errorCode === 'INVALID_CHALLENGE' ||
        errorCode === 'INVALID_PUBLIC_KEY' ||
        (errorBody?.message && (
          errorBody.message.includes('signature') ||
          errorBody.message.includes('challenge') ||
          errorBody.message.includes('Invalid')
        ));
      
      if (isAuthFailure && publicKey) {
        const ipFailed = await incrementFailedAttempts(ipFailedKey, 60);
        
        if (ipFailed.count >= MAX_FAILED_ATTEMPTS_PER_IP) {
          await lockOut(ipLockoutKey, `Too many failed attempts from this IP (${ipFailed.count})`);
        }
        
        const accountFailed = await incrementFailedAttempts(accountFailedKey, 60);
        
        if (accountFailed.count >= MAX_FAILED_ATTEMPTS_PER_ACCOUNT) {
          await lockOut(accountLockoutKey, `Too many failed attempts for this account (${accountFailed.count})`);
        }
        
        if (accountFailed.count >= 2) {
          await trackSuspiciousActivity(req, publicKey);
        }
        
        const delay = Math.min(
          PROGRESSIVE_DELAY_BASE_MS * Math.pow(2, Math.max(0, accountFailed.count - 1)),
          30000
        );
        
        res.setHeader('X-Auth-Delay', delay.toString());
        res.setHeader('X-Failed-Attempts', accountFailed.count.toString());
        
        logger.warn('Auth attempt failed', {
          clientId,
          publicKey,
          ipFailedCount: ipFailed.count,
          accountFailedCount: accountFailed.count,
          statusCode,
        });
      }
    }
    
    if (statusCode === 200 && publicKey) {
      await resetFailedAttempts(`${FAILED_ATTEMPTS_PREFIX}account:${publicKey}`);
      await resetFailedAttempts(`${FAILED_ATTEMPTS_PREFIX}ip:${clientId}`);
      logger.info('Auth successful', { clientId, publicKey });
    }
    
    return originalSend.call(this, body);
  }) as unknown as Response['send'];
  
  next();
}

export async function requireCaptcha(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const captchaToken = req.headers['x-captcha-token'] as string | undefined;
  const captchaRequired = res.getHeader('X-Captcha-Required') === 'true';
  
  if (captchaRequired && !captchaToken) {
    throw AppError.badRequest('CAPTCHA verification required');
  }
  
  if (captchaToken) {
    const isValid = await verifyCaptcha(captchaToken);
    if (!isValid) {
      throw AppError.badRequest('Invalid CAPTCHA token');
    }
  }
  
  next();
}

async function verifyCaptcha(token: string): Promise<boolean> {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) {
    return true;
  }
  
  try {
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }),
    });
    
    const data = await response.json();
    return data.success === true && (data.score ?? 1) >= 0.5;
  } catch {
    return false;
  }
}

export function getAuthSecurityStats(): {
  failedAttemptsIp: number;
  failedAttemptsAccount: number;
  lockoutsIp: number;
  lockoutsAccount: number;
  suspiciousActivities: number;
} {
  return {
    failedAttemptsIp: 0,
    failedAttemptsAccount: 0,
    lockoutsIp: 0,
    lockoutsAccount: 0,
    suspiciousActivities: 0,
  };
}