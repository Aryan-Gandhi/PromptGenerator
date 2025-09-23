const DEBUG_PREFIX = "Prompt Structurer:";
const OBSERVER_TIMEOUT_MS = 4000;
const LAUNCHER_ROOT_ID = "promptgear-floating-launcher";
const PANEL_IFRAME_ID = "promptgear-floating-panel";
const MIN_PANEL_HEIGHT = 260;
const MAX_PANEL_HEIGHT = 640;
const DRAG_MIN_TOP = 80;
const DRAG_BOTTOM_PADDING = 120;

let detachPanelMessageListener: (() => void) | null = null;
let detachPositionListener: (() => void) | null = null;
let savedTopPx: number | null = null;
let savedHasCustomPosition = false;

const INPUT_SELECTORS = [
  '[contenteditable="true"][data-projection-id]',
  '[data-testid="chat-composer-input"] div[contenteditable="true"]',
  '[data-testid="chat-composer-input"] [role="textbox"]',
  '[data-testid="textbox"]',
  '[role="textbox"]',
  "textarea#prompt-textarea",
  "textarea[data-id]",
  "form textarea",
  "textarea",
  '[contenteditable="true"]'
];

type InputTarget = HTMLTextAreaElement | HTMLElement;

function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    console.log(DEBUG_PREFIX, "skipping hidden element", el, style.display, style.visibility, style.opacity);
    return false;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    console.log(DEBUG_PREFIX, "skipping zero-size element", el, rect);
    return false;
  }

  return true;
}

function findInput(): InputTarget | null {
  for (const selector of INPUT_SELECTORS) {
    const matches = Array.from(document.querySelectorAll(selector));
    if (matches.length) {
      console.log(DEBUG_PREFIX, "selector", selector, "matches", matches.length, matches);
    }

    for (const node of matches) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if (!isVisible(node)) {
        continue;
      }
      return node;
    }
  }
  return null;
}

