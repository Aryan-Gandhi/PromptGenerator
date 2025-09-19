import React, { useCallback, useState } from "react";
import { TRANSFORM_ENDPOINT, DEFAULT_MODEL } from "../config";
import { basicTransform } from "../transformer/basic";

type InjectResponse = { ok: true } | { ok: false; error?: string } | undefined;

export default function Popup() {
  const [raw, setRaw] = useState("");
  const [out, setOut] = useState("");
  const [isTransforming, setIsTransforming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const runTransform = useCallback(
    async (silent = false) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        if (!silent) {
          setStatus("Enter a prompt first.");
        }
        setOut("");
        return "";
      }

      setIsTransforming(true);
      if (!silent) {
        setStatus("Transforming via LLM…");
      }

      try {
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
          setStatus(`Transformed with ${model}${mockSuffix}.`);
        }
        return data.structuredPrompt;
      } catch (error) {
        console.error("Prompt Structurer: LLM transform error", error);
        const fallback = basicTransform(trimmed);
        setOut(fallback);
        if (!silent) {
          const message = error instanceof Error ? error.message : "LLM transform failed";
          setStatus(`${message}. Using rule-based fallback.`);
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

  const insert = async () => {
    setStatus(null);
    const payload = out || (await runTransform(true));
    if (!payload) {
      setStatus("Nothing to insert.");
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) {
        setStatus("Could not find the active tab.");
        return;
      }

      chrome.tabs.sendMessage(tabId, {
        type: "INJECT_TEXT",
        payload: { text: payload }
      }, (response: InjectResponse) => {
        const err = chrome.runtime.lastError;
        if (err) {
          setStatus(err.message || "Failed to contact the page.");
          return;
        }
        if (!response) {
          setStatus("No response from page (reload chatgpt.com).");
          return;
        }
        if (response.ok) {
          setStatus("Inserted into ChatGPT.");
        } else {
          setStatus(response.error ?? "Page reported an error.");
        }
      });
    });
  };

  return (
    <div style={{ width: 380, padding: 12, fontSize: 13 }}>
      <textarea
        style={{ width: "100%", height: 96, padding: 8 }}
        placeholder="Enter raw prompt…"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          onClick={handleTransformClick}
          style={{ padding: "8px 12px" }}
          disabled={isTransforming}
        >
          {isTransforming ? "Transforming…" : "Transform"}
        </button>
        <button
          onClick={insert}
          style={{ padding: "8px 12px", background: "#2563eb", color: "#fff" }}
          disabled={isTransforming}
        >
          Insert into ChatGPT
        </button>
      </div>
      {status && (
        <div
          style={{
            marginTop: 8,
            color: status.startsWith("Inserted") || status.startsWith("Transformed") ? "green" : "#dc2626"
          }}
        >
          {status}
        </div>
      )}
      {out && (
        <pre
          style={{
            background: "#f3f4f6",
            padding: 8,
            marginTop: 8,
            maxHeight: 160,
            overflow: "auto",
            whiteSpace: "pre-wrap"
          }}
        >
          {out}
        </pre>
      )}
    </div>
  );
}
