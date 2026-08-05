/**
 * Ambient types for Chrome's built-in Prompt API (Gemini Nano). Not yet in
 * @types/chrome. Exposed as a global `LanguageModel` in extension contexts on
 * supported Chrome builds.
 */

export type LanguageModelState = "available" | "downloadable" | "downloading" | "unavailable";

/**
 * Language declaration for a session. Chrome warns when output language is
 * unspecified — it can't attest to output safety without knowing the target
 * language, and quality degrades — so both directions are always declared.
 */
export interface LanguageModelExpectation {
  readonly type: "text";
  readonly languages: readonly string[];
}

export interface LanguageModelOptions {
  readonly initialPrompts?: { role: string; content: string }[];
  readonly expectedInputs?: readonly LanguageModelExpectation[];
  readonly expectedOutputs?: readonly LanguageModelExpectation[];
}

export interface LanguageModelSession {
  promptStreaming(input: string): AsyncIterable<string>;
  prompt(input: string): Promise<string>;
  destroy(): void;
}

export interface LanguageModelStatic {
  availability(options?: LanguageModelOptions): Promise<LanguageModelState>;
  create(options?: LanguageModelOptions): Promise<LanguageModelSession>;
}

declare global {
  // eslint-disable-next-line no-var
  var LanguageModel: LanguageModelStatic | undefined;
}
