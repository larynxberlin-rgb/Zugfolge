import importlib.util
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest


SCRIPT_PATH = Path(__file__).with_name("legacy-schema29-odoo-write-probe.py")
SPEC = importlib.util.spec_from_file_location("legacy_schema29_odoo_write_probe", SCRIPT_PATH)
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class LegacySchema29OdooWriteProbeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="zugfolge-schema29-odoo-probe-")
        self.filestore = os.path.join(self.directory, "zugfolge_odoo_recovery_v1_schema29_runtime_test")
        self.bucket = os.path.join(self.filestore, "ab")
        os.makedirs(self.bucket)
        self.baseline_blob = os.path.join(self.bucket, "a" * 40)
        with open(self.baseline_blob, "wb") as handle:
            handle.write(b"baseline")
        status_value = os.lstat(self.filestore)
        self.uid = status_value.st_uid
        self.gid = status_value.st_gid

    def tearDown(self):
        for root, directories, files in os.walk(self.directory):
            for name in directories:
                try:
                    os.chmod(os.path.join(root, name), 0o700)
                except OSError:
                    pass
            for name in files:
                try:
                    os.chmod(os.path.join(root, name), 0o600)
                except OSError:
                    pass
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_read_only_tree_is_not_accepted_as_owner_writable(self):
        os.chmod(self.baseline_blob, 0o400)
        os.chmod(self.bucket, 0o500)
        os.chmod(self.filestore, 0o500)
        with self.assertRaisesRegex(RuntimeError, "trotz RW-Mount"):
            PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=True)

    def test_wrong_owner_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "Runtime-Owner"):
            PROBE.snapshot_filestore(self.filestore, self.uid + 1, self.gid, require_owner_writable=False)

    def test_one_safe_legacy_namespace_is_accepted(self):
        namespaced_bucket = os.path.join(self.filestore, "checklist", "89")
        os.makedirs(namespaced_bucket)
        namespaced_blob = os.path.join(namespaced_bucket, "d" * 40)
        with open(namespaced_blob, "wb") as handle:
            handle.write(b"legacy namespace")
        snapshot = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)
        self.assertIn(f"checklist/89/{'d' * 40}", snapshot["files"])

    def test_nested_legacy_namespace_is_rejected(self):
        nested = os.path.join(self.filestore, "checklist", "nested", "89")
        os.makedirs(nested)
        with open(os.path.join(nested, "d" * 40), "wb") as handle:
            handle.write(b"unsafe nested namespace")
        with self.assertRaisesRegex(RuntimeError, "unsicheren Pfad"):
            PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)

    def test_cleanup_failure_is_fatal(self):
        before = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)
        new_blob = os.path.join(self.bucket, "b" * 40)
        with open(new_blob, "wb") as handle:
            handle.write(b"temporary")
        written = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)

        def fail_unlink(_path):
            raise PermissionError("simulated cleanup failure")

        with self.assertRaisesRegex(PermissionError, "simulated cleanup failure"):
            PROBE.cleanup_created_entries(
                self.filestore,
                before,
                written,
                f"ab/{'b' * 40}",
                unlink_fn=fail_unlink,
                fsync_fn=lambda _path: None,
            )
        self.assertTrue(os.path.exists(new_blob))

    def test_cleanup_refuses_traversal(self):
        before = {"directories": {""}, "files": {}, "treeSha256": "a" * 64}
        expected_blob = f"ab/{'b' * 40}"
        written = {
            "directories": {""},
            "files": {expected_blob: "b" * 64, "../escape": "c" * 64},
            "treeSha256": "d" * 64,
        }
        with self.assertRaisesRegex(RuntimeError, "nicht zur Probe gehoerenden"):
            PROBE.cleanup_created_entries(
                self.filestore,
                before,
                written,
                expected_blob,
                fsync_fn=lambda _path: None,
            )

    def test_cleanup_removes_exact_blob_and_checklist_marker(self):
        before = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)
        relative_blob = f"cd/{'c' * 40}"
        blob = os.path.join(self.filestore, *relative_blob.split("/"))
        marker = os.path.join(self.filestore, "checklist", *relative_blob.split("/"))
        os.makedirs(os.path.dirname(blob))
        os.makedirs(os.path.dirname(marker))
        with open(blob, "wb") as handle:
            handle.write(b"temporary")
        with open(marker, "wb") as handle:
            handle.write(b"")
        written = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)

        self.assertEqual(
            PROBE.cleanup_created_entries(
                self.filestore,
                before,
                written,
                relative_blob,
                fsync_fn=lambda _path: None,
            ),
            2,
        )
        final = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)
        PROBE.assert_final_tree_matches(before, final)

    def test_cleanup_refuses_unrelated_safe_namespaced_file(self):
        before = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)
        relative_blob = f"cd/{'c' * 40}"
        blob = os.path.join(self.filestore, *relative_blob.split("/"))
        unrelated = os.path.join(self.filestore, "other", "ef", "d" * 40)
        os.makedirs(os.path.dirname(blob))
        os.makedirs(os.path.dirname(unrelated))
        with open(blob, "wb") as handle:
            handle.write(b"temporary")
        with open(unrelated, "wb") as handle:
            handle.write(b"unrelated")
        written = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)

        with self.assertRaisesRegex(RuntimeError, "nicht zur Probe gehoerenden"):
            PROBE.cleanup_created_entries(
                self.filestore,
                before,
                written,
                relative_blob,
                fsync_fn=lambda _path: None,
            )
        self.assertTrue(os.path.exists(blob))
        self.assertTrue(os.path.exists(unrelated))

    def test_final_tree_drift_is_fatal(self):
        before = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)
        new_blob = os.path.join(self.bucket, "b" * 40)
        with open(new_blob, "wb") as handle:
            handle.write(b"drift")
        final = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)
        with self.assertRaisesRegex(RuntimeError, "Baumdrift"):
            PROBE.assert_final_tree_matches(before, final)

    @unittest.skipIf(os.name == "nt", "Windows requires elevated symlink privileges")
    def test_symlink_is_rejected(self):
        os.symlink(self.baseline_blob, os.path.join(self.filestore, "cd"))
        with self.assertRaisesRegex(RuntimeError, "Symlink"):
            PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)


if __name__ == "__main__":
    unittest.main()
