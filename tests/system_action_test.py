"""Hardware-free privilege boundary regression tests; never invoke real pkexec."""
import hashlib
import importlib.machinery
import importlib.util
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]

def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module

class SystemActionTest(unittest.TestCase):
    def test_installer_replacement_cannot_execute_privileged_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'packaging').mkdir()
            for name in ['marchybar', 'system-action.py']:
                shutil.copy(ROOT / 'bin' / name, root / 'bin' / name)
            marker = root / 'executed'
            (root / 'packaging/install-system.sh').write_text(f'#!/bin/bash\ntouch {marker}\n')
            module = load('launcher', root / 'bin/system-action.py')
            # Fixture is deliberately user-writable, regardless of the test runner UID.
            helper = root / 'replacement'
            helper.write_text('untrusted')
            helper.chmod(0o777)
            module.HELPER = helper
            with patch.object(module.os, 'execve') as execute, patch.object(module.sys, 'argv', ['launcher', 'setup']):
                with self.assertRaises(ValueError):
                    module.main()
                execute.assert_not_called()
            # The actual CLI must refuse ordinary setup/removal with a missing helper,
            # even when the checkout installer has been replaced by executable code.
            launcher = root / 'bin/system-action.py'
            launcher.write_text(launcher.read_text().replace(
                "Path('/usr/lib/marchybar-system/setup-helper')",
                "Path('/nonexistent/marchybar-system/setup-helper')"))
            for action in ['setup', 'uninstall-system']:
                result = subprocess.run(['/bin/bash', str(root / 'bin/marchybar'), action], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'MarchyBar setup refused', result.stderr)
            # Extra arguments must also be rejected before escalation.
            for action in ['setup', 'uninstall-system']:
                result = subprocess.run(['/bin/bash', str(root / 'bin/marchybar'), action, '--invalid'], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
            self.assertFalse(marker.exists())

    def test_exact_helper_checks_and_arguments(self):
        module = load('launcher_checks', ROOT / 'bin/system-action.py')
        with tempfile.TemporaryDirectory() as directory:
            helper = Path(directory) / 'helper'
            helper.write_bytes(b'fixture')
            module.HELPER = helper
            module.EXPECTED_SHA256 = hashlib.sha256(b'fixture').hexdigest()
            def metadata(path):
                mode = stat.S_IFREG | 0o755 if path == helper else stat.S_IFDIR | 0o755
                return types.SimpleNamespace(st_uid=0, st_mode=mode)
            with patch.object(Path, 'lstat', metadata), patch.object(module.sys, 'argv', ['launcher', 'setup']), patch.object(module.os, 'execve') as execute:
                module.main()
                self.assertEqual(execute.call_args.args[1], ['/usr/bin/pkexec', str(helper), 'setup'])
                execute.reset_mock()
                helper.write_bytes(b'replaced')
                with self.assertRaises(ValueError): module.main()
                execute.assert_not_called()
            for mode, uid in [(stat.S_IFREG | 0o777, 0), (stat.S_IFREG | 0o755, 1000), (stat.S_IFLNK | 0o777, 0)]:
                def bad(path): return types.SimpleNamespace(st_uid=uid, st_mode=mode)
                with patch.object(Path, 'lstat', bad), patch.object(module.sys, 'argv', ['launcher', 'setup']), patch.object(module.os, 'execve') as execute:
                    with self.assertRaises(ValueError): module.main()
                    execute.assert_not_called()
            for args in [[], ['setup', 'extra'], ['remove', '/tmp/file'], ['other']]:
                with patch.object(module.sys, 'argv', ['launcher', *args]), patch.object(module.os, 'execve') as execute:
                    with self.assertRaises(ValueError): module.main()
                    execute.assert_not_called()

    def test_payload_and_launcher_integrity_binding(self):
        helper = load('helper', ROOT / 'packaging/setup-helper')
        launcher = load('launcher_integrity', ROOT / 'bin/system-action.py')
        self.assertEqual(launcher.EXPECTED_SHA256, hashlib.sha256((ROOT / 'packaging/setup-helper').read_bytes()).hexdigest())
        for name, digest in helper.PAYLOAD.items():
            self.assertEqual(digest, hashlib.sha256((ROOT / 'packaging' / name).read_bytes()).hexdigest(), name)
        for args in [[], ['setup', 'extra'], ['remove', 'extra'], ['other']]:
            with patch.object(helper.sys, 'argv', ['helper', *args]), patch.object(helper.os, 'execve') as execute:
                with self.assertRaises(ValueError): helper.main()
                execute.assert_not_called()

if __name__ == '__main__':
    unittest.main()
