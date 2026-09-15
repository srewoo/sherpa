import { describe, it, expect } from "vitest";
import {
  ProviderError,
  kindForMessage,
  kindForResponse,
  kindForThrown,
  policyFor,
  remedyFor,
  type ProviderErrorKind,
} from "./errorKind.js";

describe("kindForResponse", () => {
  it("separates a throttle from an exhausted quota on the same 429", () => {
    expect(kindForResponse(429, "Rate limit reached for gpt-4o")).toBe("rate_limited");
    expect(kindForResponse(429, '{"error":{"code":"insufficient_quota"}}')).toBe("quota_exhausted");
  });

  it("treats a rejected key as terminal rather than retryable", () => {
    expect(kindForResponse(401, "Incorrect API key provided")).toBe("auth_invalid");
    expect(policyFor("auth_invalid").retryable).toBe(false);
    expect(policyFor("auth_invalid").terminal).toBe(true);
  });

  it("reads a bad model name out of a 400 body, not just a 404", () => {
    expect(kindForResponse(400, "The model `gpt-5.4-mini` does not exist")).toBe("model_not_found");
    expect(kindForResponse(404, "")).toBe("model_not_found");
  });

  it("classifies a safety refusal from the body of a 400", () => {
    expect(kindForResponse(400, '{"error":{"type":"prohibited_content"}}')).toBe("content_filtered");
  });

  it("maps 5xx to provider_down and leaves it auto-retryable", () => {
    expect(kindForResponse(503, "upstream unavailable")).toBe("provider_down");
    expect(policyFor("provider_down").autoRetry).toBe(true);
  });
});

describe("kindForThrown", () => {
  it("reads the same AbortError as a timeout or a cancel depending on who asked", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(kindForThrown(abort)).toBe("timeout");
    expect(kindForThrown(abort, { cancelled: true })).toBe("cancelled");
  });

  it("treats fetch's bare TypeError as a network failure", () => {
    expect(kindForThrown(new TypeError("Failed to fetch"))).toBe("network");
  });

  it("passes an already-classified error through unchanged", () => {
    const err = new ProviderError({ kind: "quota_exhausted", message: "no credit" });
    expect(kindForThrown(err)).toBe("quota_exhausted");
  });
});

describe("policy table", () => {
  const kinds: readonly ProviderErrorKind[] = [
    "auth_invalid", "rate_limited", "quota_exhausted", "model_not_found",
    "bad_request", "content_filtered", "provider_down", "timeout",
    "cancelled", "network", "empty_stream", "stream_truncated",
    "circuit_open", "unknown",
  ];

  it("covers every kind", () => {
    for (const kind of kinds) expect(policyFor(kind)).toBeDefined();
  });

  it("never auto-retries a terminal failure", () => {
    for (const kind of kinds) {
      const p = policyFor(kind);
      if (p.terminal) expect(p.autoRetry).toBe(false);
    }
  });

  it("never counts a user cancel or a user misconfiguration against the provider", () => {
    for (const kind of ["cancelled", "auth_invalid", "model_not_found", "quota_exhausted", "bad_request"] as const) {
      expect(policyFor(kind).trips).toBe(false);
    }
  });

  it("shows a user's own cancel silently", () => {
    expect(policyFor("cancelled").presentation).toBe("silent");
  });
});

describe("remedyFor", () => {
  it("points a rejected key and an empty wallet at different fixes", () => {
    expect(remedyFor("auth_invalid")).toMatch(/API key in Settings/i);
    expect(remedyFor("quota_exhausted")).toMatch(/credit/i);
  });

  it("says nothing when there is nothing useful to say", () => {
    expect(remedyFor("cancelled")).toBeUndefined();
    expect(remedyFor("content_filtered")).toBeUndefined();
  });
});

describe("kindForMessage", () => {
  it("classifies an in-band frame that has no status to read", () => {
    expect(kindForMessage("Rate limit reached mid-stream")).toBe("rate_limited");
    expect(kindForMessage("Internal server error")).toBe("provider_down");
    expect(kindForMessage("stopped for safety")).toBe("content_filtered");
  });

  it("reads an exhausted quota ahead of the rate-limit wording it also contains", () => {
    // "You exceeded your current quota, please check your plan and billing"
    // matches both tables; treating it as a throttle is how a tool retries a
    // declined card for thirty seconds.
    expect(kindForMessage("You exceeded your current quota — rate limit reached")).toBe(
      "quota_exhausted",
    );
  });

  it("admits when it cannot tell", () => {
    expect(kindForMessage("something went sideways")).toBe("unknown");
  });
});
