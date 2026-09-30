// Three-way Off / Dansk / English selector hooked into DR's existing
// subtitle button. Off and Dansk are driven by forwarding a synthetic
// click to DR's own button (we can't reliably toggle DR's Danish track
// from outside — see docs/extension-plan.md §4 degrade path).
//
// Sibling "EN" pill is the fallback if DR's button can't be found.

import type { SubMode } from "../shared/types.js";

const MARK = "data-drtv-en";
const BUTTON_RE = /subtitle|caption|undertekst|cc\b|sprog|language/;

export interface MenuController {
  setSelection(mode: SubMode): void;
  setTopPosition(top: boolean): void;
  dispatchDrClick(): boolean; // returns true if a click was dispatched
  destroy(): void;
}

export interface MenuOptions {
  onPick: (mode: SubMode) => void;
  onTogglePosition: (top: boolean) => void;
  initialTopPosition: boolean;
  signal?: AbortSignal;
}

// Bypass flag for synthetic clicks we dispatch on DR's button. The
// capture-phase interceptor checks this and lets the event through
// unmodified so DR's own handler runs.
let bypassNext = false;

export function attachMenu(opts: MenuOptions): Promise<MenuController> {
  ensureStyles();
  return new Promise((resolve) => {
    let controller: MenuController | null = null;
    let currentSelection: SubMode = "off";
    let currentTop = opts.initialTopPosition;
    let drButton: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (next: MenuController): void => {
      if (settled) {
        next.destroy();
        return;
      }
      settled = true;
      observer?.disconnect();
      observer = null;
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(next);
    };

    const onAbort = (): void => finish(NOOP_MENU);
    if (opts.signal?.aborted) {
      finish(NOOP_MENU);
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const tryAttach = (): boolean => {
      const btn = findSubtitleButton();
      if (!btn) return false;
      if (btn.hasAttribute(MARK)) return false;
      btn.setAttribute(MARK, "hooked");
      drButton = btn;
      const onClick = (e: MouseEvent): void => {
        if (bypassNext) return; // synthetic click — let DR handle it
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        openMenu(
          btn,
          currentSelection,
          currentTop,
          (mode) => {
            currentSelection = mode;
            opts.onPick(mode);
          },
          (top) => {
            currentTop = top;
            opts.onTogglePosition(top);
          },
        );
      };
      btn.addEventListener("click", onClick, true);
      console.log("[drtv-en/content] hooked DR subtitle button");
      controller = {
        setSelection(mode) {
          currentSelection = mode;
        },
        setTopPosition(top) {
          currentTop = top;
        },
        dispatchDrClick() {
          if (!drButton) return false;
          bypassNext = true;
          try {
            drButton.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true }),
            );
          } finally {
            bypassNext = false;
          }
          return true;
        },
        destroy() {
          btn.removeEventListener("click", onClick, true);
          btn.removeAttribute(MARK);
          closeMenu();
        },
      };
      finish(controller);
      return true;
    };

    if (tryAttach()) return;

    observer = new MutationObserver(() => {
      if (tryAttach()) observer?.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    fallbackTimer = setTimeout(() => {
      if (settled) return;
      observer?.disconnect();
      observer = null;
      const candidate = findSubtitleButton();
      if (!candidate) {
        finish(NOOP_MENU);
        return;
      }
      const pill = insertPill(
        candidate,
        (mode) => {
          currentSelection = mode;
          opts.onPick(mode);
        },
        (top) => {
          currentTop = top;
          opts.onTogglePosition(top);
        },
        () => currentSelection,
        () => currentTop,
      );
      controller = {
        setSelection(mode) {
          currentSelection = mode;
        },
        setTopPosition(top) {
          currentTop = top;
        },
        dispatchDrClick() {
          return false;
        },
        destroy() {
          pill.remove();
          closeMenu();
        },
      };
      finish(controller);
    }, 20_000);
  });
}

const NOOP_MENU: MenuController = {
  setSelection() {},
  setTopPosition() {},
  dispatchDrClick() {
    return false;
  },
  destroy() {},
};

function findSubtitleButton(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>("button, [role='button']");
  for (const el of all) {
    if (el.hasAttribute(MARK)) continue;
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    const rawCls: unknown = el.className;
    const cls = (typeof rawCls === "string" ? rawCls : String(rawCls ?? "")).toLowerCase();
    if (BUTTON_RE.test(`${aria} ${cls}`)) return el;
  }
  return null;
}

