import { describe, it, expect } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
  providerBreakerName,
  CB_FAILURE_THRESHOLD,
} from "./breaker.js";
import { ProviderError } from "./errorKind.js";

/** A hand-cranked clock, so no test waits on a real half-open window. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("CircuitBreaker", () => {
  it("stays closed below the threshold", () => {
    const c = clock();
    const b = new CircuitBreaker("test", { now: c.now });
    for (let i = 0; i < CB_FAILURE_THRESHOLD - 1; i += 1) b.recordFailure();
    expect(b.isOpen).toBe(false);
  });

  it("opens at the threshold and fails fast instead of calling out", () => {
    const c = clock();
    const b = new CircuitBreaker("test", { now: c.now });
    for (let i = 0; i < CB_FAILURE_THRESHOLD; i += 1) b.recordFailure();
    expect(b.isOpen).toBe(true);
    expect(() => b.check()).toThrow(CircuitOpenError);
  });

  it("forgives failures older than the recovery window", () => {
    const c = clock();
    const b = new CircuitBreaker("test", { now: c.now, threshold: 3, recoveryWindowMs: 1000 });
    b.recordFailure();
    b.recordFailure();
    c.advance(1500); // both fall out of the window
    b.recordFailure();
    expect(b.isOpen).toBe(false);
  });

  it("lets exactly one probe through once the half-open window elapses", () => {
    const c = clock();
    const b = new CircuitBreaker("test", { now: c.now, threshold: 2, halfOpenAfterMs: 5000 });
    b.recordFailure();
    b.recordFailure();
    expect(b.isOpen).toBe(true);
    c.advance(5001);
    expect(b.isOpen).toBe(false); // the probe is allowed
    b.recordFailure(); // and it failed, so we are straight back to open
    expect(b.isOpen).toBe(true);
  });

  it("closes on success and forgets the accumulated failures", () => {
    const c = clock();
    const b = new CircuitBreaker("test", { now: c.now, threshold: 2 });
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    expect(b.isOpen).toBe(false);
    expect(b.openForMs).toBeNull();
    b.recordFailure();
    expect(b.isOpen).toBe(false); // the count really was cleared
  });

  it("counts a provider outage but not the user's own bad key", () => {
    const c = clock();
    const b = new CircuitBreaker("test", { now: c.now, threshold: 2 });
    b.record(new ProviderError({ kind: "auth_invalid", message: "" }));
    b.record(new ProviderError({ kind: "auth_invalid", message: "" }));
    expect(b.isOpen).toBe(false);
    b.record(new ProviderError({ kind: "provider_down", message: "" }));
    b.record(new ProviderError({ kind: "provider_down", message: "" }));
    expect(b.isOpen).toBe(true);
  });

  it("never counts a cancel — the user stopping is not an outage", () => {
    const c = clock();
    const b = new CircuitBreaker("test", { now: c.now, threshold: 1 });
    b.record(new ProviderError({ kind: "cancelled", message: "" }));
    expect(b.isOpen).toBe(false);
  });

  describe("run", () => {
    it("records the outcome around the call", async () => {
      const c = clock();
      const b = new CircuitBreaker("test", { now: c.now, threshold: 1 });
      await expect(
        b.run(() => Promise.reject(new ProviderError({ kind: "provider_down", message: "boom" }))),
      ).rejects.toThrow("boom");
      expect(b.isOpen).toBe(true);
      await expect(b.run(() => Promise.resolve(1))).rejects.toBeInstanceOf(CircuitOpenError);
    });
  });
});

describe("providerBreakerName", () => {
  it("keeps answering and query-understanding apart per provider", () => {
    expect(providerBreakerName("openai", "answer")).toBe("llm:answer:openai");
    expect(providerBreakerName("openai", "complete")).not.toBe(
      providerBreakerName("openai", "answer"),
    );
  });
});

describe("CircuitBreakerRegistry", () => {
  it("hands back the same breaker for the same name", () => {
    const r = new CircuitBreakerRegistry();
    expect(r.get("a")).toBe(r.get("a"));
    expect(r.get("a")).not.toBe(r.get("b"));
  });

  it("reset drops accumulated state", () => {
    const r = new CircuitBreakerRegistry({ threshold: 1 });
    r.get("a").recordFailure();
    expect(r.get("a").isOpen).toBe(true);
    r.reset();
    expect(r.get("a").isOpen).toBe(false);
  });
});
