// Provider configuration persisted in chrome.storage.local. Each
// preset binds an API shape (/messages, /responses, /chat/completions, or
// /translate) to a default endpoint and model; both are user-editable.

export type Provider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "alx"
  | "libretranslate"
  | "openai-compatible";

export interface ProviderConfig {
  provider: Provider;
  endpoint: string;
  apiKey: string;
  model: string;
  batchSize: number;
  contextWindow: number;
  maxParallel: number;
}

export interface ProviderPreset {
  label: string;
  endpoint: string;
  model: string;
}

export const PROVIDER_PRESETS: Record<Provider, ProviderPreset> = {
  anthropic: {
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-haiku-4-5",
  },
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/responses",
    model: "gpt-5-mini",
  },
  gemini: {
    label: "Gemini",
    endpoint:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.5-flash",
  },
  alx: {
    label: "ALX",
    endpoint: "https://inference.alexandra.dk/v1/chat/completions",
    model: "qwen3.5-397b",
  },
  libretranslate: {
    label: "LibreTranslate",
    endpoint: "http://127.0.0.1:5000/translate",
    model: "libretranslate",
  },
  "openai-compatible": {
    label: "OpenAI-compatible",
    endpoint: "",
    model: "",
  },
};

const DEFAULTS: ProviderConfig = {
  provider: "alx",
  endpoint: PROVIDER_PRESETS.alx.endpoint,
  apiKey: "",
  model: PROVIDER_PRESETS.alx.model,
  batchSize: 5,
  contextWindow: 6,
  maxParallel: 20,
};

const KEY = "providerConfig";

export async function loadProviderConfig(): Promise<ProviderConfig> {
  const got = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...(got[KEY] ?? {}) };
}

export async function saveProviderConfig(cfg: ProviderConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: cfg });
}

// Per provider+model maxParallel cache — stores the last known working
// value to avoid re-probing on every session.
export async function loadMaxParallel(
  provider: string,
  model: string,
): Promise<number | null> {
  const key = `maxParallel:${provider}:${model}`;
  const got = await chrome.storage.local.get(key);
  return got[key] ?? null;
}

export async function saveMaxParallel(
  provider: string,
  model: string,
  value: number,
): Promise<void> {
  const key = `maxParallel:${provider}:${model}`;
  await chrome.storage.local.set({ [key]: value });
}
