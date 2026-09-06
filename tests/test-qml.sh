#!/bin/bash
set -euo pipefail
MARCHYBAR_TEST_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec python "$MARCHYBAR_TEST_ROOT/tests/qml/run.py"
