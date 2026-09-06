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


with tempfile.TemporaryDirectory(prefix="marchybar-qml-") as directory:
    target = Path(directory)
    for name in ["Editor.qml", "SettingNumber.qml"]:
        (target / name).write_bytes((ROOT / name).read_bytes())
    omarchy = Path(os.environ.get("OMARCHY_PATH", "/usr/share/omarchy"))
    for name in ["Commons", "Ui"]:
        (target / name).symlink_to(omarchy / "shell" / name)
    source = (ROOT / "Service.qml").read_text()
    harness = (ROOT / "tests/qml/service-harness.qml").read_text()
    harness = harness.replace("// PRODUCT_FUNCTIONS", "\n".join(function(source, name) for name in ["request", "receive", "reconnect"]))
    (target / "ServiceHarness.qml").write_text(harness)
    for name in ["editor-harness.qml", "regressions.qml"]:
        (target / "shell.qml").write_bytes((ROOT / "tests/qml" / name).read_bytes())
        try:
            result = subprocess.run(["qs", "-p", directory, "--no-color"], env={**os.environ, "QT_QPA_PLATFORM": "offscreen", "QT_QUICK_BACKEND": "software"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)
        except subprocess.TimeoutExpired as error:
            print((error.stdout or b"").decode(errors="replace"))
            raise SystemExit("QML tests timed out") from error
        print(result.stdout)
        if result.returncode or "MARCHYBAR_QML_ALL_PASSED" not in result.stdout or any(word in result.stdout for word in ["FAIL!", "MARCHYBAR_QML_FAILED", "TypeError", "ReferenceError", "Unable to assign"]):
            raise SystemExit(1)
