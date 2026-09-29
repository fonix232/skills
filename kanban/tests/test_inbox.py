"""Regression checks for actual HTTP delivery, fresh comparisons and durable state."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('serve', Path(__file__).resolve().parents[1] / 'scripts/serve.py')
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class InboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.board = self.root / 'board'
        self.view = self.root / 'view'
        self.board.mkdir(); self.view.mkdir()
        (self.board / 'board.yml').write_text('name: Demo\nkey: DEMO\ncolumns: [todo]\n')
        (self.board / 'todo').mkdir()
        (self.board / 'todo/001-first.md').write_text('---\nid: 1\ntitle: First\n---\n\nBefore\n')
        self.server = serve.DashboardServer(('127.0.0.1', 0), self.view, self.board)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.tmp.cleanup()

    def request(self, path, data=None, headers=None):
        req = Request(self.url + path, data=json.dumps(data).encode() if data is not None else None,
                      headers=headers or ({'Content-Type': 'application/json'} if data is not None else {}))
        try:
            with urlopen(req, timeout=5) as response:
                return json.load(response)
        except HTTPError as error:
            error.close()
            raise

    def change(self, event_id='one', body='After'):
        path = 'todo/001-first.md'
        return {'id': event_id, 'op': 'save', 'card': 1, 'base': self.server.inbox.state()['version'],
                'title': 'First', 'body': body, 'fields': {}, 'requires': [],
                'before': {path: (self.board / path).read_text()}, 'writes': {path: body}, 'deletes': []}

    def test_large_post_retry_and_restart(self):
        event = self.change(body='x' * 30000)
        self.assertEqual(self.request('/api/changes', event), {'queued': 'one'})
        self.request('/api/changes', event)
        self.assertEqual(len(self.request('/api/changes')), 1)
        reopened = serve.Inbox(self.view, self.board)
        self.assertEqual(reopened.pending(), [event])
        self.assertIn('Before', (self.board / 'todo/001-first.md').read_text())

    def test_fresh_disk_preflight_and_recovery(self):
        event = self.change()
        self.request('/api/changes', event)
        self.assertTrue(self.request('/api/check-change', {'id': 'one'})['paths_match'])
        (self.board / 'todo/001-first.md').write_text('Concurrent change')
        check = self.request('/api/check-change', {'id': 'one'})
        self.assertFalse(check['base_is_current']); self.assertFalse(check['paths_match'])
        self.assertFalse(check['already_written'])
        (self.board / 'todo/001-first.md').write_text('After')
        self.assertTrue(self.request('/api/check-change', {'id': 'one'})['already_written'])

    def test_acknowledgement_preserves_new_arrivals_and_content_version(self):
        version = self.server.inbox.state()['version']
        self.request('/api/changes', self.change('one'))
        self.request('/api/changes', self.change('two'))
        self.request('/api/applied', {'ids': ['one']})
        self.assertEqual([c['id'] for c in self.request('/api/changes')], ['two'])
        state = self.server.inbox.state()
        self.assertEqual(state['version'], version)
        self.assertEqual(state['applied'], ['one'])
        self.assertEqual(serve.Inbox(self.view, self.board).state()['applied'], ['one'])

    def test_parallel_id_reservations_survive_restart_and_read_new_cards(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(lambda n: self.request('/api/reserve-id', {'id': f'tab-{n}'})['card'], range(12)))
        self.assertEqual(len(set(ids)), 12)
        reopened = serve.Inbox(self.view, self.board)
        self.assertEqual(reopened.reserve('tab-0'), ids[0])
        (self.board / 'todo/100-manual.md').write_text('---\nid: 100\ntitle: Manual\n---\n')
        self.assertEqual(reopened.reserve('next'), 101)

    def test_deleted_historical_ticket_is_not_reused(self):
        def git(*args):
            subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)
        git('init')
        old = self.board / 'todo/050-deleted.md'
        old.write_text('---\nid: 50\ntitle: Old\n---\n')
        git('add', 'board')
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial board')
        git('rm', 'board/todo/050-deleted.md')
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Delete old card')
        self.assertEqual(self.request('/api/reserve-id', {'id': 'after-delete'})['card'], 51)

    def test_dependencies_and_invalid_ack_roll_back(self):
        first = self.change('one'); second = self.change('two'); second['requires'] = ['one']
        with self.assertRaises(HTTPError): self.request('/api/changes', second)
        self.request('/api/changes', first); self.request('/api/changes', second)
        self.assertEqual(self.request('/api/check-change', {'id': 'two'})['blocked_by'], ['one'])
        with self.assertRaises(HTTPError): self.request('/api/applied', {'ids': ['one', 'unknown']})
        self.assertEqual(self.server.inbox.state()['applied'], [])

    def test_reject_bad_paths_mismatched_retry_and_unreserved_create(self):
        event = self.change(); event['writes'] = {'../escape.md': 'x'}; event['before'] = {'../escape.md': None}
        with self.assertRaises(HTTPError): self.request('/api/changes', event)
        event = self.change(); self.request('/api/changes', event)
        event['body'] = 'Different retry'
        with self.assertRaises(HTTPError): self.request('/api/changes', event)
        event = self.change('new'); event['op'] = 'create'; event['card'] = 2
        with self.assertRaises(HTTPError): self.request('/api/changes', event)
        self.assertEqual(self.request('/api/reserve-id', {'id': 'new'})['card'], 2)
        self.request('/api/changes', event)

    def test_state_reads_latest_disk_and_inbox_is_not_static(self):
        (self.board / 'todo/001-first.md').write_text('Updated externally')
        with urlopen(self.url + '/data.js') as response:
            self.assertIn('Updated externally', response.read().decode())
        with self.assertRaises(HTTPError) as error: self.request('/inbox.sqlite3')
        self.assertEqual(error.exception.code, 404)

    def test_board_settings_event_uses_original_snapshot(self):
        before = (self.board / 'board.yml').read_text()
        event = {'id': 'config-one', 'op': 'config', 'board': {'name': 'New name'},
                 'base': self.server.inbox.state()['version'], 'requires': [],
                 'before': {'board.yml': before}, 'writes': {'board.yml': 'name: New name\n'}, 'deletes': []}
        self.request('/api/changes', event)
        self.assertTrue(self.request('/api/check-change', {'id': 'config-one'})['paths_match'])
        (self.board / 'board.yml').write_text(before + 'template: An incoming template\n')
        self.assertFalse(self.request('/api/check-change', {'id': 'config-one'})['paths_match'])

    def test_cross_origin_write_is_rejected(self):
        with self.assertRaises(HTTPError) as error:
            self.request('/api/changes', self.change(), {'Content-Type': 'application/json', 'Origin': 'https://example.com'})
        self.assertEqual(error.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
