#!/usr/bin/env python3
"""WACRM RC2 read-only local release evidence checker.

Never connects to production; never uploads snapshots, media, tokens or data.
The storage subcommand proves archive readability, NOT point-in-time consistency.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tarfile


def abort(label, explanation):
    print(f"{label}=NO_GO: {explanation}", file=sys.stderr)
    return 1


def read_snapshot(path):
    records = {}
    with open(path, encoding="utf-8") as fh:
        for number, line in enumerate(fh, start=1):
            if not line.strip():
                continue
            item = json.loads(line)
            key = item.get("key")
            if not isinstance(key, str) or not key or "value" not in item:
                raise ValueError(f"bad snapshot line {number}")
            if key in records:
                raise ValueError(f"duplicate snapshot key {key}")
            records[key] = item["value"]
    if not records or "schema:public" not in records:
        raise ValueError("empty/incomplete ACL snapshot")
    return records


def acl_gate(before, after):
    old, new = read_snapshot(before), read_snapshot(after)
    missing = sorted(set(old) - set(new))
    drift = sorted(k for k in old.keys() & new.keys() if old[k] != new[k])
    extras = sorted(set(new) - set(old))
    unexpected = [k for k in extras if not k.startswith(
        ("relation:public.whatsapp_call_", "function:public.whatsapp_call_")
    )]
    print(f"RC2_ACL_COUNTS=before:{len(old)},after:{len(new)},new_calling:{len(extras) - len(unexpected)}")
    for label, items in (("MISSING", missing), ("CHANGED", drift), ("UNEXPECTED_NEW", unexpected)):
        for key in items[:30]:
            # Object names only. Do not print policy definitions, keys or data.
            print(f"RC2_ACL_{label}={key}", file=sys.stderr)
    if missing or drift or unexpected:
        return abort("RC2_RESTORE_ACL_PARITY", "privilege/policy/role drift; investigate before approval")
    if not extras:
        return abort("RC2_RESTORE_ACL_PARITY", "Calling objects missing in post-migration snapshot")
    print("RC2_RESTORE_ACL_PARITY=PASS_METADATA_ONLY")
    return 0


def storage_gate(archive, expected_sha256, tar_rc):
    if tar_rc != 0:
        return abort("RC2_STORAGE_ARCHIVE", f"original tar exited {tar_rc}; archive is not certified")
    archive = Path(archive)
    if not archive.is_file():
        return abort("RC2_STORAGE_ARCHIVE", "archive does not exist")
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != expected_sha256.lower():
        return abort("RC2_STORAGE_ARCHIVE", "SHA256 mismatch")
    count = 0
    try:
        with tarfile.open(archive, "r:*") as tf:
            for member in tf:
                name = member.name
                if name.startswith("/") or ".." in Path(name).parts:
                    return abort("RC2_STORAGE_ARCHIVE", "unsafe tar member path")
                if member.isdev() or member.issym() or member.islnk():
                    return abort("RC2_STORAGE_ARCHIVE", "special/link member needs manual review")
                if member.isfile():
                    count += 1
                    source = tf.extractfile(member)
                    if source is None:
                        return abort("RC2_STORAGE_ARCHIVE", "unreadable tar member")
                    with source:
                        for _ in iter(lambda: source.read(1024 * 1024), b""):
                            pass
    except (OSError, tarfile.TarError, EOFError) as error:
        return abort("RC2_STORAGE_ARCHIVE", f"cannot read complete tar: {type(error).__name__}")
    if count == 0:
        return abort("RC2_STORAGE_ARCHIVE", "archive contains no regular files")
    print(f"RC2_STORAGE_ARCHIVE=PASS_SHA256_AND_FULL_READ; files={count}")
    print("RC2_STORAGE_POINT_IN_TIME=PENDING: require separately verified immutable snapshot/write barrier")
    # Intentionally not a deploy GO; neither hashes nor tar listing proves
    # the source files were mutually consistent while written.
    return 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    acl = modes.add_parser("acl", help="compare metadata-only PostgreSQL ACL snapshots")
    acl.add_argument("--before", required=True)
    acl.add_argument("--after", required=True)
    storage = modes.add_parser("storage", help="verify archive without asserting snapshot consistency")
    storage.add_argument("--archive", required=True)
    storage.add_argument("--sha256", required=True)
    storage.add_argument("--tar-rc", required=True, type=int)
    args = parser.parse_args()
    try:
        if args.mode == "acl":
            return acl_gate(args.before, args.after)
        if len(args.sha256) != 64 or any(c not in "0123456789abcdefABCDEF" for c in args.sha256):
            return abort("RC2_STORAGE_ARCHIVE", "expected SHA256 must be 64 hex characters")
        return storage_gate(args.archive, args.sha256, args.tar_rc)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        # No raw file contents, policy definitions or secrets in errors.
        return abort("RC2_EVIDENCE", type(exc).__name__)


if __name__ == "__main__":
    sys.exit(main())
