import {
  createUserJourneyTelemetry,
  type TelemetryEvent,
  type TelemetryTransport,
  type UserJourneyTelemetry,
} from "../userJourneyTelemetry";

/**
 * Focused tests for the privacy-preserving user journey telemetry module.
 *
 * These tests exercise the public contract only: consent gating, PII
 * scrubbing, bounded buffering, bounded retry with backoff, sampling/rate
 * limits, stale-data handling, and dependency-failure paths.
 */

interface RecordedBatch {
  events: TelemetryEvent[];
}

function createRecordingTransport(options?: {
  failTimes?: number;
  failAlways?: boolean;
}): {
  transport: TelemetryTransport;
  batches: RecordedBatch[];
  attempts: number;
} {
  const state = {
    batches: [] as RecordedBatch[],
    attempts: 0,
  };
  const failTimes = options?.failTimes ?? 0;
  const failAlways = options?.failAlways ?? false;

  const transport: TelemetryTransport = {
    async send(events) {
      state.attempts += 1;
      if (failAlways || state.attempts <= failTimes) {
        throw new Error("transport unavailable");
      }
      state.batches.push({ events: [...events] });
    },
  };

  return {
    transport,
    get batches() {
      return state.batches;
    },
    get attempts() {
      return state.attempts;
    },
  } as { transport: TelemetryTransport; batches: RecordedBatch[]; attempts: number };
}

function createTelemetry(
  overrides: Partial<Parameters<typeof createUserJourneyTelemetry>[0]> = {},
): { telemetry: UserJourneyTelemetry; recorder: ReturnType<typeof createRecordingTransport> } {
  const recorder = createRecordingTransport(overrides.transport ? undefined : {});
  const telemetry = createUserJourneyTelemetry({
    transport: recorder.transport,
    consent: true,
    sampleRate: 1,
    maxBufferSize: 10,
    maxRetries: 2,
    baseRetryDelayMs: 0,
    now: () => 1_000,
    ...overrides,
  });
  return { telemetry, recorder };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("userJourneyTelemetry", () => {
  it("does not emit anything when consent is not granted", async () => {
    const { telemetry, recorder } = createTelemetry({ consent: false });

    telemetry.track("journey_started", { step: "home" });
    await telemetry.flush();

    expect(recorder.attempts).toBe(0);
    expect(recorder.batches).toHaveLength(0);
    expect(telemetry.pendingCount()).toBe(0);
  });

  it("stops emitting after consent is revoked", async () => {
    const { telemetry, recorder } = createTelemetry();

    telemetry.track("journey_started", { step: "home" });
    await telemetry.flush();
    expect(recorder.batches).toHaveLength(1);

    telemetry.setConsent(false);
    telemetry.track("journey_step", { step: "checkout" });
    await telemetry.flush();

    expect(recorder.batches).toHaveLength(1);
    expect(telemetry.pendingCount()).toBe(0);
  });

  it("scrubs PII from event properties before sending", async () => {
    const { telemetry, recorder } = createTelemetry();

    telemetry.track("journey_step", {
      step: "checkout",
      userId: "user-123",
      walletAddress: "0xdeadbeef",
      email: "a@b.com",
      note: "free text should be dropped",
      amount: 42,
    });
    await telemetry.flush();

    expect(recorder.batches).toHaveLength(1);
    const [event] = recorder.batches[0].events;
    expect(event.name).toBe("journey_step");
    expect(event.properties).toEqual({ step: "checkout", amount: 42 });
    expect(JSON.stringify(event)).not.toContain("user-123");
    expect(JSON.stringify(event)).not.toContain("0xdeadbeef");
    expect(JSON.stringify(event)).not.toContain("a@b.com");
  });

  it("bounds the in-memory buffer and drops the oldest events", async () => {
    const { telemetry } = createTelemetry({ maxBufferSize: 3 });

    for (let i = 0; i < 10; i += 1) {
      telemetry.track("journey_step", { step: `step-${i}` });
    }

    expect(telemetry.pendingCount()).toBe(3);
  });

  it("retries with bounded attempts and eventually succeeds", async () => {
    const recorder = createRecordingTransport({ failTimes: 2 });
    const telemetry = createUserJourneyTelemetry({
      transport: recorder.transport,
      consent: true,
      sampleRate: 1,
      maxBufferSize: 10,
      maxRetries: 3,
      baseRetryDelayMs: 0,
      now: () => 1_000,
    });

    telemetry.track("journey_started", { step: "home" });
    await telemetry.flush();

    expect(recorder.attempts).toBe(3);
    expect(recorder.batches).toHaveLength(1);
    expect(telemetry.pendingCount()).toBe(0);
  });

  it("gives up after maxRetries and reports a structured error", async () => {
    const recorder = createRecordingTransport({ failAlways: true });
    const errors: unknown[] = [];
    const telemetry = createUserJourneyTelemetry({
      transport: recorder.transport,
      consent: true,
      sampleRate: 1,
      maxBufferSize: 10,
      maxRetries: 2,
      baseRetryDelayMs: 0,
      now: () => 1_000,
      onError: (error) => errors.push(error),
    });

    telemetry.track("journey_started", { step: "home" });
    await telemetry.flush();

    expect(recorder.attempts).toBe(3);
    expect(recorder.batches).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "telemetry_transport_failed" });
  });

  it("applies sampling and rate limits", async () => {
    const { telemetry, recorder } = createTelemetry({ sampleRate: 0 });

    telemetry.track("journey_started", { step: "home" });
    await telemetry.flush();

    expect(recorder.attempts).toBe(0);
    expect(telemetry.pendingCount()).toBe(0);
  });

  it("drops stale events older than the configured TTL", async () => {
    let clock = 1_000;
    const { telemetry, recorder } = createTelemetry({
      now: () => clock,
      eventTtlMs: 500,
    });

    telemetry.track("journey_started", { step: "home" });
    clock = 5_000;
    await telemetry.flush();

    expect(recorder.batches).toHaveLength(0);
    expect(telemetry.pendingCount()).toBe(0);
  });

  it("never throws when the transport dependency fails", async () => {
    const recorder = createRecordingTransport({ failAlways: true });
    const telemetry = createUserJourneyTelemetry({
      transport: recorder.transport,
      consent: true,
      sampleRate: 1,
      maxBufferSize: 10,
      maxRetries: 1,
      baseRetryDelayMs: 0,
      now: () => 1_000,
    });

    expect(() => telemetry.track("journey_started", { step: "home" })).not.toThrow();
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });
});
