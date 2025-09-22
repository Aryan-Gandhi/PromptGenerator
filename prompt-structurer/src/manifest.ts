import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "PromptGear for ChatGPT",
  version: "0.0.1",
  description: "Crafts structured prompts and drops them straight into ChatGPT.",
  icons: {
    16: "icons/logo-16.png",
    32: "icons/logo-32.png",
    48: "icons/logo-48.png",
    128: "icons/logo-128.png"
  },
  action: {
    default_popup: "src/popup.html",
    default_title: "PromptGear",
    default_icon: {
      16: "icons/logo-16.png",
      32: "icons/logo-32.png",
      48: "icons/logo-48.png"
    }
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
