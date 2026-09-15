import { describe, it, expect } from "vitest";
import { classifyIntent } from "./intent.js";

describe("classifyIntent", () => {
  it("recognises bare greetings, thanks, farewells and acknowledgements", () => {
    for (const q of ["hi", "Hello!", "hey there", "thanks", "Thank you so much", "bye", "ok", "perfect"]) {
      expect(classifyIntent(q).intent, q).toBe("small-talk");
    }
  });

  it("always carries a reply with small talk, so the turn is never left empty", () => {
    const result = classifyIntent("thanks");
    expect(result.reply).toBeTruthy();
  });

  it("names the active site in a greeting when it knows one", () => {
    expect(classifyIntent("hi", "help.mindtickle.com").reply).toContain("help.mindtickle.com");
    expect(classifyIntent("hi").reply).toContain("Index a documentation site");
  });

  /**
   * The direction this must never fail in. A greeting mistaken for a question
   * wastes 25 ms; a question mistaken for a greeting loses the answer and
   * claims the docs were searched when they were not.
   */
  describe("never swallows a question", () => {
    it("treats anything with a question mark as a question, whatever the words are", () => {
      for (const q of ["ok?", "thanks?", "hi?", "great?", "yes?"]) {
        expect(classifyIntent(q).intent, q).toBe("question");
      }
    });

    it("does not match a greeting that has a question attached", () => {
      for (const q of [
        "thanks, where do assets live",
        "hi how do I rotate an API key",
        "ok so how does SSO work",
        "great, and for admins",
      ]) {
        expect(classifyIntent(q).intent, q).toBe("question");
      }
    });

    it("matches whole utterances, not substrings", () => {
      // "hi" is inside "hierarchy"; "ta" is inside "tags".
      for (const q of ["hierarchy", "tags", "history", "okta", "yesterday's report"]) {
        expect(classifyIntent(q).intent, q).toBe("question");
      }
    });

    it("refuses to classify anything longer than a few words", () => {
      expect(classifyIntent("thanks for all the help with the assets page").intent).toBe("question");
    });

    it("treats an empty or whitespace query as a question rather than small talk", () => {
      expect(classifyIntent("   ").intent).toBe("question");
    });

    it("leaves real single-word searches alone", () => {
      for (const q of ["assets", "sso", "permissions", "hub", "reset", "billing"]) {
        expect(classifyIntent(q).intent, q).toBe("question");
      }
    });
  });
});
