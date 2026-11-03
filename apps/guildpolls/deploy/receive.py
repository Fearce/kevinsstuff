"""Forced SSH command for guildpolls.kevinsstuff.com releases.

The CI key can only run `deploy <40-character commit>` with a gzipped tar of `guildpolls/` (package.json,
release.json, src/ and public/) on stdin. The receiver backs up the live database, builds the release with the
Dockerfile pinned on the host, swaps the container over and checks that it reports the requested commit, rolling
back to the previous image if it does not. The Dockerfile, compose.yaml and the poll password are installed by
the owner (deploy/install.py) and never travel with a release, so the CI key cannot change how the app runs.
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

HOME = pathlib.Path(__file__).resolve().parent.parent
APP = 'guildpolls'
LABEL = 'org.kevinsstuff.app=guildpolls'
LIVE = f'{APP}:live'
REQUEST = re.compile(r'deploy ([0-9a-f]{40})')
RELEASE_TAG = re.compile(r'[0-9a-f]{12}')
TOP_FILES = {'package.json', 'release.json'}
TOP_DIRS = {'src', 'public'}
PINNED = ('Dockerfile', '.dockerignore')
MAX_ARCHIVE = 8 * 1024 * 1024
MAX_UNPACKED = 16 * 1024 * 1024
MAX_MEMBERS = 500
KEEP_IMAGES = 3
LOCK_TIMEOUT = 300
RECEIVE_TIMEOUT = 120


class Rejected(Exception):
    """The request or archive is invalid; nothing changed on the host."""


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
    if not parts or name.startswith('/') or '\\' in name or '..' in parts or parts[0] != APP:
        return False
    if len(parts) == 1:
        return member.isdir()
    if len(parts) == 2 and parts[1] in TOP_FILES:
        return member.isfile()
    return parts[1] in TOP_DIRS and (member.isfile() or member.isdir())


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
    return target / APP


def check_release(context, commit):
    try:
        manifest = json.loads((context / 'release.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise Rejected('guildpolls/release.json is missing or invalid') from None
    if not isinstance(manifest, dict) or manifest.get('commit') != commit:
        raise Rejected('guildpolls/release.json does not name the requested commit')
    for required in ('package.json', 'src/main.js', 'public/index.html'):
        if not (context / required).is_file():
            raise Rejected(f'guildpolls/{required} is missing')


def pin_build_files(context, home):
    for name in PINNED:
        shutil.copyfile(home / name, context / name)
    return context


class Docker:
    """The host operations a release needs, kept in one place so tests can stand in for them."""

    def __init__(self, home):
        self.home = home

    def run(self, *argv, timeout=120, check=True):
        result = subprocess.run(['docker', *argv], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if check and result.returncode:
            raise RuntimeError(f'docker {argv[0]} failed: {(result.stderr or result.stdout).strip()}')
        return result

    def running(self):
        result = self.run('inspect', '-f', '{{.State.Running}}', APP, check=False)
        return result.returncode == 0 and result.stdout.strip() == 'true'

    def backup(self):
        output = self.run('exec', APP, 'node', '--disable-warning=ExperimentalWarning', 'src/backup.js').stdout
        return output.strip()

    def build(self, context, tag):
        self.run('build', '--quiet', '--label', LABEL, '--tag', f'{APP}:{tag}', str(context), timeout=300)

    def live_image(self):
        result = self.run('image', 'inspect', '-f', '{{.Id}}', LIVE, check=False)
        return result.stdout.strip() if result.returncode == 0 else None

    def make_live(self, image):
        self.run('tag', image, LIVE)
        self.run('compose', '--project-directory', str(self.home), '-p', APP, 'up', '-d', '--wait',
                 '--wait-timeout', '90', timeout=180)

    def served_release(self):
        result = self.run('exec', APP, 'wget', '-q', '-O', '-', 'http://127.0.0.1:8080/api/health',
                          check=False, timeout=30)
        if result.returncode:
            return None
        try:
            return json.loads(result.stdout).get('release')
        except ValueError:
            return None

    def release_tags(self):
        result = self.run('image', 'ls', '--filter', f'label={LABEL}', '--format', '{{.Tag}} {{.CreatedAt}}')
        rows = [line.split(' ', 1) for line in result.stdout.splitlines() if line.strip()]
        return [tag for tag, _ in sorted(rows, key=lambda row: row[1], reverse=True) if RELEASE_TAG.fullmatch(tag)]

    def remove(self, tag):
        self.run('image', 'rm', f'{APP}:{tag}', check=False)

    def prune_dangling(self):
        self.run('image', 'prune', '-f', '--filter', f'label={LABEL}', check=False)


def verify(docker, commit, attempts=10, delay=2):
    for attempt in range(attempts):
        if docker.served_release() == commit:
            return
        if attempt < attempts - 1:
            time.sleep(delay)
    raise RuntimeError(f'{APP} did not report release {commit}')


def prune(docker, keep):
    removed = []
    for tag in docker.release_tags()[KEEP_IMAGES:]:
        if tag not in keep:
            docker.remove(tag)
            removed.append(tag)
    docker.prune_dangling()
    return removed


@contextlib.contextmanager
def deployment_lock(home):
    import fcntl
    with (home / '.deploy-lock').open('a') as stream:
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


def switch(docker, commit, tag, previous):
    """Point the container at the new image; on failure, put the previous image back and re-raise."""
    try:
        docker.make_live(f'{APP}:{tag}')
        verify(docker, commit)
    except Exception:
        if previous:
            docker.make_live(previous)
            say('Rolled back to the previous image.')
        raise


def deploy(commit, stream, home=HOME, docker=None):
    docker = docker or Docker(home)
    tag = commit[:12]
    with deployment_lock(home), tempfile.TemporaryDirectory(dir=home, prefix='.incoming-') as work:
        work = pathlib.Path(work)
        context = unpack(receive(stream, work / 'release.tar.gz'), work / 'staged')
        check_release(context, commit)
        backup = docker.backup() if docker.running() else None
        docker.build(pin_build_files(context, home), tag)
        previous = docker.live_image()
        switch(docker, commit, tag, previous)
        pruned = prune(docker, {tag})
    return {'deployed': commit, 'image': f'{APP}:{tag}', 'backup': backup, 'pruned': pruned}


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
