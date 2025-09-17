import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Prompt Structurer (MVP - ChatGPT)",
  version: "0.0.1",
  description: "Takes a raw prompt, structures it, and inserts it into ChatGPT.",
  action: {
    default_popup: "src/popup.html",
    default_title: "Prompt Structurer"
  },
  permissions: ["activeTab"],
  content_scripts: [
    {
      matches: ["*://chat.openai.com/*", "*://chatgpt.com/*"],
      js: ["src/content.ts"],
      run_at: "document_idle"
    }
  ]
});
