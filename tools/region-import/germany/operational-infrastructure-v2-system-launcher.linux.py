
import base64
import fcntl
import hashlib
import json
import os
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import traceback

temp_anchor_fd = None
private_temp = None
child = None
RUNNER_TIMEOUT_SECONDS = 21600
try:
    node_path, node_bytes_text, node_sha256, bundle_path, expected_bytes_text, expected_sha256, launcher_mode, launcher_source_bytes, launcher_source_sha256, workspace_root, *arguments = sys.argv[1:]
    expected_bytes = int(expected_bytes_text)
    expected_node_bytes = int(node_bytes_text)
    private_temp = tempfile.mkdtemp(prefix="zugfolge-operational-runner.retained-owned-cleanup-", dir="/tmp")
    os.chmod(private_temp, 0o700)
    private_temp_before = os.lstat(private_temp)
    if not stat.S_ISDIR(private_temp_before.st_mode) or stat.S_ISLNK(private_temp_before.st_mode):
        raise RuntimeError("Privates Launcher-Tempverzeichnis ist kein eigener regulaerer Verzeichnisroot.")
    temp_anchor_path = os.path.join(private_temp, "owner.anchor")
    temp_anchor_token = os.urandom(32)
    temp_anchor_fd = os.open(temp_anchor_path, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    os.write(temp_anchor_fd, temp_anchor_token)
    os.fsync(temp_anchor_fd)
    temp_anchor_identity = os.fstat(temp_anchor_fd)
    descriptor = os.open(bundle_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    node_descriptor = os.open(node_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size != expected_bytes or expected_bytes <= 0 or expected_bytes > 16777216:
            raise RuntimeError("Gehaltenes Runner-Bundle besitzt eine falsche Bytezahl.")
        chunks = []
        remaining = expected_bytes
        while remaining:
            chunk = os.read(descriptor, min(1048576, remaining))
            if not chunk:
                raise RuntimeError("Gehaltenes Runner-Bundle endete vorzeitig.")
            chunks.append(chunk)
            remaining -= len(chunk)
        bundle = b"".join(chunks)
        actual_sha256 = hashlib.sha256(bundle).hexdigest()
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size) or actual_sha256 != expected_sha256:
            raise RuntimeError("Gehaltenes Runner-Bundle driftete oder besitzt einen falschen SHA-256.")
        node_before = os.fstat(node_descriptor)
        if not stat.S_ISREG(node_before.st_mode) or node_before.st_size != expected_node_bytes or expected_node_bytes <= 0:
            raise RuntimeError("Gehaltene Node-Runtime besitzt eine falsche Bytezahl.")
        node_hash = hashlib.sha256()
        node_chunks = []
        while True:
            chunk = os.read(node_descriptor, 1048576)
            if not chunk:
                break
            node_chunks.append(chunk)
            node_hash.update(chunk)
        node_after = os.fstat(node_descriptor)
        if (node_before.st_dev, node_before.st_ino, node_before.st_size) != (node_after.st_dev, node_after.st_ino, node_after.st_size) or node_hash.hexdigest() != node_sha256:
            raise RuntimeError("Gehaltene Node-Runtime driftete oder besitzt einen falschen SHA-256.")
        node_bytes = b"".join(node_chunks)
        runtime_fd = os.memfd_create("zugfolge-operational-node", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        position = 0
        while position < len(node_bytes):
            position += os.write(runtime_fd, node_bytes[position:])
        os.fchmod(runtime_fd, 0o500)
        runtime_seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(runtime_fd, fcntl.F_ADD_SEALS, runtime_seals)
        if fcntl.fcntl(runtime_fd, fcntl.F_GET_SEALS) != runtime_seals:
            raise RuntimeError("Node-Runtime-memfd wurde nicht vollstaendig versiegelt.")
        executable_node = "/proc/self/fd/" + str(runtime_fd)
        reexec_node = "/proc/" + str(os.getpid()) + "/fd/" + str(runtime_fd)
        probe = subprocess.run(
            [executable_node, "--version"],
            executable=executable_node,
            cwd=workspace_root,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "TMPDIR": private_temp},
            pass_fds=(runtime_fd,),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
        version = probe.stdout.decode("ascii", "strict").strip()
        version_parts = version.removeprefix("v").split(".")
        if probe.returncode != 0 or len(version_parts) != 3 or version_parts[0] != "24" or not all(part.split("-", 1)[0].isdigit() for part in version_parts):
            raise RuntimeError("Gehaltene Node-Runtime ist nicht Node 24.")
        environment = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C",
            "LC_ALL": "C",
            "TMPDIR": private_temp,
            "ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE": launcher_mode,
            "ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_BYTES": launcher_source_bytes,
            "ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256": launcher_source_sha256,
            "ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_BYTES": str(expected_bytes),
            "ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256": actual_sha256,
            "ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SOURCE_PATH": bundle_path,
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_BYTES": str(expected_node_bytes),
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256": node_sha256,
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_PATH": executable_node,
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH": reexec_node,
            "ZUGFOLGE_OPERATIONAL_RUNNER_RUNTIME_SOURCE_PATH": node_path,
            "ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT": workspace_root,
            "ZUGFOLGE_OPERATIONAL_RUNNER_PHASE": "derive-and-capture-v1",
            "ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT": str(len(arguments)),
        }
        for index, argument in enumerate(arguments):
            environment["ZUGFOLGE_OPERATIONAL_RUNNER_CLI_" + str(index)] = argument
        child = subprocess.Popen(
            [executable_node, "--input-type=module", "-"],
            executable=executable_node,
            cwd=workspace_root,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(runtime_fd,),
            start_new_session=True,
        )
        streams = {child.stdout: bytearray(), child.stderr: bytearray()}
        selector = selectors.DefaultSelector()
        selector.register(child.stdin, selectors.EVENT_WRITE)
        selector.register(child.stdout, selectors.EVENT_READ)
        selector.register(child.stderr, selectors.EVENT_READ)
        written = 0
        deadline = time.monotonic() + RUNNER_TIMEOUT_SECONDS
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                raise RuntimeError("Bundle-Node-Prozess ueberschritt das gepinnte Zeitlimit.")
            for key, mask in selector.select(min(1.0, remaining)):
                stream = key.fileobj
                if stream is child.stdin:
                    try:
                        count = os.write(stream.fileno(), bundle[written:written + 65536])
                        written += count
                    except BrokenPipeError:
                        written = len(bundle)
                    if written == len(bundle):
                        selector.unregister(stream)
                        stream.close()
                    continue
                chunk = os.read(stream.fileno(), 8192)
                if not chunk:
                    selector.unregister(stream)
                    continue
                target = streams[stream]
                if len(target) + len(chunk) > 1048576:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    raise RuntimeError("Bundle-Node-Prozess ueberschritt das stdout/stderr-Limit.")
                target.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise RuntimeError("Bundle-Node-Prozess ueberschritt das gepinnte Zeitlimit.")
        try:
            returncode = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise RuntimeError("Bundle-Node-Prozess ueberschritt das gepinnte Zeitlimit.")
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        private_temp_after = os.lstat(private_temp)
        anchor_path_after = os.stat(temp_anchor_path, follow_symlinks=False)
        anchor_handle_after = os.fstat(temp_anchor_fd)
        if ((private_temp_before.st_dev, private_temp_before.st_ino) != (private_temp_after.st_dev, private_temp_after.st_ino)
                or not stat.S_ISDIR(private_temp_after.st_mode) or stat.S_ISLNK(private_temp_after.st_mode)
                or (temp_anchor_identity.st_dev, temp_anchor_identity.st_ino, temp_anchor_identity.st_size) != (anchor_path_after.st_dev, anchor_path_after.st_ino, anchor_path_after.st_size)
                or (temp_anchor_identity.st_dev, temp_anchor_identity.st_ino, temp_anchor_identity.st_size) != (anchor_handle_after.st_dev, anchor_handle_after.st_ino, anchor_handle_after.st_size)):
            raise RuntimeError("Privater Launcher-Temp-Root oder Ownership-Anker driftete und bleibt erhalten.")
        os.lseek(temp_anchor_fd, 0, os.SEEK_SET)
        if os.read(temp_anchor_fd, len(temp_anchor_token) + 1) != temp_anchor_token:
            raise RuntimeError("Privater Launcher-Tempanker driftete und bleibt erhalten.")
        if os.listdir(private_temp) != ["owner.anchor"]:
            raise RuntimeError("Privates Launcher-Tempverzeichnis enthaelt fremde Dateien und bleibt erhalten.")
        envelope = {
            "anchorBytes": expected_bytes,
            "anchorSha256": actual_sha256,
            "status": returncode if returncode >= 0 else None,
            "signal": -returncode if returncode < 0 else None,
            "stdoutBase64": base64.b64encode(bytes(streams[child.stdout])).decode("ascii"),
            "stderrBase64": base64.b64encode(bytes(streams[child.stderr])).decode("ascii"),
        }
        sys.stdout.write(json.dumps(envelope, separators=(",", ":"), sort_keys=True))
        os.close(runtime_fd)
        if returncode != 0:
            sys.exit(94 if returncode >= 0 else 128 - returncode)
    finally:
        os.close(node_descriptor)
        os.close(descriptor)
except Exception:
    if child is not None and child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        except Exception:
            pass
    traceback.print_exc(file=sys.stderr)
    sys.exit(93)
finally:
    if temp_anchor_fd is not None:
        os.close(temp_anchor_fd)
