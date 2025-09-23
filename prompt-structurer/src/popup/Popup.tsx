import React, { useCallback, useEffect, useMemo, useState } from "react";
import { TRANSFORM_ENDPOINT, DEFAULT_MODEL } from "../config";
import { basicTransform } from "../transformer/basic";

type InjectResponse = { ok: true } | { ok: false; error?: string } | undefined;

type StatusTone = "info" | "success" | "error";

type StatusMessage = {
  tone: StatusTone;
  message: string;
};

type ProgressState = "pending" | "active" | "done" | "error";

type ProgressStep = {
  id: string;
  label: string;
  state: ProgressState;
};

export default function Popup() {
  const [raw, setRaw] = useState("");
  const [out, setOut] = useState("");
  const [isTransforming, setIsTransforming] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(
    "Pulls in your ChatGPT draft automatically."
  );

  const iconUrl = useMemo(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.getURL) {
      return null;
    }
    return chrome.runtime.getURL("icons/logo-32.png");
  }, []);

  useEffect(() => {
    if (window.location.hash === "#panel") {
      document.body.style.margin = "0";
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
    }
  }, []);

  const prefillFromChat = useCallback(
    (options?: { quiet?: boolean; cancelled?: () => boolean }) => {
      if (typeof chrome === "undefined" || !chrome.tabs?.query) {
        setSyncMessage("Chrome permissions missing. Paste a prompt to begin.");
        return Promise.resolve(false);
      }

      if (!options?.quiet) {
        setIsSyncing(true);
      }

      return new Promise<boolean>((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (options?.cancelled?.()) {
            resolve(false);
            return;
          }

          const tabId = tabs[0]?.id;
          if (!tabId) {
            setSyncMessage("Open ChatGPT in this tab to sync the draft.");
            resolve(false);
            return;
          }

          chrome.tabs.sendMessage(
            tabId,
            { type: "FETCH_CURRENT_TEXT" },
            (response: { ok?: boolean; text?: string } | undefined) => {
              if (options?.cancelled?.()) {
                resolve(false);
                return;
              }

              const runtimeError = chrome.runtime.lastError;
              if (runtimeError) {
                console.warn(
                  "Prompt Structurer: unable to fetch existing text",
                  runtimeError
                );
                setSyncMessage("Reload ChatGPT then click Sync.");
                resolve(false);
                return;
              }

              const text = response?.text ?? "";
              if (response?.ok && typeof text === "string" && text.trim()) {
                setRaw((current) => (current ? current : text));
                setSyncMessage("Prefilled from your ChatGPT draft.");
                resolve(true);
              } else {
                setSyncMessage("Start fresh: type or paste a prompt below.");
                resolve(false);
              }
            }
          );
        });
      }).finally(() => {
        if (!options?.quiet) {
          setIsSyncing(false);
        }
      });
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    prefillFromChat({ quiet: true, cancelled: () => cancelled }).catch(() => {
      /* ignore initial sync errors */
    });
    return () => {
      cancelled = true;
    };
  }, [prefillFromChat]);

  useEffect(() => {
    if (window.location.hash !== "#panel") {
      return;
    }

    const updateHeight = () => {
      const body = document.body;
      const html = document.documentElement;
      const height = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.clientHeight,
        html.scrollHeight,
        html.offsetHeight
      );
      window.parent?.postMessage({ type: "PROMPTGEAR_PANEL_HEIGHT", height }, "*");
    };

    updateHeight();

    const resizeObserver = new ResizeObserver(() => {
      updateHeight();
    });

    resizeObserver.observe(document.body);
    window.addEventListener("resize", updateHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [raw, out, status, progressSteps, isTransforming, syncMessage, isSyncing]);

  const runTransform = useCallback(
    async (silent = false) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        if (!silent) {
          setStatus({ tone: "info", message: "Enter a prompt first." });
          setProgressSteps([]);
        }
        setOut("");
        return "";
      }

      setIsTransforming(true);
      if (!silent) {
        setStatus({ tone: "info", message: "Starting transform…" });
        setProgressSteps([
          { id: "prepare", label: "Preparing prompt", state: "active" },
          { id: "request", label: "Contacting transformer service", state: "pending" },
          { id: "result", label: "Formatting structured prompt", state: "pending" }
        ]);
      }

      try {
        if (!silent) {
          setProgressSteps((steps) =>
            steps.map((step) => {
              if (step.id === "prepare") {
                return { ...step, state: "done" };
              }
              if (step.id === "request") {
                return { ...step, state: "active" };
              }
              return step;
            })
          );
        }

        const response = await fetch(TRANSFORM_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            prompt: trimmed,
            mode: "universal",
            model: DEFAULT_MODEL
          })
        });

        if (!silent) {
          setProgressSteps((steps) =>
            steps.map((step) => {
              if (step.id === "request") {
                return { ...step, state: "done" };
              }
              if (step.id === "result") {
                return { ...step, state: "active" };
              }
              return step;
            })
          );
        }

        const data = (await response.json().catch(() => null)) as
          | {
              structuredPrompt?: string;
              model?: string;
              mocked?: boolean;
              error?: string;
              details?: unknown;
            }
          | null;

        if (!response.ok || !data || !data.structuredPrompt) {
          const message = data?.error ?? `LLM transform failed (${response.status})`;
          throw new Error(message);
        }

        setOut(data.structuredPrompt);
        if (!silent) {
          const model = data.model ?? DEFAULT_MODEL;
          const mockSuffix = data.mocked ? " (mock)" : "";
          setProgressSteps((steps) =>
            steps.map((step) =>
              step.id === "result" ? { ...step, state: "done" } : step
            )
          );
          setStatus({ tone: "success", message: `Transformed with ${model}${mockSuffix}.` });
        }
        return data.structuredPrompt;
      } catch (error) {
        console.error("Prompt Structurer: LLM transform error", error);
        const fallback = basicTransform(trimmed);
        setOut(fallback);
        if (!silent) {
          setProgressSteps((steps) =>
            steps.map((step) =>
              step.state === "active" || step.state === "pending"
                ? { ...step, state: "error" }
                : step
            )
          );
          const message = error instanceof Error ? error.message : "LLM transform failed";
          setStatus({ tone: "error", message: `${message}. Using rule-based fallback.` });
        }
        return fallback;
      } finally {
        setIsTransforming(false);
      }
    },
    [raw]
  );

  const handleTransformClick = () => {
    runTransform(false).catch(() => {
      /* error already surfaced in status */
    });
  };

  const handleSyncClick = () => {
    prefillFromChat().catch(() => {
      setIsSyncing(false);
    });
  };

  const insert = async () => {
    setStatus(null);
    setProgressSteps([]);
    const payload = out || (await runTransform(true));
    if (!payload) {
      setStatus({ tone: "info", message: "Nothing to insert." });
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) {
        setStatus({ tone: "error", message: "Could not find the active tab." });
        return;
      }

      chrome.tabs.sendMessage(tabId, {
        type: "INJECT_TEXT",
        payload: { text: payload }
      }, (response: InjectResponse) => {
        const err = chrome.runtime.lastError;
        if (err) {
          setStatus({ tone: "error", message: err.message || "Failed to contact the page." });
          return;
        }
        if (!response) {
          setStatus({ tone: "error", message: "No response from page (reload chatgpt.com)." });
          return;
        }
        if (response.ok) {
          setStatus({ tone: "success", message: "Inserted into ChatGPT." });
        } else {
          setStatus({ tone: "error", message: response.error ?? "Page reported an error." });
        }
      });
    });
  };

  return (
    <div
      style={{
        width: 380,
        padding: window.location.hash === "#panel" ? 16 : 12,
        fontSize: 13,
        background: "#f9fafb",
        borderRadius: 16,
        boxShadow:
          window.location.hash === "#panel"
            ? "0 18px 46px rgba(15, 23, 42, 0.22)"
            : "none",
        border: "1px solid #e5e7eb"
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        {iconUrl && (
          <img
            src={iconUrl}
            alt="PromptGear"
            style={{ width: 28, height: 28 }}
          />
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: "#111827" }}>PromptGear</div>
          <div style={{ fontSize: 12, color: "#4b5563" }}>
            Structure or polish your draft before you hit send.
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "#eef2ff",
          color: "#3730a3",
          borderRadius: 10,
          padding: "6px 10px",
          marginBottom: 10
        }}
      >
        <span style={{ fontSize: 12 }}>{syncMessage}</span>
        <button
          onClick={handleSyncClick}
          style={{
            fontSize: 12,
            borderRadius: 8,
            border: "1px solid rgba(79, 70, 229, 0.4)",
            background: "#fff",
            padding: "4px 10px",
            color: "#3730a3",
            cursor: "pointer"
          }}
          disabled={isSyncing || isTransforming}
        >
          {isSyncing ? "Syncing…" : "Sync"}
        </button>
      </div>

      <label
        htmlFor="promptgear-raw"
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 600,
          color: "#1f2937",
          marginBottom: 6
        }}
      >
        Raw prompt draft
      </label>
      <textarea
        id="promptgear-raw"
        style={{
          width: "100%",
          minHeight: 120,
          borderRadius: 12,
          border: "1px solid #d1d5db",
          padding: "10px 12px",
          fontSize: 13,
          resize: "vertical",
          background: "#ffffff"
        }}
        placeholder="Drop in rough thoughts, bullet notes, or an unstructured prompt..."
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          onClick={handleTransformClick}
          style={{
            padding: "8px 14px",
            borderRadius: 10,
            border: "1px solid #d1d5db",
            background: "#ffffff",
            color: "#1f2937",
            cursor: "pointer",
            flex: 1
          }}
          disabled={isTransforming}
        >
          {isTransforming ? "Transforming…" : "Transform"}
        </button>
        <button
          onClick={insert}
          style={{
            padding: "8px 14px",
            borderRadius: 10,
            border: "none",
            background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
            color: "#fff",
            cursor: "pointer",
            flex: 1,
            boxShadow: "0 8px 18px rgba(37, 99, 235, 0.35)"
          }}
          disabled={isTransforming}
        >
          Insert into ChatGPT
        </button>
      </div>

      {status && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            borderRadius: 8,
            fontSize: 12,
            background:
              status.tone === "success"
                ? "#ecfdf5"
                : status.tone === "error"
                ? "#fef2f2"
                : "#f3f4f6",
            color:
              status.tone === "success"
                ? "#047857"
                : status.tone === "error"
                ? "#b91c1c"
                : "#374151"
          }}
        >
          {status.message}
        </div>
      )}

      {progressSteps.length > 0 && (
        <div
          style={{
            marginTop: 10,
            padding: "10px 12px",
            background: "#f8fafc",
            borderRadius: 12,
            border: "1px dashed #cbd5f5",
            fontSize: 12,
            lineHeight: 1.5
          }}
        >
          {progressSteps.map((step) => {
            const prefix =
              step.state === "done"
                ? "✓"
                : step.state === "active"
                ? "…"
                : step.state === "error"
                ? "!"
                : "○";
            const color =
              step.state === "error"
                ? "#b91c1c"
                : step.state === "done"
                ? "#047857"
                : step.state === "active"
                ? "#1d4ed8"
                : "#4b5563";
            return (
              <div
                key={step.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color,
                  marginBottom: 4
                }}
              >
                <span style={{ fontFamily: "monospace", width: 16 }}>{prefix}</span>
                <span>{step.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {out && (
        <div
          style={{
            marginTop: 12,
            background: "#ffffff",
            borderRadius: 12,
            border: "1px solid #e5e7eb",
            padding: "10px 12px",
            maxHeight: 180,
            overflow: "auto",
            fontFamily: "var(--font-mono, 'SFMono-Regular', 'Menlo', monospace)",
            fontSize: 12,
            color: "#111827"
          }}
        >
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap"
            }}
          >
            {out}
          </pre>
        </div>
      )}
    </div>
  );
}
