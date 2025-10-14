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

const encoder = new TextEncoder();

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function buildSignedHeaders(payload: unknown): Promise<Record<string, string>> {
  const secret = import.meta.env.VITE_SIGNING_SECRET as string | undefined;
  const clientId = (import.meta.env.VITE_CLIENT_ID as string | undefined) ?? "promptgear-extension";
  const timestamp = Date.now().toString();
  const bodyText = JSON.stringify(payload ?? {});

  if (!secret) {
    return {
      "content-type": "application/json"
    };
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${timestamp}.${bodyText}`)
    );
    const signature = base64Encode(new Uint8Array(signatureBuffer));

    return {
      "content-type": "application/json",
      "X-Promptgear-Timestamp": timestamp,
      "X-Promptgear-Signature": signature,
      "X-Promptgear-Client": clientId
    };
  } catch (error) {
    console.warn("Prompt Structurer: failed to create signature", error);
    return {
      "content-type": "application/json"
    };
  }
}

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
  const [activePreviewTab, setActivePreviewTab] = useState<"refined" | "original">("refined");

  const toneOptions = ["Balanced"];
  const personaOptions: string[] = [];
  const [selectedTone] = useState<string>(toneOptions[0]);
  const [selectedPersona] = useState<string>("General Strategist");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const quickPrompts: Array<{ label: string; description: string; template: string }> = [];

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
              if (response?.ok && typeof text === "string") {
                setRaw(text);
                setActivePreviewTab("original");
                setTimeout(() => {
                  textareaRef.current?.focus();
                }, 0);
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

  const handleQuickPrompt = useCallback((template: string) => {
    setRaw(template);
    setActivePreviewTab("original");
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
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

      const directives: string[] = [];
      if (selectedTone !== "Balanced") {
        directives.push(`Please rewrite the following content in a ${selectedTone.toLowerCase()} tone while preserving intent.`);
      }
      if (selectedPersona !== "General Strategist") {
        directives.push(`Adopt the perspective of a ${selectedPersona.toLowerCase()} when organizing the response.`);
      }
      const directiveBlock = directives.length ? `${directives.join(" ")}\n\n` : "";
      const payloadPrompt = `${directiveBlock}${trimmed}`;

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
        const requestPayload = {
          prompt: payloadPrompt,
          mode: "universal",
          model: DEFAULT_MODEL
        };
        const headers = await buildSignedHeaders(requestPayload);
        const response = await fetch(TRANSFORM_ENDPOINT, {
          method: "POST",
          headers,
          signal: controller?.signal,
          body: JSON.stringify(requestPayload)
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
          setActivePreviewTab("refined");
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
        if (silent) {
          setActivePreviewTab("refined");
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
        const fallback = basicTransform(payloadPrompt);
        const finalFallback = formatWithHumanContext(fallback, raw);
        if (!silent) {
          setOut(finalFallback);
          setActivePreviewTab("refined");
        }
        if (!silent) {
          setProgressSteps((current) =>
            current.map((step) =>
              step.state === "active" || step.state === "pending"
                ? { ...step, state: "error" }
                : step
            )
          );
          const readable = error instanceof Error ? error.message : "Call to GPT failed";
          setStatus({
            tone: "error",
            message: `${readable}. Using offline fallback prompt instead.`
          });
        }
        return finalFallback;
      } finally {
        if (!silent) {
          abortControllerRef.current = null;
        }
      }
    },
    [raw, selectedTone, selectedPersona]
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

  const handleCopy = useCallback((content: string) => {
    const value = content.trim();
    if (!value) {
      return;
    }
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(
        () => {
          setStatus({ tone: "success", message: "Copied to clipboard." });
        },
        () => {
          setStatus({ tone: "error", message: "Copy failed. Use Cmd/Ctrl+C instead." });
        }
      );
      return;
    }
    try {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.focus();
      helper.select();
      document.execCommand("copy");
      document.body.removeChild(helper);
      setStatus({ tone: "success", message: "Copied to clipboard." });
    } catch (error) {
      console.error("Prompt Structurer: clipboard fallback failed", error);
      setStatus({ tone: "error", message: "Copy failed. Use Cmd/Ctrl+C instead." });
    }
  }, []);

  const defaultSteps: ProgressStep[] = [
    { id: "prepare", label: "Prep", state: "pending" },
    { id: "request", label: "AI Transform", state: "pending" },
    { id: "result", label: "Formatting", state: "pending" },
    { id: "insert", label: "Insert", state: "pending" }
  ];
  const displayedSteps = progressSteps.length ? progressSteps : defaultSteps;
  const previewText = activePreviewTab === "refined" ? out : raw;
  const previewHasContent = !!previewText && previewText.trim().length > 0;
  const previewEmptyMessage =
    activePreviewTab === "refined"
      ? "Run Transform & Insert to see the structured output."
      : "Type or sync a prompt to preview it here.";

  const getStepAccent = (state: ProgressState) => {
    switch (state) {
      case "done":
        return { border: "1px solid rgba(16, 185, 129, 0.5)", background: "rgba(16, 185, 129, 0.2)", color: "#047857" };
      case "active":
        return { border: "1px solid rgba(99, 102, 241, 0.6)", background: "rgba(99, 102, 241, 0.18)", color: "#4338ca" };
      case "error":
        return { border: "1px solid rgba(248, 113, 113, 0.5)", background: "rgba(248, 113, 113, 0.2)", color: "#b91c1c" };
      default:
        return { border: "1px dashed rgba(148, 163, 184, 0.5)", background: "rgba(148, 163, 184, 0.12)", color: "#475569" };
    }
  };

  const describeStepState = (state: ProgressState) => {
    switch (state) {
      case "done":
        return "Complete";
      case "active":
        return "In progress";
      case "error":
        return "Needs attention";
      default:
        return "Queued";
    }
  };

  const cardBaseStyle: React.CSSProperties = {
    background: "rgba(255, 255, 255, 0.86)",
    borderRadius: 18,
    border: "1px solid rgba(203, 213, 225, 0.55)",
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 12
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: "6px 14px",
    borderRadius: 999,
    border: active ? "1px solid rgba(99, 102, 241, 0.6)" : "1px solid rgba(148, 163, 184, 0.35)",
    background: active ? "linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(79, 70, 229, 0.25))" : "rgba(248, 250, 252, 0.7)",
    color: active ? "#312e81" : "#475569",
    fontWeight: active ? 600 : 500,
    fontSize: 12,
    cursor: "pointer",
    transition: "transform 120ms ease, box-shadow 120ms ease, background 120ms ease",
    boxShadow: active ? "0 6px 14px rgba(79, 70, 229, 0.18)" : "none"
  });

  const personaChipStyle = (active: boolean): React.CSSProperties => ({
    padding: "6px 14px",
    borderRadius: 12,
    border: active ? "1px solid rgba(45, 212, 191, 0.6)" : "1px solid rgba(148, 163, 184, 0.3)",
    background: active ? "linear-gradient(135deg, rgba(20, 184, 166, 0.18), rgba(45, 212, 191, 0.25))" : "rgba(255, 255, 255, 0.7)",
    color: active ? "#0f766e" : "#475569",
    fontWeight: active ? 600 : 500,
    fontSize: 12,
    cursor: "pointer",
    transition: "transform 120ms ease, box-shadow 120ms ease, background 120ms ease",
    boxShadow: active ? "0 6px 14px rgba(20, 184, 166, 0.18)" : "none"
  });

  const tabButtonStyle = (active: boolean): React.CSSProperties => ({
    padding: "6px 14px",
    borderRadius: 12,
    border: active ? "1px solid rgba(99, 102, 241, 0.45)" : "1px solid rgba(148, 163, 184, 0.35)",
    background: active ? "rgba(99, 102, 241, 0.16)" : "rgba(248, 250, 252, 0.9)",
    color: active ? "#4338CA" : "#475569",
    fontWeight: active ? 600 : 500,
    fontSize: 12,
    cursor: "pointer"
  });


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
        maxWidth: isPanel ? 520 : 420,
        padding: isPanel ? 24 : 20,
        fontSize: 13,
        background: isPanel ? "rgba(241, 245, 249, 0.62)" : "rgba(248, 250, 252, 0.96)",
        borderRadius: isPanel ? 22 : 18,
        border: "1px solid rgba(203, 213, 225, 0.55)",
        boxShadow: "0 28px 60px rgba(15, 23, 42, 0.24)",
        backdropFilter: isPanel ? "blur(22px)" : undefined,
        WebkitBackdropFilter: isPanel ? "blur(22px)" : undefined,
        boxSizing: "border-box",
        margin: isPanel ? "0 auto" : "0",
        display: "flex",
        flexDirection: "column",
        gap: 18
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {iconUrl && (
            <img
              src={iconUrl}
              alt="PromptGear"
              style={{ width: 32, height: 32, borderRadius: 10, boxShadow: "0 6px 16px rgba(15, 23, 42, 0.18)" }}
            />
          )}
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: "#0f172a" }}>PromptGear</div>
            <div style={{ fontSize: 12.5, color: "#475569" }}>Design deliberate prompts before sending.</div>
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            color: "#4338ca",
            background: "rgba(99, 102, 241, 0.16)",
            padding: "4px 10px",
            borderRadius: 999
          }}
        >
          v1.0
        </span>
      </div>

      <div style={{ ...cardBaseStyle, gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, color: "#1f2937" }}>
          Stay in sync
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#475569", flex: 1, minWidth: 180 }}>{syncMessage}</span>
          <button
            type="button"
            onClick={handleSyncClick}
            style={{
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 10,
              border: "1px solid rgba(99, 102, 241, 0.45)",
              background: "linear-gradient(135deg, rgba(255,255,255,0.95), rgba(226,232,240,0.95))",
              padding: "6px 14px",
              color: "#312e81",
              cursor: isSyncing || isProcessing ? "default" : "pointer",
              transition: "transform 120ms ease, box-shadow 120ms ease",
              boxShadow: isSyncing || isProcessing ? "none" : "0 10px 22px rgba(99, 102, 241, 0.18)",
              opacity: isSyncing || isProcessing ? 0.7 : 1
            }}
            disabled={isSyncing || isProcessing}
          >
            {isSyncing ? "Syncing…" : "Sync from ChatGPT"}
          </button>
        </div>
      </div>

      {quickPrompts.length > 0 && (
        <div style={{ ...cardBaseStyle, gap: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#1f2937" }}>Jump start your draft</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>Tap a template or write your own prompt below.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {quickPrompts.map((prompt) => (
              <button
                key={prompt.label}
                type="button"
                style={quickPromptButtonStyle}
                onClick={() => handleQuickPrompt(prompt.template)}
              >
                <span style={{ fontWeight: 600, fontSize: 12.5, color: "#1f2937" }}>{prompt.label}</span>
                <span style={{ fontSize: 11.5, color: "#64748b", lineHeight: 1.4 }}>{prompt.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {personaOptions.length > 0 && (
        <div style={{ ...cardBaseStyle, gap: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#1f2937" }}>Refinement preferences</div>
          <div style={{ fontSize: 11.5, color: "#64748b" }}>Tune the tone and perspective before transforming.</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {toneOptions.map((tone) => (
              <button key={tone} type="button" style={chipStyle(selectedTone === tone)} onClick={() => setSelectedTone(tone)}>
                {tone}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {personaOptions.map((persona) => (
              <button
                key={persona}
                type="button"
                style={personaChipStyle(selectedPersona === persona)}
                onClick={() => setSelectedPersona(persona)}
              >
                {persona}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ ...cardBaseStyle, gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600, color: "#1f2937" }}>Raw prompt draft</span>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>{raw.length} chars</span>
        </div>
        <textarea
          ref={textareaRef}
          id="promptgear-raw"
          style={{
            width: "100%",
            minHeight: isPanel ? 160 : 130,
            borderRadius: 16,
            border: "1px solid rgba(148, 163, 184, 0.35)",
            padding: "14px 16px",
            fontSize: 13,
            resize: "vertical",
            background: "rgba(255, 255, 255, 0.94)",
            color: "#111827",
            boxShadow: "inset 0 1px 2px rgba(15, 23, 42, 0.08)",
            outline: "none",
            transition: "border 120ms ease, box-shadow 120ms ease"
          }}
          placeholder="Drop in rough thoughts, bullet notes, or an unstructured prompt..."
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setActivePreviewTab("original");
          }}
        />
        <div style={{ fontSize: 11.5, color: "#64748b" }}>
          Attachments already in ChatGPT stay untouched when the refined prompt is inserted back.
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={transformAndInsert}
          style={{
            flex: 1,
            padding: "12px 18px",
            borderRadius: 16,
            border: "1px solid rgba(37, 99, 235, 0.6)",
            background: isProcessing
              ? "linear-gradient(135deg, #3b82f6, #2563eb)"
              : "linear-gradient(135deg, #4338ca, #2563eb)",
            color: "#f8fafc",
            fontWeight: 600,
            letterSpacing: "0.2px",
            cursor: isProcessing ? "default" : "pointer",
            boxShadow: isProcessing
              ? "0 12px 24px rgba(37, 99, 235, 0.28)"
              : "0 20px 38px rgba(37, 99, 235, 0.36)",
            transition: "transform 140ms ease, box-shadow 140ms ease, opacity 140ms ease",
            opacity: isProcessing ? 0.82 : 1
          }}
          disabled={isProcessing}
        >
          {isProcessing ? "Transforming…" : "Transform & Insert"}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          style={{
            padding: "12px 18px",
            borderRadius: 16,
            border: "1px solid rgba(148, 163, 184, 0.45)",
            background: "rgba(148, 163, 184, 0.22)",
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
            padding: "10px 14px",
            borderRadius: 12,
            fontSize: 12,
            background:
              status.tone === "success"
                ? "rgba(16, 185, 129, 0.12)"
                : status.tone === "error"
                ? "rgba(248, 113, 113, 0.16)"
                : "rgba(148, 163, 184, 0.16)",
            color:
              status.tone === "success"
                ? "#047857"
                : status.tone === "error"
                ? "#b91c1c"
                : "#475569",
            border:
              status.tone === "success"
                ? "1px solid rgba(16, 185, 129, 0.4)"
                : status.tone === "error"
                ? "1px solid rgba(248, 113, 113, 0.4)"
                : "1px solid rgba(148, 163, 184, 0.35)"
          }}
        >
          {status.message}
        </div>
      )}

      <div style={{ ...cardBaseStyle, gap: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: "#1f2937" }}>Progress</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {displayedSteps.map((step, index) => {
            const accent = getStepAccent(step.state);
            const descriptor = describeStepState(step.state);
            const symbol =
              step.state === "done" ? "✓" : step.state === "error" ? "!" : step.state === "active" ? "…" : "•";
            return (
              <React.Fragment key={step.id}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 14,
                    border: accent.border,
                    background: accent.background,
                    minWidth: 150
                  }}
                >
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      background: accent.color,
                      color: "#f8fafc",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 600
                    }}
                  >
                    {symbol}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#1f2937" }}>{step.label}</span>
                    <span style={{ fontSize: 11, color: accent.color }}>{descriptor}</span>
                  </div>
                </div>
                {index < displayedSteps.length - 1 && (
                  <div
                    style={{
                      width: 32,
                      height: 2,
                      background: "rgba(148, 163, 184, 0.35)",
                      borderRadius: 999
                    }}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <div style={{ ...cardBaseStyle, gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8, background: "rgba(248, 250, 252, 0.9)", borderRadius: 14, padding: 4 }}>
            <button
              type="button"
              style={tabButtonStyle(activePreviewTab === "refined")}
              onClick={() => setActivePreviewTab("refined")}
            >
              Refined
            </button>
            <button
              type="button"
              style={tabButtonStyle(activePreviewTab === "original")}
              onClick={() => setActivePreviewTab("original")}
            >
              Original
            </button>
          </div>
          <button
            type="button"
            onClick={() => handleCopy(previewText || "")}
            disabled={!previewHasContent}
            style={{
              padding: "6px 12px",
              borderRadius: 10,
              border: "1px solid rgba(148, 163, 184, 0.4)",
              background: previewHasContent ? "rgba(15, 23, 42, 0.9)" : "rgba(148, 163, 184, 0.2)",
              color: previewHasContent ? "#e2e8f0" : "#94a3b8",
              fontSize: 12,
              fontWeight: 600,
              cursor: previewHasContent ? "pointer" : "not-allowed"
            }}
          >
            Copy
          </button>
        </div>
        <div
          style={{
            borderRadius: 16,
            background: "rgba(15, 23, 42, 0.9)",
            color: "#e2e8f0",
            padding: "16px 18px",
            fontFamily: "var(--font-mono, 'SFMono-Regular', 'Menlo', monospace)",
            minHeight: 150,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
            border: "1px solid rgba(30, 41, 59, 0.8)",
            overflowY: "auto"
          }}
        >
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              color: previewHasContent ? "#e2e8f0" : "#94a3b8"
            }}
          >
            {previewHasContent ? previewText : previewEmptyMessage}
          </pre>
        </div>
        <div style={{ fontSize: 11, color: "#64748b" }}>
          We automatically append <strong>Human Context</strong> so ChatGPT sees the exact words and any linked assets you provided.
        </div>
      </div>
    </div>
  );
}
