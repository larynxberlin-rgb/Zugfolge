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

    def test_cleanup_failure_is_fatal(self):
        before = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)
        new_blob = os.path.join(self.bucket, "b" * 40)
        with open(new_blob, "wb") as handle:
            handle.write(b"temporary")
        written = PROBE.snapshot_filestore(self.filestore, self.uid, self.gid, require_owner_writable=False)

        def fail_unlink(_path):
            raise PermissionError("simulated cleanup failure")

        with self.assertRaisesRegex(PermissionError, "simulated cleanup failure"):
            PROBE.cleanup_created_entries(self.filestore, before, written, unlink_fn=fail_unlink, fsync_fn=lambda _path: None)
        self.assertTrue(os.path.exists(new_blob))

    def test_cleanup_refuses_traversal(self):
        before = {"directories": {""}, "files": {}, "treeSha256": "a" * 64}
        written = {"directories": {""}, "files": {"../escape": "b" * 64}, "treeSha256": "c" * 64}
        with self.assertRaisesRegex(RuntimeError, "Hashpfads"):
            PROBE.cleanup_created_entries(self.filestore, before, written, fsync_fn=lambda _path: None)

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
