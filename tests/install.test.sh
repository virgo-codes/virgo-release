#!/usr/bin/env bash
set -euo pipefail
repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Each suite runs regardless of the other's result; any failure fails the run.
status=0
bun "$repository/tests/launcher.test.js" || status=$?
bun "$repository/tests/target-dispatch.test.js" || status=$?
exit "$status"
