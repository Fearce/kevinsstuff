"""Install or update the guildpolls host with the owner's SSH key.

    python deploy/install.py               # compose file, Dockerfile and receiver, from the committed HEAD
    python deploy/install.py --rotate-key  # also issue a new CI deploy key and store it as repo secrets

Set GUILDPOLLS_POLL_PASSWORD in the environment to write (or change) the poll-creation password on the host;
without it the host keeps the password it has. The password lives only in ~/guildpolls/.env on the host.
CI never ships these files: its key is bound to deploy/receive.py, which accepts application files only.
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
HOST = 'deploy@77.42.40.176'
HOME = '/home/deploy/guildpolls'
KEY_COMMENT = 'guildpolls-ci-deploy'
INFRA = {'compose.yaml': 'compose.yaml', 'Dockerfile': 'Dockerfile', '.dockerignore': '.dockerignore',
         'deploy/receive.py': 'deploy/receive.py'}
SECRET_PREFIX = 'GUILDPOLLS_DEPLOY_'
PASSWORD_VARIABLE = 'GUILDPOLLS_POLL_PASSWORD'

# Recreates the container only once a release image exists; the first one arrives from CI.
APPLY_INFRA = f'''set -eu
mkdir -p {HOME}/deploy
cd {HOME}
staged=$(mktemp -d {HOME}/.staged-XXXXXX)
trap 'rm -rf "$staged"' EXIT
tar -x -C "$staged"
if [ -f "$staged/.env" ]; then (umask 077 && cp "$staged/.env" .env.next && mv .env.next .env); fi
[ -f .env ] || {{ echo "no .env on the host yet: set {PASSWORD_VARIABLE} and run again" >&2; exit 1; }}
chmod 600 .env
for file in compose.yaml Dockerfile .dockerignore deploy/receive.py; do cp "$staged/$file" "$file"; chmod 644 "$file"; done
docker compose -p guildpolls config --quiet
if docker image inspect guildpolls:live >/dev/null 2>&1; then
  docker compose -p guildpolls up -d --wait --wait-timeout 90
  docker exec guildpolls wget -q -O - http://127.0.0.1:8080/api/health
else
  echo "infra installed; the first release arrives with the next CI deploy"
fi
'''

# Replaces this app's key line only if authorized_keys did not change while we edited it.
SWAP_KEY = r'''
import hashlib, json, os, pathlib, sys
request = json.loads(sys.stdin.read())
path = pathlib.Path.home() / '.ssh' / 'authorized_keys'
before = path.read_bytes()
lines = [line for line in before.decode().splitlines() if not line.endswith(' ' + request['comment'])]
lines.append(request['line'])
staged = path.with_name('authorized_keys.guildpolls')
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
    return run(['git', 'show', f'HEAD:./{path}']).stdout


def add_file(tar, name, data, mode=0o644):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    tar.addfile(info, io.BytesIO(data))


def password_env():
    password = os.environ.get(PASSWORD_VARIABLE)
    if password is None:
        return None
    if not password.strip() or any(char in password for char in '\r\n"\'$'):
        sys.exit(f'{PASSWORD_VARIABLE} must be a single line without quotes or $')
    return f'{PASSWORD_VARIABLE}={password}\n'.encode()


def infra_archive():
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as tar:
        for source, target in INFRA.items():
            add_file(tar, target, committed(source))
        env = password_env()
        if env:
            add_file(tar, '.env', env, 0o600)
    return buffer.getvalue()


def install_infra(owner_key):
    result = ssh(owner_key, APPLY_INFRA, infra_archive())
    print(result.stdout.decode().strip() or 'infra installed')


def new_key(directory):
    key = pathlib.Path(directory) / 'deploy_key'
    run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', KEY_COMMENT, '-f', str(key)])
    return key


def quote(text):
    return "'" + text.replace("'", "'\"'\"'") + "'"


def authorize(owner_key, public_key):
    line = f'restrict,command="/usr/bin/python3 -I {HOME}/deploy/receive.py" {public_key}'
    request = json.dumps({'comment': KEY_COMMENT, 'line': line}).encode()
    print(ssh(owner_key, f"python3 -c {quote(SWAP_KEY)}", request).stdout.decode().strip())


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
    set_secret('KNOWN_HOSTS', known_hosts_line(owner_key))


def known_hosts_line(owner_key):
    # Read over the owner's authenticated session; Windows' bundled ssh-keyscan cannot negotiate this host's KEX.
    key_type, key = ssh(owner_key, 'cat /etc/ssh/ssh_host_ed25519_key.pub').stdout.decode().split()[:2]
    return f'{HOST.split("@")[1]} {key_type} {key}\n'.encode()


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