function setTextareaValueReactSafe(el: HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  const setter = descriptor?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function setContentEditableValue(el: HTMLElement, value: string) {
  console.log(DEBUG_PREFIX, "setting contenteditable", el, value);
  el.focus({ preventScroll: true });

  const exec = (command: string, param?: string) => {
    const result = document.execCommand(command, false, param);
    console.log(DEBUG_PREFIX, "execCommand", command, result);
    return result;
  };

  exec("selectAll");
  const inserted = exec("insertText", value);

  if (!inserted) {
    el.innerHTML = value
      .split("\n")
      .map((line) => line === "" ? "<div><br></div>" : `<div>${line.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`)
      .join("");
  }

  const inputEvent = new InputEvent("input", {
    bubbles: true,
    data: value,
    inputType: "insertFromPaste"
  });
  el.dispatchEvent(inputEvent);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function applyValue(target: InputTarget, value: string) {
  if (target instanceof HTMLTextAreaElement) {
    console.log(DEBUG_PREFIX, "applying to textarea", target);
    setTextareaValueReactSafe(target, value);
  } else {
    console.log(DEBUG_PREFIX, "applying to contenteditable", target);
    setContentEditableValue(target, value);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "FETCH_CURRENT_TEXT") {
    const target = findInput();
    let text = "";
    if (target instanceof HTMLTextAreaElement) {
      text = target.value;
    } else if (target instanceof HTMLElement) {
      text = target.textContent ?? "";
    }
    try {
      sendResponse({ ok: !!target, text });
    } catch (error) {
      console.warn(DEBUG_PREFIX, "failed to send fetch response", error);
    }
    return true;
  }

  if (msg?.type !== "INJECT_TEXT") return;

  console.log(DEBUG_PREFIX, "received message", msg);

  const respond = (result: { ok: boolean; error?: string }) => {
    try {
      sendResponse(result);
    } catch (error) {
      console.warn(DEBUG_PREFIX, "failed to send response", error);
    }
  };

  const tryInsert = () => {
    const target = findInput();
    if (!target) {
      return false;
    }
    console.log(DEBUG_PREFIX, "found target", target, "type", target.tagName);
    applyValue(target, msg.payload.text);
    respond({ ok: true });
    return true;
  };

  if (tryInsert()) {
    return true;
  }

  const observer = new MutationObserver(() => {
    if (tryInsert()) {
      observer.disconnect();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  setTimeout(() => {
    observer.disconnect();
    console.warn(DEBUG_PREFIX, "unable to locate input after timeout");
    respond({ ok: false, error: "Unable to locate ChatGPT input." });
  }, OBSERVER_TIMEOUT_MS);

  return true;
});

function createFloatingLauncher() {
  if (document.getElementById(LAUNCHER_ROOT_ID)) {
    return;
  }

  if (detachPanelMessageListener) {
    detachPanelMessageListener();
    detachPanelMessageListener = null;
  }
  if (detachPositionListener) {
    detachPositionListener();
    detachPositionListener = null;
  }

  const iconUrl = chrome.runtime.getURL("icons/logo-48.png");
  const container = document.createElement("div");
  container.id = LAUNCHER_ROOT_ID;
  Object.assign(container.style, {
    position: "fixed",
    top: "50%",
    right: "0",
    transform: "translateY(-50%)",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    zIndex: "2147483647",
    padding: "4px",
    borderRadius: "12px 0 0 12px",
    background: "rgba(17, 24, 39, 0.85)",
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.32)",
    border: "1px solid rgba(148, 163, 184, 0.35)",
    backdropFilter: "blur(6px)",
    pointerEvents: "auto"
  });

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.setAttribute("aria-label", "Open PromptGear");
  toggleButton.setAttribute("aria-expanded", "false");
  Object.assign(toggleButton.style, {
    width: "44px",
    height: "44px",
    borderRadius: "50%",
    border: "1px solid rgba(148, 163, 184, 0.35)",
    background: "#ffffff",
    cursor: "grab",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    transition: "transform 160ms ease, box-shadow 160ms ease",
    boxShadow: "0 6px 18px rgba(15, 23, 42, 0.28)"
  });

  toggleButton.addEventListener("mouseenter", () => {
    toggleButton.style.transform = "translateX(-2px) scale(1.04)";
  });
  toggleButton.addEventListener("mouseleave", () => {
    toggleButton.style.transform = "translateX(0) scale(1)";
  });

  const icon = document.createElement("img");
  icon.src = iconUrl;
  icon.alt = "PromptGear";
  icon.style.width = "28px";
  icon.style.height = "28px";

  toggleButton.append(icon);
  container.append(toggleButton);

  const panel = document.createElement("iframe");
  panel.id = PANEL_IFRAME_ID;
  panel.src = chrome.runtime.getURL("src/popup.html#panel");
  panel.title = "PromptGear";
  Object.assign(panel.style, {
    position: "fixed",
    top: "50%",
    right: "64px",
    transform: "translateY(-50%)",
    width: "390px",
    height: "420px",
    border: "1px solid rgba(148, 163, 184, 0.35)",
    borderRadius: "16px",
    boxShadow: "0 24px 48px rgba(15, 23, 42, 0.45)",
    display: "none",
    background: "#ffffff",
    zIndex: "2147483647",
    overflow: "hidden"
  });

  let isOpen = false;
  let hasCustomPosition = savedHasCustomPosition;
  let currentTopPx = savedTopPx ?? window.innerHeight / 2;

  const applyPosition = (top: number, makeCustom: boolean) => {
    const maxTop = window.innerHeight - DRAG_BOTTOM_PADDING;
    const clamped = Math.max(DRAG_MIN_TOP, Math.min(maxTop, top));
    currentTopPx = clamped;
    if (makeCustom) {
      hasCustomPosition = true;
    }

    if (hasCustomPosition) {
      container.style.transform = "translateY(0)";
      panel.style.transform = "translateY(0)";
      container.style.top = `${clamped}px`;
      panel.style.top = `${clamped}px`;
    } else {
      container.style.transform = "translateY(-50%)";
      panel.style.transform = "translateY(-50%)";
      container.style.top = "50%";
      panel.style.top = "50%";
    }

    savedTopPx = clamped;
    savedHasCustomPosition = hasCustomPosition;
  };

  applyPosition(currentTopPx, hasCustomPosition);

  const closePanel = () => {
    if (!isOpen) return;
    isOpen = false;
    panel.style.display = "none";
    toggleButton.setAttribute("aria-expanded", "false");
  };

  const openPanel = () => {
    if (isOpen) return;
    isOpen = true;
    panel.style.display = "block";
    toggleButton.setAttribute("aria-expanded", "true");
  };

  let pointerId: number | null = null;
  let isPointerDown = false;
  let isDragging = false;
  let startY = 0;
  let startTop = 0;

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    isPointerDown = true;
    isDragging = false;
    pointerId = event.pointerId;
    startY = event.clientY;
    startTop = container.getBoundingClientRect().top;
    toggleButton.setPointerCapture(pointerId);
    toggleButton.style.cursor = "grabbing";
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!isPointerDown || pointerId === null || event.pointerId !== pointerId) {
      return;
    }
    const delta = event.clientY - startY;
    if (!isDragging && Math.abs(delta) > 4) {
      isDragging = true;
    }
    if (isDragging) {
      const newTop = startTop + delta;
      applyPosition(newTop, true);
      event.preventDefault();
    }
  };

  const handlePointerEnd = (event: PointerEvent) => {
    if (!isPointerDown || pointerId === null || event.pointerId !== pointerId) {
      return;
    }
    toggleButton.releasePointerCapture(pointerId);
    toggleButton.style.cursor = "grab";
    isPointerDown = false;
    pointerId = null;
    if (isDragging) {
      isDragging = false;
      return;
    }
    event.preventDefault();
    isOpen ? closePanel() : openPanel();
  };

  toggleButton.addEventListener("pointerdown", handlePointerDown);
  toggleButton.addEventListener("pointermove", handlePointerMove);
  toggleButton.addEventListener("pointerup", handlePointerEnd);
  toggleButton.addEventListener("pointercancel", handlePointerEnd);

  document.addEventListener(
    "click",
    (event) => {
      if (!isOpen) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const panelElement = document.getElementById(PANEL_IFRAME_ID);
      if (!panelElement) return;
      if (container.contains(target) || panelElement.contains(target)) {
        return;
      }
      closePanel();
    },
    true
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePanel();
    }
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (!mutation.removedNodes) continue;
      mutation.removedNodes.forEach((node) => {
        if (node === container || node === panel) {
          observer.disconnect();
          if (detachPanelMessageListener) {
            detachPanelMessageListener();
            detachPanelMessageListener = null;
          }
          if (detachPositionListener) {
            detachPositionListener();
            detachPositionListener = null;
          }
          createFloatingLauncher();
        }
      });
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.body.append(container);
  document.body.append(panel);

  const handlePanelMessage = (event: MessageEvent) => {
    if (!event.data || typeof event.data !== "object") return;
    if ((event.data as { type?: string }).type !== "PROMPTGEAR_PANEL_HEIGHT") {
      return;
    }
    if (event.source !== panel.contentWindow) {
      return;
    }
    const requested = Number((event.data as { height?: unknown }).height);
    if (!Number.isFinite(requested)) {
      return;
    }
    const clamped = Math.min(Math.max(requested, MIN_PANEL_HEIGHT), MAX_PANEL_HEIGHT);
    panel.style.height = `${clamped}px`;
  };

  window.addEventListener("message", handlePanelMessage);
  detachPanelMessageListener = () => {
    window.removeEventListener("message", handlePanelMessage);
  };

  const handleResize = () => {
    applyPosition(hasCustomPosition ? currentTopPx : window.innerHeight / 2, hasCustomPosition);
  };

  window.addEventListener("resize", handleResize);
  detachPositionListener = () => {
    window.removeEventListener("resize", handleResize);
  };
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", createFloatingLauncher);
} else {
  createFloatingLauncher();
}
