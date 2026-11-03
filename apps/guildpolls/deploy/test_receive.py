import io
import json
import pathlib
import tarfile
import tempfile
import unittest
from unittest import mock

import receive

COMMIT_A = 'a' * 40
COMMIT_B = 'b' * 40


def archive(files, extra=None):
    """A gzipped tar of `guildpolls/<name>` entries, plus optional raw TarInfo members."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for info in extra or []:
            tar.addfile(info)
    return io.BytesIO(buffer.getvalue())


def app_files(commit):
    return {'guildpolls/package.json': b'{"name":"guildpolls"}',
            'guildpolls/release.json': json.dumps({'commit': commit}).encode(),
            'guildpolls/src/main.js': b'console.log("hi")',
            'guildpolls/public/index.html': b'<h1>polls</h1>',
            'guildpolls/public/fonts/a.woff2': b'wOF2'}


class FakeDocker:
    """Records what the receiver asks of the host; `serves` decides which release a new container reports."""

    def __init__(self, running=True, serves=None, live=None):
        self.is_running = running
        self.serves = serves
        self.live = live
        self.calls = []
        self.built = {}
        self.tags = []

    def running(self):
        return self.is_running

    def backup(self):
        self.calls.append('backup')
        return 'backup written'

    def build(self, context, tag):
        self.calls.append(f'build {tag}')
        self.built[tag] = {path.relative_to(context).as_posix(): path.read_bytes()
                           for path in context.rglob('*') if path.is_file()}
        self.tags.insert(0, tag)

    def live_image(self):
        return self.live

    def make_live(self, image):
        self.calls.append(f'live {image}')
        self.live = image

    def served_release(self):
        return self.serves(self.live) if self.serves else None

    def release_tags(self):
        return list(self.tags)

    def remove(self, tag):
        self.calls.append(f'remove {tag}')
        self.tags.remove(tag)

    def prune_dangling(self):
        self.calls.append('prune')


def serves_commit_of(image):
    tag = image.split(':')[1]
    return {COMMIT_A[:12]: COMMIT_A, COMMIT_B[:12]: COMMIT_B}.get(tag)


class ReceiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.tmp.name)
        (self.home / 'Dockerfile').write_bytes(b'FROM pinned')
        (self.home / '.dockerignore').write_bytes(b'*\n')
        self.patch = mock.patch.object(receive, 'verify', self.fast_verify)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    @staticmethod
    def fast_verify(docker, commit, attempts=1, delay=0):
        if docker.served_release() != commit:
            raise RuntimeError('wrong release')

    def deploy(self, commit, stream, docker):
        return receive.deploy(commit, stream, home=self.home, docker=docker)

    def test_accepts_only_deploy_with_full_commit(self):
        self.assertEqual(receive.requested_commit({'SSH_ORIGINAL_COMMAND': f'deploy {COMMIT_A}'}, []), COMMIT_A)
        for command in ('', 'sh', f'deploy {COMMIT_A[:12]}', f'deploy {COMMIT_A}; sh', f'deploy {COMMIT_A.upper()}'):
            with self.assertRaises(receive.Rejected):
                receive.requested_commit({'SSH_ORIGINAL_COMMAND': command}, [])

    def test_backs_up_then_builds_with_pinned_files_and_goes_live(self):
        docker = FakeDocker(serves=serves_commit_of, live='sha256:old')
        receipt = self.deploy(COMMIT_A, archive(app_files(COMMIT_A)), docker)
        tag = COMMIT_A[:12]
        self.assertEqual(docker.calls[:3], ['backup', f'build {tag}', f'live guildpolls:{tag}'])
        self.assertEqual(receipt['image'], f'guildpolls:{tag}')
        built = docker.built[tag]
        self.assertEqual(built['Dockerfile'], b'FROM pinned')
        self.assertEqual(built['public/fonts/a.woff2'], b'wOF2')
        self.assertIn('release.json', built)

    def test_first_deploy_skips_the_backup(self):
        docker = FakeDocker(running=False, serves=serves_commit_of)
        receipt = self.deploy(COMMIT_A, archive(app_files(COMMIT_A)), docker)
        self.assertNotIn('backup', docker.calls)
        self.assertIsNone(receipt['backup'])

    def test_wrong_release_rolls_back_to_previous_image(self):
        docker = FakeDocker(serves=lambda image: None, live='sha256:old')
        with self.assertRaises(RuntimeError):
            self.deploy(COMMIT_B, archive(app_files(COMMIT_B)), docker)
        self.assertEqual(docker.live, 'sha256:old')
        self.assertEqual(docker.calls[-1], 'live sha256:old')

    def test_shipped_dockerfile_cannot_replace_the_pinned_one(self):
        files = {**app_files(COMMIT_A), 'guildpolls/Dockerfile': b'FROM evil'}
        docker = FakeDocker(serves=serves_commit_of)
        with self.assertRaises(receive.Rejected):
            self.deploy(COMMIT_A, archive(files), docker)
        self.assertEqual(docker.calls, [])

    def test_rejects_manifest_for_another_commit_before_touching_the_host(self):
        docker = FakeDocker(serves=serves_commit_of)
        with self.assertRaises(receive.Rejected):
            self.deploy(COMMIT_A, archive(app_files(COMMIT_B)), docker)
        self.assertEqual(docker.calls, [])

    def test_rejects_release_missing_required_files(self):
        for missing in ('guildpolls/src/main.js', 'guildpolls/public/index.html', 'guildpolls/package.json'):
            files = app_files(COMMIT_A)
            del files[missing]
            with self.assertRaises(receive.Rejected):
                self.deploy(COMMIT_A, archive(files), FakeDocker(serves=serves_commit_of))

    def test_rejects_entries_outside_the_app_and_links(self):
        link = tarfile.TarInfo('guildpolls/src/escape')
        link.type = tarfile.SYMTYPE
        link.linkname = '/etc/passwd'
        hostile = [
            archive({**app_files(COMMIT_A), 'compose.yaml': b'services: {}'}),
            archive({**app_files(COMMIT_A), 'guildpolls/.env': b'GUILDPOLLS_POLL_PASSWORD=x'}),
            archive({**app_files(COMMIT_A), 'guildpolls/src/../../evil': b'x'}),
            archive(app_files(COMMIT_A), extra=[link]),
        ]
        for stream in hostile:
            docker = FakeDocker(serves=serves_commit_of)
            with self.assertRaises(receive.Rejected):
                self.deploy(COMMIT_A, stream, docker)
            self.assertEqual(docker.calls, [])

    def test_rejects_empty_and_oversized_uploads(self):
        with self.assertRaises(receive.Rejected):
            self.deploy(COMMIT_A, io.BytesIO(), FakeDocker())
        with mock.patch.object(receive, 'MAX_ARCHIVE', 16), self.assertRaises(receive.Rejected):
            self.deploy(COMMIT_A, archive(app_files(COMMIT_A)), FakeDocker())

    def test_keeps_only_recent_release_images(self):
        docker = FakeDocker(serves=lambda image: None)
        docker.tags = ['c' * 12, 'd' * 12, 'e' * 12, 'f' * 12]
        removed = receive.prune(docker, {'c' * 12})
        self.assertEqual(removed, ['f' * 12])
        self.assertEqual(docker.calls[-1], 'prune')

    def test_leaves_no_incoming_files_behind(self):
        self.deploy(COMMIT_A, archive(app_files(COMMIT_A)), FakeDocker(serves=serves_commit_of))
        leftovers = [path.name for path in self.home.iterdir() if path.name.startswith('.incoming-')]
        self.assertEqual(leftovers, [])


if __name__ == '__main__':
    unittest.main()
