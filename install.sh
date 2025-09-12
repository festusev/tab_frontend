#!/usr/bin/env bash
set -euo pipefail

# Install Homebrew only if not already installed
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  echo "Homebrew already installed. Skipping."
fi

# Install Node.js only if not already installed
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Installing via Homebrew..."
  brew install node
else
  echo "Node.js already installed. Skipping."
fi

npm install
npm start
