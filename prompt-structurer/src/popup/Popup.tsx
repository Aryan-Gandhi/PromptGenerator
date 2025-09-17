import React, { useState } from "react";
import { basicTransform } from "../transformer/basic";

type InjectResponse = { ok: true } | { ok: false; error?: string } | undefined;

export default function Popup() {
  const [raw, setRaw] = useState("");
  const [out, setOut] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const transform = () => {
    const formatted = basicTransform(raw);
    setOut(formatted);
    setStatus(null);
  };

  const insert = () => {
    setStatus(null);
    const payload = out || basicTransform(raw);
    if (!payload) {
      setStatus("Nothing to insert yet.");
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
        <button onClick={transform} style={{ padding: "8px 12px" }}>
          Transform
        </button>
        <button
          onClick={insert}
          style={{ padding: "8px 12px", background: "#2563eb", color: "#fff" }}
        >
          Insert into ChatGPT
        </button>
      </div>
      {status && (
        <div style={{ marginTop: 8, color: status.startsWith("Inserted") ? "green" : "#dc2626" }}>
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
