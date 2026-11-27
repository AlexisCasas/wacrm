"""Fails when any evidence file contains a credential of this run or anything shaped like a signed token. Prints file names only."""
import os
import re
import sys

root, secrets_file = sys.argv[1], sys.argv[2]
with open(secrets_file, encoding="utf-8") as handle:
    secrets = [line.strip().encode() for line in handle if len(line.strip()) >= 12]
token = re.compile(rb"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]{10,}")

bad = []
scanned = 0
for directory, _, files in os.walk(root):
    for name in files:
        path = os.path.join(directory, name)
        with open(path, "rb") as handle:
            data = handle.read()
        scanned += 1
        if any(secret in data for secret in secrets):
            bad.append((os.path.relpath(path, root), "credential of this run"))
        elif token.search(data):
            bad.append((os.path.relpath(path, root), "signed token"))

if bad:
    for path, why in bad:
        print(f"SECRET_SCAN=FAIL {path}: {why}")
    sys.exit(1)
print(f"SECRET_SCAN=PASS files={scanned} secrets_checked={len(secrets)}")
