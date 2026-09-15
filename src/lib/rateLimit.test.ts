import { describe, it, expect } from "vitest";
import { RateLimiter, RateLimitedError } from "./rateLimit.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("RateLimiter", () => {
  it("permits calls up to the ceiling", () => {
    const c = clock();
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 }, c.now);
    limiter.take();
    limiter.take();
    limiter.take();
    expect(limiter.remaining()).toBe(0);
  });

  it("refuses rather than sleeps once the window is full", () => {
    // A limiter that waits turns a runaway loop into a slow runaway loop: the
    // money is still spent, it just takes longer to notice.
    const c = clock();
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, c.now);
    limiter.take();
    limiter.take();
    expect(() => limiter.take()).toThrow(RateLimitedError);
  });

  it("says how long the pause will last, in the error a user reads", () => {
    const c = clock();
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 }, c.now);
    limiter.take();
    c.advance(10_000);
    try {
      limiter.take();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedError);
      expect((error as RateLimitedError).retryAfterMs).toBe(50_000);
      expect((error as RateLimitedError).message).toMatch(/your bill/);
    }
  });

  it("slides, so a burst across a boundary cannot double the allowance", () => {
    // The shape a retry storm produces, and the reason this is not a fixed
    // bucket.
    const c = clock();
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, c.now);
    limiter.take();
    c.advance(900);
    limiter.take();
    c.advance(150); // the first call has now aged out, the second has not
    limiter.take();
    expect(() => limiter.take()).toThrow(RateLimitedError);
  });

  it("frees the whole allowance once the window has passed", () => {
    const c = clock();
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, c.now);
    limiter.take();
    limiter.take();
    c.advance(1100);
    expect(limiter.remaining()).toBe(2);
    expect(() => limiter.take()).not.toThrow();
  });

  describe("check and record are separate", () => {
    /**
     * The split exists so a caller can check once, outside its retry loop, and
     * record per attempt. Combining them raises a `rate_limited` error inside
     * the loop, which the policy table treats as retryable — and Sherpa would
     * sit retrying its own refusal to spend money.
     */
    it("check does not consume an allowance", () => {
      const c = clock();
      const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, c.now);
      limiter.check();
      limiter.check();
      limiter.check();
      expect(limiter.remaining()).toBe(2);
    });

    it("record counts retries towards the ceiling without throwing", () => {
      const c = clock();
      const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, c.now);
      limiter.record();
      limiter.record();
      // Retries are exactly the runaway the ceiling is for, so they must count
      // — but recording them must not itself raise inside the retry loop.
      expect(() => limiter.record()).not.toThrow();
      expect(() => limiter.check()).toThrow(RateLimitedError);
    });
  });

  it("reset clears the window", () => {
    const c = clock();
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 }, c.now);
    limiter.take();
    limiter.reset();
    expect(() => limiter.take()).not.toThrow();
  });
});
