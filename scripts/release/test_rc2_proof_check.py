"""Synthetic, secret-free tests for RC2 release proof checker."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


CHECKER = Path(__file__).with_name("rc2-proof-check.py")


class RC2EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_gate(self, *args):
        return subprocess.run(
            [sys.executable, str(CHECKER), *map(str, args)],
            capture_output=True, text=True, check=False,
        )

    def archive(self, filename="chat-media/test.txt"):
        path = self.root / "media.tar"
        with tarfile.open(path, "w") as archive:
            payload = b"synthetic-qa-only\n"
            entry = tarfile.TarInfo(filename)
            entry.size = len(payload)
            archive.addfile(entry, io.BytesIO(payload))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def records(self, filename, records):
        path = self.root / filename
        with path.open("w", encoding="utf-8") as f:
            for key, value in records.items():
                f.write(json.dumps({"key": key, "value": value}) + "\n")
        return path

    def test_clean_tar_passes_integrity_but_never_claims_snapshot(self):
        archive, digest = self.archive()
        result = self.run_gate("storage", "--archive", archive, "--sha256", digest, "--tar-rc", 0)
        self.assertEqual(result.returncode, 2)
        self.assertIn("RC2_STORAGE_ARCHIVE=PASS_SHA256_AND_FULL_READ", result.stdout)
        self.assertIn("POINT_IN_TIME=PENDING", result.stdout)

    def test_live_tar_warning_is_a_hard_no_go(self):
        archive, digest = self.archive()
        result = self.run_gate("storage", "--archive", archive, "--sha256", digest, "--tar-rc", 1)
        self.assertEqual(result.returncode, 1)
        self.assertIn("RC2_STORAGE_ARCHIVE=NO_GO", result.stderr)

    def test_corrupt_digest_or_unsafe_tar_rejected(self):
        archive, _ = self.archive()
        wrong = self.run_gate("storage", "--archive", archive, "--sha256", "0" * 64, "--tar-rc", 0)
        self.assertEqual(wrong.returncode, 1)
        unsafe, digest = self.archive("../escape.txt")
        result = self.run_gate("storage", "--archive", unsafe, "--sha256", digest, "--tar-rc", 0)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unsafe tar member", result.stderr)

    def test_acl_detects_drift_and_allows_only_new_calling_objects(self):
        before = {
            "schema:public": {"anon_usage": True},
            "relation:public.orders": {"rls": True, "anon": {"select": False}},
            "role:supabase_realtime_admin": {"exists": True},
        }
        after = dict(before)
        after["relation:public.whatsapp_call_sessions"] = {"rls": True}
        b = self.records("before.jsonl", before)
        a = self.records("after.jsonl", after)
        passed = self.run_gate("acl", "--before", b, "--after", a)
        self.assertEqual(passed.returncode, 0)
        self.assertIn("RC2_RESTORE_ACL_PARITY=PASS_METADATA_ONLY", passed.stdout)

        after["relation:public.orders"] = {"rls": False}
        a = self.records("after.jsonl", after)
        failed = self.run_gate("acl", "--before", b, "--after", a)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("RC2_ACL_CHANGED=relation:public.orders", failed.stderr)
        self.assertNotIn("'rls'", failed.stderr)

    def test_acl_missing_realtime_role_not_silently_ignored(self):
        before = {"schema:public": {"anon_usage": True},
                  "role:supabase_realtime_admin": {"exists": True}}
        after = {"schema:public": {"anon_usage": True},
                 "role:supabase_realtime_admin": {"exists": False},
                 "relation:public.whatsapp_call_events": {"rls": True}}
        b = self.records("before.jsonl", before)
        a = self.records("after.jsonl", after)
        failed = self.run_gate("acl", "--before", b, "--after", a)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("role:supabase_realtime_admin", failed.stderr)


if __name__ == "__main__":
    unittest.main()
