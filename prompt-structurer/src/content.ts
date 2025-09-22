const DEBUG_PREFIX = "Prompt Structurer:";
const OBSERVER_TIMEOUT_MS = 4000;

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
