import io
import json
import os
import pathlib
import tarfile
import tempfile
import unittest
from unittest import mock
import importlib.util

import receive

COMMIT_A = 'a' * 40
COMMIT_B = 'b' * 40


def archive(files, extra=None):
    """A gzipped tar of `dist/<name>` entries, plus optional raw TarInfo members."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for info in extra or []:
            tar.addfile(info)
    return io.BytesIO(buffer.getvalue())


def site_files(commit, body=b'<h1>hi</h1>'):
    return {'dist/index.html': body,
            'dist/release.json': json.dumps({'commit': commit}).encode(),
            'dist/media/a/clip.webm': b'\x1a\x45\xdf\xa3'}


@unittest.skipUnless(importlib.util.find_spec('fcntl'), 'receiver needs Linux (fcntl, symlinks); CI runs these on ubuntu')
class ReceiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.site = pathlib.Path(self.tmp.name) / 'site'
        self.site.mkdir()
        self.checked = []

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, release):
        self.checked.append(release.name)

    def deploy(self, commit, stream, check=None):
        return receive.deploy(commit, stream, site=self.site, check=check or self.check)

    def live(self):
        return (self.site / 'current' / 'index.html').read_bytes()

    def test_accepts_only_deploy_with_full_commit(self):
        self.assertEqual(receive.requested_commit({'SSH_ORIGINAL_COMMAND': f'deploy {COMMIT_A}'}, []), COMMIT_A)
        for command in ('', 'sh', f'deploy {COMMIT_A[:12]}', f'deploy {COMMIT_A}; sh', f'deploy {COMMIT_A.upper()}'):
            with self.assertRaises(receive.Rejected):
                receive.requested_commit({'SSH_ORIGINAL_COMMAND': command}, [])

    def test_publishes_release_through_relative_current_symlink(self):
        receipt = self.deploy(COMMIT_A, archive(site_files(COMMIT_A)))
        self.assertEqual(receipt['release'], COMMIT_A[:12])
        self.assertEqual(os.readlink(self.site / 'current'), f'releases/{COMMIT_A[:12]}')
        self.assertEqual(self.live(), b'<h1>hi</h1>')
        self.assertTrue((self.site / 'current' / 'media' / 'a' / 'clip.webm').is_file())
        self.assertEqual(self.checked, [COMMIT_A[:12]])

    def test_new_release_replaces_live_one(self):
        self.deploy(COMMIT_A, archive(site_files(COMMIT_A, b'old')))
        receipt = self.deploy(COMMIT_B, archive(site_files(COMMIT_B, b'new')))
        self.assertEqual(receipt['previous'], COMMIT_A[:12])
        self.assertEqual(self.live(), b'new')

    def test_failed_check_rolls_back_to_previous_release(self):
        self.deploy(COMMIT_A, archive(site_files(COMMIT_A, b'old')))

        def broken(release):
            raise RuntimeError('not served')

        with self.assertRaises(RuntimeError):
            self.deploy(COMMIT_B, archive(site_files(COMMIT_B, b'new')), check=broken)
        self.assertEqual(self.live(), b'old')

    def test_rerun_of_live_commit_leaves_it_untouched(self):
        self.deploy(COMMIT_A, archive(site_files(COMMIT_A, b'old')))
        receipt = self.deploy(COMMIT_A, archive(site_files(COMMIT_A, b'changed')))
        self.assertTrue(receipt['unchanged'])
        self.assertEqual(self.live(), b'old')

    def test_rejects_manifest_for_another_commit(self):
        with self.assertRaises(receive.Rejected):
            self.deploy(COMMIT_A, archive(site_files(COMMIT_B)))
        self.assertFalse((self.site / 'current').exists())

    def test_rejects_release_without_index(self):
        files = site_files(COMMIT_A)
        del files['dist/index.html']
        with self.assertRaises(receive.Rejected):
            self.deploy(COMMIT_A, archive(files))

    def test_rejects_entries_outside_dist_and_links(self):
        link = tarfile.TarInfo('dist/escape')
        link.type = tarfile.SYMTYPE
        link.linkname = '/etc/passwd'
        hostile = [
            archive({**site_files(COMMIT_A), 'compose.yaml': b'services: {}'}),
            archive({**site_files(COMMIT_A), 'dist/../../evil': b'x'}),
            archive(site_files(COMMIT_A), extra=[link]),
        ]
        for stream in hostile:
            with self.assertRaises(receive.Rejected):
                self.deploy(COMMIT_A, stream)
        self.assertFalse((self.site / 'current').exists())

    def test_rejects_empty_and_oversized_uploads(self):
        with self.assertRaises(receive.Rejected):
            self.deploy(COMMIT_A, io.BytesIO())
        with mock.patch.object(receive, 'MAX_ARCHIVE', 16), self.assertRaises(receive.Rejected):
            self.deploy(COMMIT_A, archive(site_files(COMMIT_A)))

    def test_keeps_only_recent_releases_and_the_live_one(self):
        commits = [c * 40 for c in 'abcde']
        for commit in commits:
            self.deploy(commit, archive(site_files(commit)))
            # mtime orders releases; make each newer than the last regardless of clock resolution.
            os.utime(self.site / 'releases' / commit[:12], (len(self.checked), len(self.checked)))
        kept = sorted(path.name for path in (self.site / 'releases').iterdir() if not path.name.startswith('.'))
        self.assertEqual(kept, [c[:12] for c in commits[-receive.KEEP_RELEASES:]])


if __name__ == '__main__':
    unittest.main()
