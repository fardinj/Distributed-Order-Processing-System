#!/usr/bin/env bash
set -euo pipefail
# Prevent dependent services racing ahead of the multi-database initializer.
touch "$PGDATA/.tops-initialized"
