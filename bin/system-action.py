#!/usr/bin/python3 -I
"""Check the exact installed helper before requesting its dedicated Polkit action."""
import hashlib
import os
from pathlib import Path
import stat
import sys

HELPER = Path('/usr/lib/marchybar-system/setup-helper')
EXPECTED_SHA256 = 'a998950fa104fb601643665fde7cda963e6a8ea87379ac26a98e9c8c9c8c33b6'

def main():
    if sys.argv[1:] not in [['setup'], ['remove']]:
        raise ValueError('Expected setup or remove, with no other arguments')
    for item in [*reversed(HELPER.parents), HELPER]:
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError(f'Untrusted helper path: {item}')
        if item != HELPER and not stat.S_ISDIR(info.st_mode):
            raise ValueError(f'Not a directory: {item}')
    if HELPER.resolve(strict=True) != HELPER or not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111:
        raise ValueError('Invalid helper executable')
    if hashlib.sha256(HELPER.read_bytes()).hexdigest() != EXPECTED_SHA256:
        raise ValueError('Installed helper version/integrity does not match this plugin')
    # All ancestors and the executable are protected from session-user replacement.
    os.execve('/usr/bin/pkexec', ['/usr/bin/pkexec', str(HELPER), sys.argv[1]],
              {'PATH': '/usr/bin:/bin', 'LANG': 'C'})

if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print(f'MarchyBar setup refused: {error}. Install the matching trusted system package; see README.md.', file=sys.stderr)
        sys.exit(1)
