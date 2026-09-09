#!/usr/bin/env python3
"""Run product QML offscreen, with no live service, socket, or device access."""
import os
import re
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def function(source, name):
    start = re.search(rf"^  function {name}\(", source, re.MULTILINE).start()
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


with tempfile.TemporaryDirectory(prefix="marchybar qml %-そこ-") as directory:
    target = Path(directory)
    for name in ["Editor.qml", "SettingNumber.qml", "Service.qml", "LockState.qml"]:
        (target / name).write_bytes((ROOT / name).read_bytes())
    (target / "bin").mkdir()
    (target / "bin/marchybar").write_text('#!/bin/bash\nprintf "MARCHYBAR_STUB_%s\\n" "$1" >&2\n')
    (target / "runtime").mkdir(mode=0o700)
    omarchy = Path(os.environ.get("OMARCHY_PATH", "/usr/share/omarchy"))
    for name in ["Commons", "Ui"]:
        (target / name).symlink_to(omarchy / "shell" / name)
    source = (ROOT / "Service.qml").read_text()
    harness = (ROOT / "tests/qml/service-harness.qml").read_text()
    harness = harness.replace("// PRODUCT_FUNCTIONS", "\n".join(function(source, name) for name in ["request", "receive", "reconnect"]))
    (target / "ServiceHarness.qml").write_text(harness)
    for name in ["editor-harness.qml", "regressions.qml", "service-integration.qml"]:
        (target / "shell.qml").write_bytes((ROOT / "tests/qml" / name).read_bytes())
        try:
            result = subprocess.run(["qs", "-p", directory, "--no-color"], env={**os.environ, "XDG_RUNTIME_DIR": str(target / "runtime"), "MARCHYBAR_TEST_ROOT": directory, "QT_QPA_PLATFORM": "offscreen", "QT_QUICK_BACKEND": "software"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)
        except subprocess.TimeoutExpired as error:
            print((error.stdout or b"").decode(errors="replace"))
            raise SystemExit("QML tests timed out") from error
        print(result.stdout)
        if result.returncode or "MARCHYBAR_QML_ALL_PASSED" not in result.stdout or any(word in result.stdout for word in ["FAIL!", "MARCHYBAR_QML_FAILED", "TypeError", "ReferenceError", "Unable to assign"]):
            raise SystemExit(1)
