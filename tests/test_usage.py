import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


HELPER = Path(__file__).resolve().parents[1] / 'lidgets@neonshard.com/lib/usage-helper.py'
spec = importlib.util.spec_from_file_location('usage_helper', HELPER)
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)


class UsageTests(unittest.TestCase):
    def test_windows_and_invalid_values(self):
        result = usage.claude_snapshot({'rate_limits': {
            'five_hour': {'used_percentage': 28, 'resets_at': 2000000000},
            'seven_day': {'used_percentage': 101}}})
        self.assertEqual([w['remaining'] for w in result['windows']], [72, 0])
        self.assertEqual([w['minutes'] for w in result['windows']], [300, 10080])
        self.assertIsNone(usage.window(None, None, 300))
        self.assertIsNone(usage.window(float('nan'), None, 300))
        self.assertIsNone(usage.window(True, None, 300))
        self.assertIsNone(usage.window(25, None, float('nan')))
        self.assertEqual(usage.claude_snapshot({})['windows'], [])

    def test_connection_preserves_command_and_settings(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': directory}):
            path = Path(directory) / 'settings.json'
            before = {'model': 'existing-model', 'statusLine': {
                'type': 'command', 'command': "printf 'original output'", 'padding': 2}}
            path.write_text(json.dumps(before))
            usage.configure_claude()
            first = json.loads(path.read_text())
            usage.configure_claude()
            self.assertEqual(json.loads(path.read_text()), first)
            self.assertEqual(first['model'], before['model'])
            self.assertEqual(first['statusLine']['padding'], 2)
            env = {**os.environ, 'XDG_CACHE_HOME': directory}
            result = subprocess.run(first['statusLine']['command'], shell=True, text=True,
                                    input=json.dumps({'rate_limits': {'five_hour': {'used_percentage': 40}},
                                                      'secret_test_field': 'must not be cached'}),
                                    capture_output=True, env=env, check=True)
            self.assertEqual(result.stdout, 'original output')
            cache = Path(directory) / 'lidgets/claude-usage.json'
            self.assertEqual(json.loads(cache.read_text())['windows'][0]['remaining'], 60)
            self.assertNotIn('secret_test_field', cache.read_text())
            self.assertEqual(cache.stat().st_mode & 0o777, 0o600)
            updated_at = json.loads(cache.read_text())['updatedAt']
            subprocess.run(first['statusLine']['command'], shell=True, text=True,
                           input='{}', capture_output=True, env=env, check=True)
            cached = json.loads(cache.read_text())
            self.assertEqual(cached['windows'][0]['remaining'], 60)
            self.assertEqual(cached['updatedAt'], updated_at)
            self.assertTrue(cached['incomplete'])
            subprocess.run(first['statusLine']['command'], shell=True, text=True,
                           input='{"rate_limits": {}}', capture_output=True, env=env, check=True)
            self.assertEqual(json.loads(cache.read_text())['windows'], [])
            usage.configure_claude(remove=True)
            self.assertEqual(json.loads(path.read_text()), before)

    def test_fresh_claude_usage_replaces_incomplete_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'XDG_CACHE_HOME': directory}):
            usage.cache_claude_snapshot({'rate_limits': {
                'five_hour': {'used_percentage': 23},
                'seven_day': {'used_percentage': 25}}})
            usage.cache_claude_snapshot({})
            self.assertTrue(json.loads(usage.cache_path().read_text())['incomplete'])
            usage.cache_claude_snapshot({'rate_limits': {'five_hour': {'used_percentage': 30}}})
            cached = json.loads(usage.cache_path().read_text())
            self.assertNotIn('incomplete', cached)
            self.assertEqual([w['remaining'] for w in cached['windows']], [70])

    def test_invalid_config_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': directory}):
            path = Path(directory) / 'settings.json'
            path.write_text('{broken')
            with self.assertRaises(ValueError):
                usage.configure_claude()
            self.assertEqual(path.read_text(), '{broken')

    def test_new_connection_can_be_removed(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': directory}):
            usage.configure_claude()
            usage.configure_claude(remove=True)
            self.assertEqual(json.loads((Path(directory) / 'settings.json').read_text()), {})

    def test_codex_protocol_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'codex'
            executable.write_text('''#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if request['method'] == 'initialize':
        print(json.dumps({'id': request['id'], 'result': {}}), flush=True)
    elif request['method'] == 'account/rateLimits/read':
        print(json.dumps({'method': 'account/rateLimits/updated', 'params': {}}), flush=True)
        print(json.dumps({'id': request['id'], 'result': {'rateLimits': {
            'primary': {'usedPercent': 25, 'windowDurationMins': 300, 'resetsAt': 2000000000},
            'secondary': None}}}), flush=True)
''')
            executable.chmod(0o700)
            with patch.dict(os.environ, {'PATH': directory + os.pathsep + os.environ['PATH']}):
                snapshot = usage.codex_snapshot()
            self.assertEqual(snapshot['windows'], [
                {'remaining': 75, 'resetsAt': 2000000000, 'minutes': 300}])


if __name__ == '__main__':
    unittest.main()
