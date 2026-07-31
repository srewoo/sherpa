/**
 * Ambient types for Chrome's built-in Prompt API (Gemini Nano). Not yet in
 * @types/chrome. Exposed as a global `LanguageModel` in extension contexts on
 * supported Chrome builds.
 */

export type LanguageModelState = "available" | "downloadable" | "downloading" | "unavailable";

export interface LanguageModelSession {
  promptStreaming(input: string): AsyncIterable<string>;
  prompt(input: string): Promise<string>;
  destroy(): void;
}

export interface LanguageModelStatic {
  availability(): Promise<LanguageModelState>;
  create(options?: { readonly initialPrompts?: { role: string; content: string }[] }): Promise<LanguageModelSession>;
}

declare global {
  // eslint-disable-next-line no-var
  var LanguageModel: LanguageModelStatic | undefined;
}
