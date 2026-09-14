#!/usr/bin/env python3
"""Read subscription quotas without exposing credentials to GNOME Shell."""

import argparse
import json
import math
import os
from pathlib import Path
import selectors
import signal
import shlex
import shutil
import subprocess
import sys
import tempfile
import time


def cache_path():
    return Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'lidgets' / 'claude-usage.json'


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.lidgets-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def window(used, reset, minutes):
    if (isinstance(used, bool) or not isinstance(used, (float, int))
            or not math.isfinite(used) or used < 0
            or isinstance(minutes, bool) or not isinstance(minutes, (float, int))
            or not math.isfinite(minutes) or minutes <= 0):
        return None
    reset = reset if isinstance(reset, (float, int)) and math.isfinite(reset) and reset > 0 else None
    return {'remaining': max(0, 100 - used), 'resetsAt': reset, 'minutes': minutes}


def claude_snapshot(data):
    limits = data.get('rate_limits') or {}
    windows = []
    for key, minutes in [('five_hour', 300), ('seven_day', 10080)]:
        item = limits.get(key) or {}
        parsed = window(item.get('used_percentage'), item.get('resets_at'), minutes)
        if parsed:
            windows.append(parsed)
    return {'windows': windows, 'updatedAt': time.time()}


def codex_snapshot():
    # Desktop sessions often lack ~/.local/bin in PATH.
    executable = shutil.which('codex')
    if not executable:
        candidate = Path.home() / '.local/bin/codex'
        executable = str(candidate) if candidate.is_file() else None
    if not executable:
        return {'error': 'codex-missing'}
    process = subprocess.Popen([executable, 'app-server'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffer = b''
    deadline = time.monotonic() + 15

    def send(message):
        process.stdin.write(json.dumps(message).encode() + b'\n')
        process.stdin.flush()

    def response(request_id):
        nonlocal buffer
        while time.monotonic() < deadline:
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                message = json.loads(line)
                if message.get('id') == request_id:
                    if 'error' in message:
                        raise ValueError('request failed')
                    return message['result']
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            buffer += chunk
            if len(buffer) > 1024 * 1024:
                raise ValueError('response too large')
        raise TimeoutError('Codex did not respond')

    try:
        send({'id': 1, 'method': 'initialize', 'params': {
            'clientInfo': {'name': 'lidgets', 'version': '1.0.0'},
            'capabilities': {}}})
        response(1)
        send({'method': 'initialized'})
        send({'id': 2, 'method': 'account/rateLimits/read'})
        result = response(2)
        limits = (result.get('rateLimitsByLimitId') or {}).get('codex') or result.get('rateLimits') or {}
        windows = []
        for name in ['primary', 'secondary']:
            item = limits.get(name) or {}
            parsed = window(item.get('usedPercent'), item.get('resetsAt'), item.get('windowDurationMins'))
            if parsed:
                windows.append(parsed)
        return {'windows': windows, 'updatedAt': time.time()}
    finally:
        selector.close()
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()


def configure_claude(remove=False):
    directory = Path(os.environ.get('CLAUDE_CONFIG_DIR', Path.home() / '.claude'))
    path = directory / 'settings.json'
    settings = json.loads(path.read_text()) if path.exists() else {}
    status = settings.get('statusLine') or {}
    if status and status.get('type') != 'command':
        raise ValueError('unsupported status line')
    original = status.get('command', '')
    args = shlex.split(original)
    ours = len(args) >= 3 and Path(args[1]).name == 'usage-helper.py' and args[2] == 'claude-statusline'
    if ours:
        original = args[args.index('--original') + 1] if '--original' in args else ''
    if remove:
        if not ours:
            return
        if original:
            settings['statusLine'] = {**status, 'command': original}
        else:
            settings.pop('statusLine', None)
    else:
        command = [sys.executable, str(Path(__file__).resolve()), 'claude-statusline']
        if original:
            command += ['--original', original]
        settings['statusLine'] = {**status, 'type': 'command', 'command': shlex.join(command)}
    atomic_json(path, settings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['codex', 'claude', 'claude-statusline', 'install-claude', 'remove-claude'])
    parser.add_argument('--original', default='')
    args = parser.parse_args()
    if args.action == 'claude-statusline':
        raw = sys.stdin.read()
        try:
            # Write empty snapshots too: never retain another account's old limits.
            atomic_json(cache_path(), claude_snapshot(json.loads(raw)))
        except (OSError, ValueError, TypeError, AttributeError):
            pass  # A widget must never break the user's terminal status line.
        if args.original:
            subprocess.run(args.original, input=raw, text=True, shell=True, check=False)
        return
    try:
        if args.action in ('install-claude', 'remove-claude'):
            configure_claude(args.action == 'remove-claude')
            result = {'ok': True}
        elif args.action == 'claude':
            result = json.loads(cache_path().read_text()) if cache_path().exists() else {'error': 'claude-setup'}
        else:
            result = codex_snapshot()
    except (OSError, ValueError, TypeError, KeyError, AttributeError, TimeoutError):
        result = {'error': 'unavailable'}
    print(json.dumps(result))
    return 1 if 'error' in result else 0


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    sys.exit(main())
