"use client";

const SESSION_INTENT_KEY = "remitlend-session-intent";
const MAX_RETURN_TO_LENGTH = 512;
const MAX_INTENT_AGE_MS = 15 * 60 * 1000;

export interface SessionIntent {
  returnTo: string;
  capturedAt: number;
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

function safeReturnTo(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, MAX_RETURN_TO_LENGTH);
}

export function captureSessionIntent(returnTo?: string): SessionIntent | null {
  const current = returnTo ?? (typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`);
  const intent = { returnTo: safeReturnTo(current), capturedAt: Date.now() };

  try {
    storage()?.setItem(SESSION_INTENT_KEY, JSON.stringify(intent));
    return intent;
  } catch {
    return null;
  }
}

export function getSessionIntent(): SessionIntent | null {
  try {
    const raw = storage()?.getItem(SESSION_INTENT_KEY);
    if (!raw) return null;
    const intent = JSON.parse(raw) as Partial<SessionIntent>;
    if (typeof intent.returnTo !== "string" || typeof intent.capturedAt !== "number") return null;
    if (Date.now() - intent.capturedAt > MAX_INTENT_AGE_MS) {
      clearSessionIntent();
      return null;
    }
    return { returnTo: safeReturnTo(intent.returnTo), capturedAt: intent.capturedAt };
  } catch {
    return null;
  }
}

export function clearSessionIntent(): void {
  try {
    storage()?.removeItem(SESSION_INTENT_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function sessionExpiredRedirect(): string {
  const intent = getSessionIntent();
  const params = new URLSearchParams({ reason: "session_expired" });
  if (intent) params.set("returnTo", intent.returnTo);
  return `/?${params.toString()}`;
}
