const { File } = require("node:buffer");

if (typeof globalThis.File === "undefined") {
  globalThis.File = File;
}
