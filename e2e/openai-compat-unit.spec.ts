import { test, expect } from "@playwright/test";
import { __testing } from "../apps/desktop/src/main/openai-compat";

/**
 * The output-token cap has two spellings and picking the wrong one is a 400 on
 * the first message. OpenAI's reasoning models (o-series, GPT-5) require
 * `max_completion_tokens`; everything else takes `max_tokens`. The app's
 * default OpenAI model is gpt-5, so this is the default path.
 */
const { tokenLimit } = __testing;

test("OpenAI reasoning models get max_completion_tokens", () => {
  for (const model of ["gpt-5", "gpt-5-mini", "o3", "o4-mini"]) {
    expect(tokenLimit("https://api.openai.com/v1", model, 16000), model).toEqual({
      max_completion_tokens: 16000,
    });
  }
});

test("older OpenAI models keep max_tokens", () => {
  expect(tokenLimit("https://api.openai.com/v1", "gpt-4o", 16000)).toEqual({ max_tokens: 16000 });
});

test("a local or gateway endpoint keeps max_tokens", () => {
  // Ollama and most compatible servers only know max_tokens; sending the other
  // spelling to them is the mirror-image failure.
  expect(tokenLimit("http://localhost:11434/v1", "llama3.1", 16000)).toEqual({ max_tokens: 16000 });
  expect(tokenLimit("https://openrouter.ai/api/v1", "anthropic/claude-opus-5", 16000)).toEqual({
    max_tokens: 16000,
  });
});

test("OpenRouter's own openai/* routes take the reasoning spelling", () => {
  expect(tokenLimit("https://openrouter.ai/api/v1", "openai/gpt-5", 16000)).toEqual({
    max_completion_tokens: 16000,
  });
});