let openEl: HTMLElement | null = null;
function closeMenu() {
  if (openEl) {
    openEl.remove();
    openEl = null;
  }
}

function openMenu(
  anchor: HTMLElement,
  current: SubMode,
  currentTop: boolean,
  onPick: (mode: SubMode) => void,
  onTogglePosition: (top: boolean) => void,
) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "drtv-en-menu";
  menu.setAttribute(MARK, "menu");

  for (const [key, label] of [
    ["off", "Off"],
    ["dansk", "Dansk"],
    ["english", "English"],
  ] as [SubMode, string][]) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.setAttribute("aria-checked", String(key === current));
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(key);
      closeMenu();
    });
    menu.appendChild(item);
  }

  const sep = document.createElement("div");
  sep.className = "drtv-en-sep";
  menu.appendChild(sep);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "drtv-en-toggle";
  toggle.textContent = currentTop
    ? "Move subs to bottom"
    : "Move subs to top";
  toggle.title =
    "Use this if Danish subtitles are baked into the video and overlap with the English ones";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    onTogglePosition(!currentTop);
    closeMenu();
  });
  menu.appendChild(toggle);

  const r = anchor.getBoundingClientRect();
  menu.style.left = `${window.scrollX + r.left}px`;
  menu.style.top = `${window.scrollY + r.top - 8}px`;
  menu.style.transform = "translateY(-100%)";
  document.body.appendChild(menu);
  openEl = menu;

  setTimeout(() => {
    const away = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        closeMenu();
        document.removeEventListener("click", away, true);
      }
    };
    document.addEventListener("click", away, true);
  }, 0);
}

function insertPill(
  reference: HTMLElement,
  onPick: (mode: SubMode) => void,
  onTogglePosition: (top: boolean) => void,
  getCurrent: () => SubMode,
  getCurrentTop: () => boolean,
): HTMLElement {
  const pill = document.createElement("button");
  pill.setAttribute(MARK, "pill");
  pill.textContent = "EN";
  pill.title = "DRTV in English";
  Object.assign(pill.style, {
    marginLeft: "8px",
    padding: "2px 8px",
    background: "#0a84ff",
    color: "white",
    border: "0",
    borderRadius: "999px",
    font: "600 12px system-ui, sans-serif",
    cursor: "pointer",
  });
  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(pill, getCurrent(), getCurrentTop(), onPick, onTogglePosition);
  });
  reference.insertAdjacentElement("afterend", pill);
  return pill;
}

function ensureStyles() {
  if (document.getElementById("drtv-en-style")) return;
  const style = document.createElement("style");
  style.id = "drtv-en-style";
  style.textContent = `
    .drtv-en-menu {
      position: absolute;
      z-index: 2147483647;
      min-width: 140px;
      padding: 4px 0;
      background: rgba(20,20,20,0.95);
      color: white;
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      font: 500 14px system-ui, -apple-system, sans-serif;
    }
    .drtv-en-menu button {
      display: block;
      width: 100%;
      padding: 8px 14px;
      background: transparent;
      color: inherit;
      border: 0;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .drtv-en-menu button:hover {
      background: rgba(255,255,255,0.12);
    }
    .drtv-en-menu button[aria-checked="true"]::before {
      content: "✓ ";
    }
    .drtv-en-menu .drtv-en-sep {
      height: 1px;
      margin: 4px 0;
      background: rgba(255,255,255,0.15);
    }
    .drtv-en-menu button.drtv-en-toggle {
      font-size: 12px;
      opacity: 0.85;
    }
    .drtv-en-status {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2147483647;
      padding: 14px 20px;
      background: rgba(20,20,20,0.82);
      color: white;
      font: 500 14px system-ui, -apple-system, sans-serif;
      border-radius: 10px;
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.4);
    }
    .drtv-en-status .drtv-en-spinner {
      display: none;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.25);
      border-top-color: #fff;
      animation: drtv-en-spin 0.8s linear infinite;
    }
    .drtv-en-status.drtv-en-busy .drtv-en-spinner {
      display: inline-block;
    }
    @keyframes drtv-en-spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}
