import { describe, it, expect } from "vitest";
import { maskPii, containsPii, EGRESS_KINDS } from "./pii.js";

describe("maskPii", () => {
  it("redacts an email out of a question", () => {
    expect(maskPii("why can't sarah.chen@acme.com log in")).toBe("why can't [email] log in");
  });

  it("redacts a pasted provider key", () => {
    expect(maskPii("my key sk-abcdefghij0123456789 stopped working")).toContain("[api-key]");
    expect(maskPii("token ghp_abcdefghij0123456789ab is rejected")).toContain("[api-key]");
  });

  it("redacts card numbers, SSNs, UUIDs and IPs", () => {
    expect(maskPii("card 4111 1111 1111 1111")).toContain("[card]");
    expect(maskPii("ssn 123-45-6789")).toContain("[ssn]");
    expect(maskPii("record 4f2a1b3c-5d6e-7f80-9a1b-2c3d4e5f6071")).toContain("[id]");
    expect(maskPii("host 192.168.1.44 refused")).toContain("[ip]");
  });

  it("redacts every occurrence, not just the first", () => {
    expect(maskPii("a@b.com and c@d.com")).toBe("[email] and [email]");
  });

  /**
   * A `/g` regex carries `lastIndex` between calls, so a module-level shared
   * one silently skips matches on every second string. This is the test that
   * catches that, and it is worth having because the symptom — half the logs
   * masked, half not — looks like a pattern problem rather than a state one.
   */
  it("does not carry regex state between calls", () => {
    const input = "reach me at a@b.com";
    expect(maskPii(input)).toBe(maskPii(input));
    expect(maskPii(input)).toBe("reach me at [email]");
  });

  describe("leaves the substance of a documentation question alone", () => {
    const questions = [
      "how do I upgrade to version 2.4.1",
      "what does error 404 mean",
      "why is port 8080 blocked",
      "how do I set maxPages to 5000",
      "what changed in release 10.2",
      "rotate an API key",
    ];
    for (const q of questions) {
      it(q, () => {
        expect(maskPii(q)).toBe(q);
      });
    }
  });

  it("redacts the longer shape rather than leaving a half-masked value", () => {
    // A card number contains something phone-shaped; redacting the fragment
    // would leak the rest while looking redacted.
    const masked = maskPii("4111 1111 1111 1111");
    expect(masked).toBe("[card]");
    expect(masked).not.toContain("1111");
  });

  it("can be narrowed to a set of kinds", () => {
    const text = "record 4f2a1b3c-5d6e-7f80-9a1b-2c3d4e5f6071 for a@b.com";
    const egress = maskPii(text, { kinds: EGRESS_KINDS });
    // The email goes; the record id stays, because it is what the question is
    // actually about and stripping it would send a question nobody asked.
    expect(egress).toContain("[email]");
    expect(egress).toContain("4f2a1b3c");
  });
});

describe("containsPii", () => {
  it("reports whether masking would change anything", () => {
    expect(containsPii("how do I reset a password")).toBe(false);
    expect(containsPii("reset the password for a@b.com")).toBe(true);
  });
});
