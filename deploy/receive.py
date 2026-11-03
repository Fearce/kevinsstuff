"""Forced SSH command for kevinsstuff.com releases.

The CI key can only run `deploy <40-character commit>` with a gzipped tar of `dist/` on stdin.
The release is unpacked beside the live one and published by swapping the `current` symlink,
so visitors see either the old site or the new one, never a half-copied tree. The container
definition is installed by the owner (deploy/install.py) and never travels with a release.
"""
import contextlib
import gzip
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / 'site'
CONTAINER = 'kevinsstuff-web'
REQUEST = re.compile(r'deploy ([0-9a-f]{40})')
RELEASE_NAME = re.compile(r'[0-9a-f]{12}')
MAX_ARCHIVE = 48 * 1024 * 1024
MAX_UNPACKED = 96 * 1024 * 1024
MAX_MEMBERS = 2000
KEEP_RELEASES = 3
LOCK_TIMEOUT = 300
RECEIVE_TIMEOUT = 300


class Rejected(Exception):
    """The request or archive is invalid; nothing was published."""


def say(message):
    try:
        print(message, flush=True)
    except OSError:
        pass  # The client disconnected; finishing the release beats abandoning it midway.


def requested_commit(environ, argv):
    command = environ.get('SSH_ORIGINAL_COMMAND', ' '.join(argv))
    match = REQUEST.fullmatch(command)
    if not match:
        raise Rejected('Only "deploy <40-character commit>" is accepted')
    return match.group(1)


@contextlib.contextmanager
def upload_deadline():
    if not hasattr(signal, 'SIGALRM'):
        yield
        return

    def expire(signum, frame):
        raise Rejected(f'The upload did not finish within {RECEIVE_TIMEOUT} seconds')

    previous = signal.signal(signal.SIGALRM, expire)
    signal.alarm(RECEIVE_TIMEOUT)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def receive(stream, destination):
    received = 0
    with upload_deadline(), destination.open('wb') as file:
        while chunk := stream.read(1024 * 1024):
            received += len(chunk)
            if received > MAX_ARCHIVE:
                raise Rejected(f'Release archive exceeds {MAX_ARCHIVE // (1024 * 1024)} MiB')
            file.write(chunk)
    if not received:
        raise Rejected('No release archive arrived on standard input')
    return destination


def inflate(archive_path, destination):
    # tarfile buffers pax and long-name headers whole, so cap the decompressed stream before it parses them.
    written = 0
    try:
        with gzip.open(archive_path) as source, destination.open('wb') as target:
            while chunk := source.read(1024 * 1024):
                written += len(chunk)
                if written > MAX_UNPACKED:
                    raise Rejected('Release archive unpacks beyond the configured bound')
                target.write(chunk)
    except (EOFError, zlib.error, gzip.BadGzipFile) as error:
        raise Rejected(f'Release archive could not be unpacked: {error}') from None
    return destination


def entry_name(member):
    name = member.name
    while name.startswith('./'):
        name = name[2:]
    return name.rstrip('/')


def allowed(member, name):
    parts = pathlib.PurePosixPath(name).parts
    if not parts or name.startswith('/') or '\\' in name or '..' in parts or parts[0] != 'dist':
        return False
    return member.isfile() or member.isdir()


def release_members(archive):
    members, names = [], set()
    for member in archive:
        name = entry_name(member)
        if name in ('', '.'):
            continue
        if name in names or not allowed(member, name):
            raise Rejected(f'Unexpected archive entry: {member.name}')
        names.add(name)
        members.append(member)
        if len(members) > MAX_MEMBERS:
            raise Rejected('Release archive has more entries than the configured bound')
    return members


def unpack(archive_path, target):
    tar_path = inflate(archive_path, archive_path.with_suffix(''))
    try:
        with tarfile.open(tar_path, 'r:') as archive:
            archive.extractall(target, members=release_members(archive), filter='data')
    except tarfile.TarError as error:
        raise Rejected(f'Release archive could not be unpacked: {error}') from None
    tar_path.unlink()
    return target / 'dist'


