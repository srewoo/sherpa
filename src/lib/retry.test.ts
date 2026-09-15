import { describe, it, expect, vi } from "vitest";
import { retryWithBackoff, jitteredDelay, defaultIsRetryable, JITTER_LOWER, JITTER_UPPER } from "./retry.js";
import { ProviderError } from "./errorKind.js";

const nosleep = () => Promise.resolve();

describe("retryWithBackoff", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(nosleep);
    const out = await retryWithBackoff(() => Promise.resolve("ok"), { sleep });
    expect(out).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a rate limit and succeeds on the second attempt", async () => {
    let calls = 0;
    const out = await retryWithBackoff(
      () => {
        calls += 1;
        if (calls === 1) throw new ProviderError({ kind: "rate_limited", message: "429" });
        return Promise.resolve("answered");
      },
      { sleep: nosleep },
    );
    expect(out).toBe("answered");
    expect(calls).toBe(2);
  });

  it("does not retry a rejected key — the whole point of classifying first", async () => {
    let calls = 0;
    const sleep = vi.fn(nosleep);
    await expect(
      retryWithBackoff(
        () => {
          calls += 1;
          throw new ProviderError({ kind: "auth_invalid", message: "bad key" });
        },
        { sleep },
      ),
    ).rejects.toThrow("bad key");
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows the original error, not a wrapper, once attempts run out", async () => {
    const err = new ProviderError({ kind: "provider_down", message: "503" });
    await expect(
      retryWithBackoff(() => Promise.reject(err), { sleep: nosleep, attempts: 2 }),
    ).rejects.toBe(err);
  });

  it("sleeps between attempts but not after the last one", async () => {
    const sleep = vi.fn(nosleep);
    await expect(
      retryWithBackoff(() => Promise.reject(new ProviderError({ kind: "timeout", message: "t" })), {
        sleep,
        attempts: 3,
      }),
    ).rejects.toThrow();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports each retry so the panel can say something instead of stalling", async () => {
    const onRetry = vi.fn();
    await expect(
      retryWithBackoff(() => Promise.reject(new ProviderError({ kind: "rate_limited", message: "x" })), {
        sleep: nosleep,
        attempts: 2,
        onRetry,
      }),
    ).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, kind: "rate_limited" });
  });

  it("rejects a nonsense attempt count rather than silently running once", async () => {
    await expect(retryWithBackoff(() => Promise.resolve(1), { attempts: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("jitteredDelay", () => {
  it("stays inside the multiplicative bounds", () => {
    expect(jitteredDelay(1000, () => 0)).toBe(1000 * JITTER_LOWER);
    expect(jitteredDelay(1000, () => 1)).toBeCloseTo(1000 * JITTER_UPPER);
  });
});

describe("defaultIsRetryable", () => {
  it("follows the policy table", () => {
    expect(defaultIsRetryable(new ProviderError({ kind: "provider_down", message: "" }))).toBe(true);
    expect(defaultIsRetryable(new ProviderError({ kind: "cancelled", message: "" }))).toBe(false);
  });
});
