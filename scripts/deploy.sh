#!/usr/bin/env bash
set -euo pipefail

npm run build:extension
npm run deploy:worker

echo "Extension built and worker deployed."
