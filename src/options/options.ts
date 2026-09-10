// Options page: pick a provider (which preloads default endpoint +
// model), edit any field, and persist to chrome.storage.local. When
// the user switches provider, fields that still hold the previous
// preset's defaults are updated to the new preset; fields the user
// has customized are left alone.

import {
  PROVIDER_PRESETS,
  loadProviderConfig,
  saveProviderConfig,
  type Provider,
  type ProviderConfig,
} from "../shared/storage.js";
import { clearCache, getCacheStats } from "../background/cache.js";

function $(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as HTMLInputElement;
}

function $sel(id: string): HTMLSelectElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as HTMLSelectElement;
}

function populateProviders(): void {
  const sel = $sel("provider");
  // Alphabetical by label, but keep the generic "OpenAI-compatible"
  // catch-all pinned to the end.
  const entries = Object.entries(PROVIDER_PRESETS).sort(([a, pa], [b, pb]) => {
    if (a === "openai-compatible") return 1;
    if (b === "openai-compatible") return -1;
    return pa.label.localeCompare(pb.label);
  });
  for (const [key, preset] of entries) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = preset.label;
    sel.appendChild(opt);
  }
}

// Switching provider resets the endpoint and model to that provider's
// preset defaults, and clears the API key — a key is provider-specific, so
// carrying the previous provider's key over is never what the user wants.
// Only fires on an explicit provider change, not on initial load, so the
// saved key is preserved when the page opens.
function applyPreset(next: Provider): void {
  const preset = PROVIDER_PRESETS[next];
  $("endpoint").value = preset.endpoint;
  $("model").value = preset.model;
  $("apiKey").value = "";
}

// Request host access for the configured endpoint's host. Resolves true if
// access is already held or the user grants it. Built-in providers are
// already in `host_permissions`, so no prompt appears for them. Once
// granted, the background fetch to that host is CORS-exempt — no proxy
// needed. Must run inside a user gesture (the save click).
async function ensureEndpointPermission(endpoint: string): Promise<boolean> {
  let origins: string[];
  try {
    const url = new URL(endpoint);
    // Match patterns can't carry a port, so scope to the host — a portless
    // host pattern matches every port on it (e.g. local `http://localhost`
    // endpoints on :8080/:11434). Keep the scheme so `http://` endpoints
    // resolve to an http pattern.
    origins = [`${url.protocol}//${url.hostname}/*`];
  } catch {
    return true; // not a valid URL; the save-time field validation handles it
  }
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

// Custom ("OpenAI-compatible") servers — local models in particular — often
// don't check the key, but the field stays required. Spell out that any
// value works there so the user isn't stuck wondering what to type.
function setApiKeyLabel(provider: Provider): void {
  const label = document.querySelector('label[for="apiKey"]');
  if (!label) return;
  label.textContent =
    provider === "libretranslate"
      ? "API key (optional)"
      : provider === "openai-compatible"
      ? "API key (enter any value if the server doesn't require one)"
      : "API key";
}

async function init(): Promise<void> {
  populateProviders();
  const cfg = await loadProviderConfig();

  $sel("provider").value = cfg.provider;
  $("endpoint").value = cfg.endpoint || PROVIDER_PRESETS[cfg.provider].endpoint;
  $("model").value = cfg.model || PROVIDER_PRESETS[cfg.provider].model;
  $("apiKey").value = cfg.apiKey;
  setApiKeyLabel(cfg.provider);

  $sel("provider").addEventListener("change", () => {
    const provider = $sel("provider").value as Provider;
    applyPreset(provider);
    setApiKeyLabel(provider);
  });

  document.getElementById("save")!.addEventListener("click", async () => {
    const status = document.getElementById("status")!;
    status.classList.remove("error");
    const provider = $sel("provider").value as Provider;
    const endpoint = $("endpoint").value.trim();
    const model = $("model").value.trim();
    const apiKey = $("apiKey").value;
    if (!endpoint || !model || (provider !== "libretranslate" && !apiKey)) {
      status.classList.add("error");
      status.textContent =
        "Endpoint, model, and API key are all required.";
      return;
    }

    // Make sure we're allowed to reach the endpoint host before saving.
    // Built-in providers ship in `host_permissions`, so this resolves
    // instantly with no prompt; a custom endpoint's host isn't pre-granted,
    // so the user sees a permission prompt scoped to just that origin —
    // otherwise the translation fetch would fail on CORS with no hint why.
    // Kept before any other `await` so the click's user gesture is still
    // live when `chrome.permissions.request` runs.
    if (!(await ensureEndpointPermission(endpoint))) {
      status.classList.add("error");
      status.textContent =
        "Can't translate without permission to reach that endpoint. Save again to retry.";
      return;
    }

    const prev = await loadProviderConfig();
    const next: ProviderConfig = {
      provider,
      endpoint,
      model,
      apiKey,
      batchSize: prev.batchSize,
      contextWindow: prev.contextWindow,
      maxParallel: prev.maxParallel,
    };
    await saveProviderConfig(next);
    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 2000);
  });
}

async function refreshCacheStats(): Promise<void> {
  const el = document.getElementById("cacheStats")!;
  try {
    const { entries, bytes } = await getCacheStats();
    if (entries === 0) {
      el.textContent = "Nothing cached yet.";
    } else {
      el.textContent = `${entries} episode${entries === 1 ? "" : "s"} cached (${formatBytes(bytes)}).`;
    }
  } catch (err) {
    el.textContent = `Cache unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

document.getElementById("clearCache")?.addEventListener("click", async () => {
  await clearCache();
  await refreshCacheStats();
});

void init().then(refreshCacheStats);
