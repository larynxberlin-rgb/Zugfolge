import base64
import hashlib
import json
import os
import random
import re
import stat


SCHEMA = "zugfolge-legacy-odoo-schema29-write-probe/v2"
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
SAFE_DATABASE = re.compile(r"^zugfolge_odoo_recovery_v1_[a-z0-9_]+$")
HASH_DIRECTORY = re.compile(r"^[a-f0-9]{2}$")
HASH_PATH = re.compile(r"^[a-f0-9]{2}/[a-f0-9]{40}$")


def invariant(condition, message):
    if not condition:
        raise RuntimeError(message)


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} fehlt.")
    return value


def numeric_identity(name):
    value = required(name)
    invariant(value.isdigit() and int(value) > 0, f"{name} muss eine numerische Nicht-root-Identitaet sein.")
    return int(value)


def canonical_sha256(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def safe_filestore_path(database_name, configured_path=None):
    invariant(SAFE_DATABASE.fullmatch(database_name) is not None, "Schema-29-Odoo-Probe besitzt keinen sicheren Datenbanknamen.")
    mount_root = os.path.abspath("/var/lib/odoo/filestore")
    target = os.path.abspath(configured_path or os.path.join(mount_root, database_name))
    invariant(target == os.path.join(mount_root, database_name), "Schema-29-Odoo-Probe-Filestore muss das datenbankbenannte direkte Kind des festen Mounts sein.")
    root_status = os.lstat(mount_root)
    target_status = os.lstat(target)
    invariant(stat.S_ISDIR(root_status.st_mode) and not stat.S_ISLNK(root_status.st_mode), "Schema-29-Odoo-Probe-Mount ist kein direktes Verzeichnis.")
    invariant(stat.S_ISDIR(target_status.st_mode) and not stat.S_ISLNK(target_status.st_mode), "Schema-29-Odoo-Probe-Filestore ist kein direktes Verzeichnis.")
    invariant(os.path.realpath(target) == target and os.path.dirname(target) == os.path.realpath(mount_root), "Schema-29-Odoo-Probe-Filestore verlaesst den festen Mount.")
    return target


def stable_file_sha256(path, expected_status):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    digest = hashlib.sha256()
    size = 0
    try:
        opened = os.fstat(descriptor)
        invariant((opened.st_dev, opened.st_ino) == (expected_status.st_dev, expected_status.st_ino), "Odoo-Filestoredatei wurde beim Oeffnen ausgetauscht.")
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
        after = os.fstat(descriptor)
        installed = os.lstat(path)
        invariant(
            (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            and (after.st_dev, after.st_ino) == (installed.st_dev, installed.st_ino)
            and size == after.st_size,
            "Odoo-Filestoredatei aenderte sich beim Lesen.",
        )
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def snapshot_filestore(root, owner_uid, owner_gid, require_owner_writable=True):
    files = {}
    directories = set()

    def visit(path, relative_path, depth):
        status_value = os.lstat(path)
        invariant(not stat.S_ISLNK(status_value.st_mode), "Schema-29-Odoo-Probe-Filestore enthaelt einen Symlink.")
        is_directory = stat.S_ISDIR(status_value.st_mode)
        invariant(is_directory or stat.S_ISREG(status_value.st_mode), "Schema-29-Odoo-Probe-Filestore enthaelt einen unzulaessigen Dateityp.")
        invariant((status_value.st_uid, status_value.st_gid) == (owner_uid, owner_gid), "Schema-29-Odoo-Probe-Filestore gehoert nicht dem gebundenen Runtime-Owner.")
        mode = stat.S_IMODE(status_value.st_mode)
        if require_owner_writable:
            invariant(mode & stat.S_IWUSR, "Schema-29-Odoo-Probe-Filestore ist trotz RW-Mount fuer den Runtime-Owner nicht beschreibbar.")
            invariant(not mode & (stat.S_IWGRP | stat.S_IWOTH), "Schema-29-Odoo-Probe-Filestore ist fuer Gruppe oder Andere beschreibbar.")
            invariant(mode & stat.S_IRUSR and (not is_directory or mode & stat.S_IXUSR), "Schema-29-Odoo-Probe-Filestore besitzt keine Owner-Lese-/Ausfuehrungsrechte.")
        if relative_path:
            invariant(
                (is_directory and depth == 1 and HASH_DIRECTORY.fullmatch(relative_path) is not None)
                or (not is_directory and HASH_PATH.fullmatch(relative_path) is not None),
                f"Schema-29-Odoo-Probe-Filestore enthaelt den unsicheren Pfad '{relative_path}'.",
            )
        if is_directory:
            directories.add(relative_path)
            with os.scandir(path) as iterator:
                entries = sorted(iterator, key=lambda entry: os.fsencode(entry.name))
            for entry in entries:
                invariant(entry.name not in (".", "..") and "/" not in entry.name and "\\" not in entry.name, "Schema-29-Odoo-Probe-Filestore enthaelt einen unsicheren Namen.")
                child_relative = entry.name if not relative_path else f"{relative_path}/{entry.name}"
                visit(os.path.join(path, entry.name), child_relative, depth + 1)
        else:
            files[relative_path] = stable_file_sha256(path, status_value)

    visit(root, "", 0)
    lines = "".join(f"{files[path]}  ./{path}\n" for path in sorted(files, key=os.fsencode))
    return {"directories": directories, "files": files, "treeSha256": hashlib.sha256(lines.encode("utf-8")).hexdigest()}


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_blob(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(os.path.dirname(path))


def read_blob_without_following(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    chunks = []
    try:
        status_value = os.fstat(descriptor)
        invariant(stat.S_ISREG(status_value.st_mode), "Legacy-Odoo-Blobpfad ist keine regulaere Datei.")
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        installed = os.lstat(path)
        invariant((status_value.st_dev, status_value.st_ino) == (installed.st_dev, installed.st_ino), "Legacy-Odoo-Blobpfad wurde beim Lesen ausgetauscht.")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def cleanup_created_entries(root, before, written, unlink_fn=os.unlink, rmdir_fn=os.rmdir, fsync_fn=fsync_directory):
    created_files = sorted(set(written["files"]) - set(before["files"]), key=os.fsencode, reverse=True)
    created_directories = sorted(
        (path for path in set(written["directories"]) - set(before["directories"]) if path),
        key=lambda path: (path.count("/"), os.fsencode(path)),
        reverse=True,
    )
    for relative_path in created_files:
        invariant(HASH_PATH.fullmatch(relative_path) is not None, "Schema-29-Odoo-Probe verweigert Cleanup ausserhalb eines Odoo-Hashpfads.")
        absolute = os.path.abspath(os.path.join(root, *relative_path.split("/")))
        invariant(os.path.commonpath((root, absolute)) == root, "Schema-29-Odoo-Probe-Cleanup verlaesst den Filestore.")
        status_value = os.lstat(absolute)
        invariant(stat.S_ISREG(status_value.st_mode) and not stat.S_ISLNK(status_value.st_mode), "Schema-29-Odoo-Probe-Cleanup verweigert einen ausgetauschten Blobpfad.")
        unlink_fn(absolute)
        fsync_fn(os.path.dirname(absolute))
    for relative_path in created_directories:
        invariant(HASH_DIRECTORY.fullmatch(relative_path) is not None, "Schema-29-Odoo-Probe verweigert Cleanup eines fremden Verzeichnisses.")
        absolute = os.path.abspath(os.path.join(root, relative_path))
        invariant(os.path.commonpath((root, absolute)) == root, "Schema-29-Odoo-Probe-Cleanup-Verzeichnis verlaesst den Filestore.")
        status_value = os.lstat(absolute)
        invariant(stat.S_ISDIR(status_value.st_mode) and not stat.S_ISLNK(status_value.st_mode), "Schema-29-Odoo-Probe-Cleanup verweigert ein ausgetauschtes Verzeichnis.")
        rmdir_fn(absolute)
        fsync_fn(os.path.dirname(absolute))
    return len(created_files)


def assert_final_tree_matches(before, final):
    invariant(before["files"] == final["files"] and before["directories"] == final["directories"] and before["treeSha256"] == final["treeSha256"], "Schema-29-Odoo-Probe hinterliess einen finalen Filestore-Baumdrift.")


def publish_create_new(path, evidence_root, value):
    absolute = os.path.abspath(path)
    root_input = os.path.abspath(evidence_root)
    root_status = os.lstat(root_input)
    invariant(stat.S_ISDIR(root_status.st_mode) and not stat.S_ISLNK(root_status.st_mode), "Schema-29-Odoo-Probe-Evidence-Wurzel ist unsicher.")
    root = os.path.realpath(root_input)
    invariant(root != os.path.abspath(os.sep) and os.path.dirname(absolute) == root, "Schema-29-Odoo-Probe-Beleg muss direkt in der festen Evidence-Wurzel liegen.")
    invariant(re.fullmatch(r"[a-z0-9][a-z0-9._-]*\.json", os.path.basename(absolute)) is not None, "Schema-29-Odoo-Probe-Beleg besitzt keinen sicheren Dateinamen.")
    temporary = os.path.join(root, f".{os.path.basename(absolute)}.{os.getpid()}.{random.getrandbits(128):032x}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    linked = False
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, absolute)
        linked = True
        fsync_directory(root)
        os.unlink(temporary)
    except Exception:
        if linked:
            try:
                os.unlink(absolute)
            except OSError:
                pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def run_probe(odoo_env):
    recovery_id = required("PRODUCTION_RECOVERY_ID")
    legacy_image_digest = required("PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST")
    database_name = required("PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE")
    output_path = required("PRODUCTION_SCHEMA29_ODOO_LEGACY_PROBE_OUTPUT_PATH")
    evidence_root = required("PRODUCTION_RECOVERY_EVIDENCE_ROOT")
    owner_uid = numeric_identity("PRODUCTION_RECOVERY_ODOO_RUNTIME_UID")
    owner_gid = numeric_identity("PRODUCTION_RECOVERY_ODOO_RUNTIME_GID")
    invariant(SAFE_ID.fullmatch(recovery_id) is not None, "PRODUCTION_RECOVERY_ID ist nicht kanonisch.")
    invariant(re.fullmatch(r"sha256:[a-f0-9]{64}", legacy_image_digest) is not None, "Legacy-Odoo-Image-Digest ist ungueltig.")
    filestore = safe_filestore_path(database_name, required("PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH"))
    invariant(os.geteuid() == owner_uid and os.getegid() == owner_gid, "Schema-29-Odoo-Probe laeuft nicht als gebundener Runtime-Owner.")
    before = snapshot_filestore(filestore, owner_uid, owner_gid)
    probe_key = f"zugfolge.schema29-recovery-probe.{recovery_id}"
    existing_parameter = odoo_env["ir.config_parameter"].sudo().search([("key", "=", probe_key)], limit=1)
    existing_attachment = odoo_env["ir.attachment"].sudo().search([("name", "=", probe_key)], limit=1)
    invariant(not existing_parameter and not existing_attachment, "Die Odoo-Schema-29-Schreibprobe ist nicht create-new.")
    record = odoo_env["ir.config_parameter"].sudo().create({"key": probe_key, "value": "rollback-only"})
    blob = b"zugfolge-schema29-odoo-filestore-v2\0" + recovery_id.encode("ascii") + b"\0" + os.urandom(32)
    attachment = odoo_env["ir.attachment"].sudo().create({
        "datas": base64.b64encode(blob),
        "mimetype": "application/octet-stream",
        "name": probe_key,
        "res_id": record.id,
        "res_model": "ir.config_parameter",
        "type": "binary",
    })
    odoo_env.flush_all()
    temporary_record_id = record.id
    temporary_attachment_id = attachment.id
    invariant(odoo_env["ir.config_parameter"].sudo().search_count([("key", "=", probe_key)]) == 1, "Legacy-Odoo konnte den temporaeren Fachdatensatz nicht schreiben.")
    invariant(odoo_env["ir.attachment"].sudo().search_count([("id", "=", temporary_attachment_id)]) == 1, "Legacy-Odoo konnte das temporaere Attachment nicht schreiben.")
    store_fname = attachment.store_fname
    invariant(isinstance(store_fname, str) and HASH_PATH.fullmatch(store_fname) is not None, "Legacy-Odoo erzeugte keinen regulaeren Filestore-Hashpfad.")
    blob_path = os.path.abspath(os.path.join(filestore, *store_fname.split("/")))
    invariant(os.path.commonpath((filestore, blob_path)) == filestore, "Legacy-Odoo-Blobpfad verlaesst den Filestore.")
    written = snapshot_filestore(filestore, owner_uid, owner_gid)
    invariant(written["treeSha256"] != before["treeSha256"] and store_fname in written["files"], "Legacy-Odoo erzeugte keine neue Filestore-Datei.")
    direct_read = read_blob_without_following(blob_path)
    odoo_env.invalidate_all()
    odoo_read = base64.b64decode(odoo_env["ir.attachment"].sudo().browse(temporary_attachment_id).datas or b"", validate=True)
    invariant(direct_read == blob and odoo_read == blob, "Legacy-Odoo las das Attachment nicht bytegleich aus Datenbank und Filestore.")
    fsync_blob(blob_path)
    odoo_env.cr.rollback()
    odoo_env.invalidate_all()
    invariant(not odoo_env["ir.config_parameter"].sudo().search_count([("key", "=", probe_key)]), "Legacy-Odoo-Schema-29-Fachdatensatz wurde nicht vollstaendig zurueckgerollt.")
    invariant(not odoo_env["ir.attachment"].sudo().search_count([("id", "=", temporary_attachment_id)]), "Legacy-Odoo-Schema-29-Attachment wurde nicht vollstaendig zurueckgerollt.")
    created_file_count = cleanup_created_entries(filestore, before, written)
    final = snapshot_filestore(filestore, owner_uid, owner_gid)
    assert_final_tree_matches(before, final)
    blob_sha256 = hashlib.sha256(blob).hexdigest()
    payload = {
        "blobBytes": len(blob), "blobRelativePath": store_fname, "blobSha256": blob_sha256,
        "cleanupComplete": True, "createdFileCount": created_file_count, "databaseName": database_name,
        "directReadSha256": hashlib.sha256(direct_read).hexdigest(), "filestoreBeforeTreeSha256": before["treeSha256"],
        "filestoreFinalTreeSha256": final["treeSha256"], "filestoreWrittenTreeSha256": written["treeSha256"],
        "fsynced": True, "legacyOdooImageDigest": legacy_image_digest,
        "odooReadSha256": hashlib.sha256(odoo_read).hexdigest(), "recoveryId": recovery_id,
        "rolledBack": True, "schema": SCHEMA, "temporaryAttachmentId": temporary_attachment_id,
        "temporaryRecordId": temporary_record_id,
    }
    publish_create_new(output_path, evidence_root, {**payload, "receiptHash": canonical_sha256(payload)})


if "env" in globals():
    run_probe(env)
