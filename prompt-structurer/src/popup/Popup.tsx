import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function formatWithHumanContext(structured: string, original: string): string {
  const trimmedStructured = structured.trim();
  const trimmedOriginal = original.trim();
  if (!trimmedOriginal) {
    return trimmedStructured;
  }
  const prefix = trimmedStructured ? `${trimmedStructured}\n\n` : "";
  return `${prefix}Human Context: ${trimmedOriginal}`;
}

export default function Popup() {
  const [raw, setRaw] = useState("");
  const [out, setOut] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(
    "Pulls in your ChatGPT draft automatically."
  );
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);

  const isPanel = typeof window !== "undefined" && window.location.hash === "#panel";

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
  }, [raw, out, status, progressSteps, isProcessing, syncMessage, isSyncing]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const runTransform = useCallback(
    async ({ silent = false, steps }: { silent?: boolean; steps?: ProgressStep[] } = {}) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        if (!silent) {
          setStatus({ tone: "info", message: "Enter a prompt first." });
          setProgressSteps([]);
        }
        setOut("");
        return "";
      }

      if (!silent) {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;
      }

      if (!silent) {
        setStatus({ tone: "info", message: "Starting transform…" });
        if (steps && steps.length > 0) {
          setProgressSteps(steps.map((step) => ({ ...step })));
        } else {
          setProgressSteps([
            { id: "prepare", label: "Preparing prompt", state: "active" },
            { id: "request", label: "Contacting transformer service", state: "pending" },
            { id: "result", label: "Formatting structured prompt", state: "pending" }
          ]);
        }
      }

      try {
        if (!silent) {
          setProgressSteps((current) =>
            current.map((step) => {
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

        const controller = abortControllerRef.current;
        const response = await fetch(TRANSFORM_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          signal: controller?.signal,
          body: JSON.stringify({
            prompt: trimmed,
            mode: "universal",
            model: DEFAULT_MODEL
          })
        });

        if (!silent) {
          setProgressSteps((current) =>
            current.map((step) => {
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

        const finalPrompt = formatWithHumanContext(data.structuredPrompt, raw);
        if (!silent) {
          setOut(finalPrompt);
        }
        if (!silent) {
          const model = data.model ?? DEFAULT_MODEL;
          const mockSuffix = data.mocked ? " (mock)" : "";
          setProgressSteps((current) =>
            current.map((step) =>
              step.id === "result" ? { ...step, state: "done" } : step
            )
          );
          setStatus({ tone: "success", message: `Transformed with ${model}${mockSuffix}.` });
        }
        return finalPrompt;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          if (!silent) {
            setOut("");
            setProgressSteps([]);
            setStatus({ tone: "info", message: "Transform cancelled." });
          }
          return "";
        }
        console.error("Prompt Structurer: LLM transform error", error);
        const fallback = basicTransform(trimmed);
        const finalFallback = formatWithHumanContext(fallback, raw);
        if (!silent) {
          setOut(finalFallback);
        }
        if (!silent) {
          setProgressSteps((current) =>
            current.map((step) =>
              step.state === "active" || step.state === "pending"
                ? { ...step, state: "error" }
                : step
            )
          );
          const message = error instanceof Error ? error.message : "LLM transform failed";
          setStatus({ tone: "error", message: `${message}. Using rule-based fallback.` });
        }
        return finalFallback;
      } finally {
        if (!silent) {
          abortControllerRef.current = null;
        }
      }
    },
    [raw]
  );

  const transformAndInsert = useCallback(async () => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setStatus({ tone: "info", message: "Enter a prompt first." });
      setProgressSteps([]);
      setOut("");
      return;
    }

    const progressTemplate: ProgressStep[] = [
      { id: "prepare", label: "Preparing prompt", state: "active" },
      { id: "request", label: "Contacting transformer service", state: "pending" },
      { id: "result", label: "Formatting structured prompt", state: "pending" },
      { id: "insert", label: "Inserting into ChatGPT", state: "pending" }
    ];

    cancelRequestedRef.current = false;
    setIsProcessing(true);

    try {
      const structured = await runTransform({ silent: false, steps: progressTemplate });
      if (cancelRequestedRef.current) {
        setStatus({ tone: "info", message: "Transform cancelled." });
        setProgressSteps([]);
        return;
      }
      if (!structured || !structured.trim()) {
        setProgressSteps([]);
        setStatus({ tone: "info", message: "Nothing to insert." });
        return;
      }

      if (typeof chrome === "undefined" || !chrome.tabs?.query) {
        throw new Error("Chrome permissions missing. Paste manually.");
      }

      setProgressSteps((steps) =>
        steps.map((step) =>
          step.id === "insert" ? { ...step, state: "active" } : step
        )
      );

      await new Promise<void>((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) {
            reject(new Error("Open ChatGPT in this tab to insert the prompt."));
            return;
          }

          chrome.tabs.sendMessage(
            tabId,
            {
              type: "INJECT_TEXT",
              payload: { text: structured }
            },
            (response: InjectResponse) => {
              const runtimeError = chrome.runtime.lastError;
              if (runtimeError) {
                reject(new Error(runtimeError.message || "Failed to contact the page."));
                return;
              }
              if (!response) {
                reject(new Error("No response from page (reload chatgpt.com)."));
                return;
              }
              if (response.ok) {
                resolve();
              } else {
                reject(new Error(response.error ?? "Page reported an error."));
              }
            }
          );
        });
      });

      setProgressSteps((steps) =>
        steps.map((step) =>
          step.id === "insert" ? { ...step, state: "done" } : step
        )
      );
      setStatus({ tone: "success", message: "Transformed prompt inserted into ChatGPT." });
      setRaw("");
      setOut("");
    } catch (error) {
      if (cancelRequestedRef.current) {
        setStatus({ tone: "info", message: "Transform cancelled." });
        setProgressSteps([]);
        return;
      }
      setProgressSteps((steps) =>
        steps.map((step) =>
          step.state === "active" || step.state === "pending"
            ? { ...step, state: "error" }
            : step
        )
      );
      const message =
        error instanceof Error ? error.message : "Failed to insert transformed prompt.";
      setStatus({ tone: "error", message });
    } finally {
      setIsProcessing(false);
    }
  }, [raw, runTransform]);

  const handleSyncClick = () => {
    prefillFromChat().catch(() => {
      setIsSyncing(false);
    });
  };

  const handleCancel = () => {
    cancelRequestedRef.current = true;
    const controller = abortControllerRef.current;
    if (controller) {
      controller.abort();
      abortControllerRef.current = null;
    }
    setIsProcessing(false);
    setProgressSteps([]);
    setStatus({ tone: "info", message: "Transform cancelled." });
  };

  return (
    <div
      style={{
        width: "100%",
        maxWidth: isPanel ? 480 : 360,
        padding: isPanel ? 20 : 16,
        fontSize: 13,
        background: isPanel ? "rgba(248, 250, 252, 0.68)" : "rgba(248, 250, 252, 0.92)",
        borderRadius: isPanel ? 18 : 16,
        border: isPanel ? "1px solid rgba(148, 163, 184, 0.32)" : "1px solid rgba(209, 213, 219, 0.7)",
        boxShadow: "0 24px 54px rgba(15, 23, 42, 0.22)",
        backdropFilter: isPanel ? "blur(20px)" : undefined,
        WebkitBackdropFilter: isPanel ? "blur(20px)" : undefined,
        boxSizing: "border-box",
        transition: "box-shadow 160ms ease",
        margin: isPanel ? "0 auto" : "0"
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
          gap: 10,
          background: "rgba(99, 102, 241, 0.16)",
          color: "#312e81",
          borderRadius: 12,
          padding: "8px 12px",
          marginBottom: 12,
          border: "1px solid rgba(129, 140, 248, 0.32)"
        }}
      >
        <span style={{ fontSize: 12, lineHeight: 1.4 }}>{syncMessage}</span>
        <button
          onClick={handleSyncClick}
          style={{
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 10,
            border: "1px solid rgba(99, 102, 241, 0.45)",
            background: "rgba(255, 255, 255, 0.85)",
            padding: "5px 12px",
            color: "#312e81",
            cursor: isSyncing || isProcessing ? "default" : "pointer",
            transition: "transform 120ms ease, box-shadow 120ms ease",
            boxShadow: isSyncing || isProcessing ? "none" : "0 8px 16px rgba(99, 102, 241, 0.25)",
            opacity: isSyncing || isProcessing ? 0.7 : 1
          }}
          disabled={isSyncing || isProcessing}
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
          minHeight: isPanel ? 140 : 120,
          borderRadius: 14,
          border: "1px solid rgba(148, 163, 184, 0.35)",
          padding: "12px 14px",
          fontSize: 13,
          resize: "vertical",
          background: "rgba(255, 255, 255, 0.9)",
          color: "#111827",
          boxShadow: "inset 0 1px 2px rgba(15, 23, 42, 0.08)",
          outline: "none",
          transition: "border 120ms ease, box-shadow 120ms ease"
        }}
        placeholder="Drop in rough thoughts, bullet notes, or an unstructured prompt..."
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />

      <div
        style={{
          display: "flex",
          marginTop: 14,
          gap: 8
        }}
      >
        <button
          onClick={transformAndInsert}
          style={{
            flex: 1,
            padding: "10px 16px",
            borderRadius: 14,
            border: "1px solid rgba(37, 99, 235, 0.55)",
            background: isProcessing
              ? "linear-gradient(135deg, #3b82f6, #2563eb)"
              : "linear-gradient(135deg, #4338ca, #2563eb)",
            color: "#f8fafc",
            fontWeight: 600,
            letterSpacing: "0.2px",
            cursor: isProcessing ? "default" : "pointer",
            boxShadow: isProcessing
              ? "0 10px 22px rgba(37, 99, 235, 0.25)"
              : "0 18px 34px rgba(37, 99, 235, 0.36)",
            transition: "transform 140ms ease, box-shadow 140ms ease, opacity 140ms ease",
            opacity: isProcessing ? 0.82 : 1
          }}
          disabled={isProcessing}
        >
          {isProcessing ? "Transforming…" : "Transform & Insert"}
        </button>
        <button
          onClick={handleCancel}
          style={{
            padding: "10px 16px",
            borderRadius: 14,
            border: "1px solid rgba(148, 163, 184, 0.4)",
            background: "rgba(148, 163, 184, 0.18)",
            color: "#475569",
            fontWeight: 500,
            cursor: isProcessing ? "pointer" : "not-allowed",
            opacity: isProcessing ? 1 : 0.5,
            transition: "opacity 120ms ease"
          }}
          disabled={!isProcessing}
        >
          Cancel
        </button>
      </div>

      {status && (
        <div
          style={{
            marginTop: 10,
            padding: "9px 12px",
            borderRadius: 10,
            fontSize: 12,
            background:
              status.tone === "success"
                ? "rgba(187, 247, 208, 0.4)"
                : status.tone === "error"
                ? "rgba(254, 226, 226, 0.45)"
                : "rgba(243, 244, 246, 0.6)",
            color:
              status.tone === "success"
                ? "#047857"
                : status.tone === "error"
                ? "#b91c1c"
                : "#374151",
            border:
              status.tone === "success"
                ? "1px solid rgba(16, 185, 129, 0.35)"
                : status.tone === "error"
                ? "1px solid rgba(239, 68, 68, 0.35)"
                : "1px solid rgba(156, 163, 175, 0.4)"
          }}
        >
          {status.message}
        </div>
      )}

      {progressSteps.length > 0 && (
        <div
          style={{
            marginTop: 10,
            padding: "12px 14px",
            background: "rgba(248, 250, 252, 0.75)",
            borderRadius: 14,
            border: "1px dashed rgba(148, 163, 184, 0.45)",
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
            background: "rgba(255, 255, 255, 0.88)",
            borderRadius: 14,
            border: "1px solid rgba(148, 163, 184, 0.35)",
            padding: "12px 14px",
            maxHeight: isPanel ? 220 : 180,
            overflow: "auto",
            fontFamily: "var(--font-mono, 'SFMono-Regular', 'Menlo', monospace)",
            fontSize: 12,
            color: "#0f172a",
            boxShadow: "0 14px 28px rgba(15, 23, 42, 0.16)"
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
