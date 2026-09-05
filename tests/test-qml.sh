#!/bin/bash
set -euo pipefail
MARCHYBAR_TEST_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MARCHYBAR_TEST_DIR=$(mktemp -d /tmp/marchybar-qml.XXXXXX)
trap 'rm -rf "$MARCHYBAR_TEST_DIR"' EXIT
cp "$MARCHYBAR_TEST_ROOT/Editor.qml" "$MARCHYBAR_TEST_ROOT/SettingNumber.qml" "$MARCHYBAR_TEST_DIR/"
cp "$MARCHYBAR_TEST_ROOT/tests/qml/editor-harness.qml" "$MARCHYBAR_TEST_DIR/shell.qml"
ln -s "${OMARCHY_PATH:-/usr/share/omarchy}/shell/Commons" "$MARCHYBAR_TEST_DIR/Commons"
ln -s "${OMARCHY_PATH:-/usr/share/omarchy}/shell/Ui" "$MARCHYBAR_TEST_DIR/Ui"
timeout 20 qs -p "$MARCHYBAR_TEST_DIR" --no-color > "$MARCHYBAR_TEST_DIR/output.log" 2>&1 || { cat "$MARCHYBAR_TEST_DIR/output.log"; exit 1; }
cat "$MARCHYBAR_TEST_DIR/output.log"
rg -q 'MARCHYBAR_QML_ALL_PASSED' "$MARCHYBAR_TEST_DIR/output.log"
! rg -q 'MARCHYBAR_QML_FAILED|Unable to assign|TypeError|ReferenceError' "$MARCHYBAR_TEST_DIR/output.log"