def check_release(dist, commit):
    try:
        manifest = json.loads((dist / 'release.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise Rejected('dist/release.json is missing or invalid') from None
    if not isinstance(manifest, dict) or manifest.get('commit') != commit:
        raise Rejected('dist/release.json does not name the requested commit')
    if not (dist / 'index.html').is_file():
        raise Rejected('dist/index.html is missing')


def make_readable(tree):
    # nginx in the container reads these as an unprivileged worker.
    for path in [tree, *tree.rglob('*')]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    return tree


def install(dist, short, site):
    releases = site / 'releases'
    release = releases / short
    if release.exists():
        shutil.rmtree(release)
    dist.rename(release)
    os.utime(release)
    return release


def live_release(site):
    current = site / 'current'
    if not current.is_symlink():
        return None
    return pathlib.PurePosixPath(os.readlink(current)).name


def publish(site, short):
    """Point `current` at the release in one rename(2), which readers observe atomically."""
    staging = site / 'current.next'
    if staging.is_symlink() or staging.exists():
        staging.unlink()
    staging.symlink_to(f'releases/{short}')
    os.replace(staging, site / 'current')


def served_release():
    result = subprocess.run(['docker', 'exec', CONTAINER, 'wget', '-q', '-O', '-',
                             'http://127.0.0.1:8080/release.json'],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
    return result.stdout if result.returncode == 0 else None


def verify(release, attempts=5, delay=2):
    expected = (release / 'release.json').read_bytes()
    for attempt in range(attempts):
        if served_release() == expected:
            return
        if attempt < attempts - 1:
            time.sleep(delay)
    raise RuntimeError(f'{CONTAINER} did not serve the new release.json')


def prune(site, keep):
    releases = site / 'releases'
    candidates = sorted((path for path in releases.iterdir()
                         if path.is_dir() and not path.is_symlink() and RELEASE_NAME.fullmatch(path.name)),
                        key=lambda path: path.stat().st_mtime, reverse=True)
    removed = []
    for path in candidates[KEEP_RELEASES:]:
        if path.name not in keep:
            shutil.rmtree(path)
            removed.append(path.name)
    return removed


@contextlib.contextmanager
def deployment_lock(site):
    import fcntl
    with (site / '.deploy-lock').open('a') as stream:
        deadline = time.monotonic() + LOCK_TIMEOUT
        while True:
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise Rejected('Another deployment is still running') from None
                time.sleep(2)
        yield


def deploy(commit, stream, site=SITE, check=verify):
    short = commit[:12]
    (site / 'releases').mkdir(parents=True, exist_ok=True)
    with deployment_lock(site), tempfile.TemporaryDirectory(dir=site / 'releases', prefix='.incoming-') as work:
        work = pathlib.Path(work)
        dist = unpack(receive(stream, work / 'release.tar.gz'), work / 'staged')
        check_release(dist, commit)
        previous = live_release(site)
        if previous == short:
            # A rerun of the live commit; replacing its tree in place would expose a half-copied site.
            check(site / 'releases' / short)
            return {'deployed': commit, 'release': short, 'previous': previous, 'unchanged': True}
        release = install(make_readable(dist), short, site)
        publish(site, short)
        try:
            check(release)
        except Exception:
            if previous:
                publish(site, previous)
                say(f'Rolled back to release {previous}.')
            raise
        pruned = prune(site, {short, previous})
    return {'deployed': commit, 'release': short, 'previous': previous, 'pruned': pruned}


def fail(message, code):
    try:
        print(message, file=sys.stderr, flush=True)
    finally:
        sys.exit(code)


def main():
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        receipt = deploy(requested_commit(os.environ, sys.argv[1:]), sys.stdin.buffer)
    except Rejected as error:
        fail(f'Rejected: {error}', 2)
    except (subprocess.SubprocessError, RuntimeError, OSError) as error:
        fail(f'Deployment failed: {error}', 1)
    say(json.dumps(receipt))


if __name__ == '__main__':
    main()
