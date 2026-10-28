#!/usr/bin/env bash
set -euo pipefail
repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
bun "$repository/tests/launcher.test.js"
exec bun "$repository/tests/target-dispatch.test.js"
