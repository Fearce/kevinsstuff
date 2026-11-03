"""Install or update the kevinsstuff.com host with the owner's SSH key.

    python deploy/install.py               # container definition + receiver, from the committed HEAD
    python deploy/install.py --rotate-key  # also issue a new CI deploy key and store it as repo secrets

CI never ships these files: its key is bound to deploy/receive.py, which accepts site files only.
Files are read with `git show HEAD:<path>` so a Windows checkout's CRLF never reaches the host.
"""
import argparse
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile

REPO = 'Fearce/kevinsstuff'
HOST = 'deploy@kevinsstuff.com'
HOME = '/home/deploy/kevinsstuff'
KEY_COMMENT = 'kevinsstuff-ci-deploy'
INFRA = {'deploy/compose.yaml': 'compose.yaml', 'deploy/nginx.conf': 'nginx.conf',
         'deploy/receive.py': 'deploy/receive.py'}
SECRET_PREFIX = 'KEVINSSTUFF_DEPLOY_'

# Validates nginx.conf in a throwaway container before the live one is recreated with it.
APPLY_INFRA = f'''set -eu
mkdir -p {HOME}/site/releases {HOME}/deploy
cd {HOME}
staged=$(mktemp -d {HOME}/.staged-XXXXXX)
trap 'rm -rf "$staged"' EXIT
tar -x -C "$staged"
docker run --rm --network none -v "$staged/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.28-alpine nginx -t -q
cp "$staged/compose.yaml" compose.yaml
cp "$staged/nginx.conf" nginx.conf
cp "$staged/deploy/receive.py" deploy/receive.py
chmod 644 compose.yaml nginx.conf deploy/receive.py
docker compose -p kevinsstuff up -d --force-recreate --wait --wait-timeout 60
docker exec kevinsstuff-web wget -q -O - http://127.0.0.1:8080/healthz
'''

# Replaces this repo's key line only if authorized_keys did not change while we edited it.
SWAP_KEY = r'''
import hashlib, json, os, pathlib, sys
request = json.loads(sys.stdin.read())
path = pathlib.Path.home() / '.ssh' / 'authorized_keys'
before = path.read_bytes()
lines = [line for line in before.decode().splitlines() if not line.endswith(' ' + request['comment'])]
lines.append(request['line'])
staged = path.with_name('authorized_keys.kevinsstuff')
staged.write_text('\n'.join(lines) + '\n')
staged.chmod(0o600)
if hashlib.sha256(path.read_bytes()).digest() != hashlib.sha256(before).digest():
    staged.unlink()
    sys.exit('authorized_keys changed during the edit; run the installer again')
os.replace(staged, path)
print('authorized_keys updated')
'''


def run(argv, data=None, check=True):
    result = subprocess.run(argv, input=data, capture_output=True,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if check and result.returncode:
        sys.exit(f'{argv[0]} failed ({result.returncode}): {result.stderr.decode(errors="replace").strip()}')
    return result


def ssh(owner_key, command, data=None, check=True):
    return run(['ssh', '-i', owner_key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                '-o', 'StrictHostKeyChecking=accept-new', HOST, command], data, check)


def committed(path):
    return run(['git', 'show', f'HEAD:{path}']).stdout


def infra_archive():
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as tar:
        for source, target in INFRA.items():
            data = committed(source)
            info = tarfile.TarInfo(target)
            info.size = len(data)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def install_infra(owner_key):
    result = ssh(owner_key, APPLY_INFRA, infra_archive())
    print(result.stdout.decode().strip() or 'infra installed')


def new_key(directory):
    key = pathlib.Path(directory) / 'deploy_key'
    run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', KEY_COMMENT, '-f', str(key)])
    return key


def authorize(owner_key, public_key):
    line = f'restrict,command="/usr/bin/python3 -I {HOME}/deploy/receive.py" {public_key}'
    request = json.dumps({'comment': KEY_COMMENT, 'line': line}).encode()
    print(ssh(owner_key, f"python3 -c {quote(SWAP_KEY)}", request).stdout.decode().strip())


def quote(text):
    return "'" + text.replace("'", "'\"'\"'") + "'"


def probe_confined(key):
    """The new key must reach the receiver and nothing else."""
    result = run(['ssh', '-i', str(key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', HOST, 'id'],
                 check=False)
    if result.returncode != 2 or b'Rejected' not in result.stderr:
        sys.exit(f'Deploy key is not confined to the receiver: exit {result.returncode}, '
                 f'{result.stdout!r} {result.stderr!r}')
    print('deploy key is confined to the receiver')


def set_secret(name, value):
    run(['gh', 'secret', 'set', SECRET_PREFIX + name, '--repo', REPO], value)
    print(f'secret {SECRET_PREFIX}{name} set')


def rotate_key(owner_key):
    with tempfile.TemporaryDirectory() as directory:
        key = new_key(directory)
        authorize(owner_key, key.with_suffix('.pub').read_text().strip())
        probe_confined(key)
        # OpenSSH on the Linux runner rejects a key carrying Windows line endings.
        set_secret('SSH_KEY', key.read_bytes().replace(b'\r\n', b'\n'))
    set_secret('TARGET', HOST.encode())
    known = run(['ssh-keyscan', '-t', 'ed25519', HOST.split('@')[1]]).stdout.replace(b'\r\n', b'\n')
    set_secret('KNOWN_HOSTS', known)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--owner-key', default=str(pathlib.Path.home() / '.ssh' / 'sprogbroen_ci'))
    parser.add_argument('--rotate-key', action='store_true')
    args = parser.parse_args()
    os.chdir(pathlib.Path(__file__).resolve().parent.parent)
    install_infra(args.owner_key)
    if args.rotate_key:
        rotate_key(args.owner_key)


if __name__ == '__main__':
    main()
