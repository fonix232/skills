"""Regression checks for actual HTTP delivery, fresh comparisons and durable state."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import tempfile
import sqlite3
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

    def test_attachments_serve_images_and_nothing_else(self):
        folder = self.board / 'attachments' / 'DEMO-1'
        folder.mkdir(parents=True)
        (folder / 'plan one.png').write_bytes(b'\x89PNG\r\n\x1a\nfake')
        (folder / 'notes.md').write_text('not an image')
        with urlopen(self.url + '/attachments/DEMO-1/plan%20one.png', timeout=5) as response:
            self.assertEqual(response.headers['Content-Type'], 'image/png')
            self.assertEqual(response.read(), b'\x89PNG\r\n\x1a\nfake')
        for path in ('/attachments/DEMO-1/notes.md', '/attachments/DEMO-1/../../board.yml', '/attachments/%2e%2e/board.yml',
                     '/attachments/DEMO-1/missing.png', '/board.yml', '/todo/001-first.md'):
            with self.subTest(path=path), self.assertRaises(HTTPError) as caught:
                urlopen(self.url + path, timeout=5)
            self.assertEqual(caught.exception.code, 404)
            caught.exception.close()

    def test_resolution_status_persists_and_acknowledgement_removes_it(self):
        self.request('/api/changes', self.change())
        version = self.server.inbox.state()['version']
        self.request('/api/change-status', {'id': 'one', 'reason': 'Choose which title to keep'})
        reopened = serve.Inbox(self.view, self.board)
        state = reopened.state()
        self.assertEqual(state['version'], version)
        self.assertEqual(state['queue'][0]['status'], 'Needs resolution')
        self.assertEqual(state['queue'][0]['reason'], 'Choose which title to keep')
        self.request('/api/change-status', {'id': 'one', 'reason': ''})
        self.assertEqual(reopened.state()['queue'][0]['status'], 'Queued for agent')
        self.request('/api/applied', {'ids': ['one']})
        self.assertEqual(reopened.state()['queue'], [])
        with self.assertRaises(HTTPError):
            self.request('/api/change-status', {'id': 'one', 'reason': 'Too late'})

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

    def first_use(self, view, callers=8):
        """Open a fresh inbox from several callers at once; return their numbers and errors."""
        gate = threading.Barrier(callers)
        def call(n):
            gate.wait()
            return serve.Inbox(view, self.board).reserve(f'first-use-{n}')
        with ThreadPoolExecutor(max_workers=callers) as pool:
            futures = [pool.submit(call, n) for n in range(callers)]
        errors = [repr(f.exception()) for f in futures if f.exception()]
        return sorted(f.result() for f in futures if not f.exception()), errors

    def test_concurrent_first_use_of_a_fresh_inbox(self):
        for trial in range(20):
            view = self.root / f'fresh-{trial}'
            view.mkdir()
            numbers, errors = self.first_use(view)
            self.assertEqual(errors, [])
            self.assertEqual(numbers, list(range(2, 10)))  # the board's card 1 is taken

    def test_concurrent_first_use_migrates_an_old_inbox_once(self):
        for trial in range(20):
            view = self.root / f'old-{trial}'
            view.mkdir()
            with sqlite3.connect(view / 'inbox.sqlite3') as db:  # the schema before `reason`
                db.execute('CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0)')
                db.execute('CREATE TABLE reservations (id TEXT PRIMARY KEY, card INTEGER UNIQUE NOT NULL)')
            numbers, errors = self.first_use(view)
            self.assertEqual(errors, [])
            self.assertEqual(numbers, list(range(2, 10)))
            with sqlite3.connect(view / 'inbox.sqlite3') as db:
                self.assertIn('reason', {row[1] for row in db.execute('PRAGMA table_info(changes)')})

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

    def other(self, event_id, body='Other'):
        path = 'todo/002-second.md'
        (self.board / path).write_text('---\nid: 2\ntitle: Second\n---\n') if not (self.board / path).exists() else None
        return {**self.change(event_id), 'card': 2, 'before': {path: (self.board / path).read_text()},
                'writes': {path: body}}

    def test_cancel_withdraws_a_change_and_later_ones_on_its_files(self):
        first = self.change('one'); second = self.other('two'); second['requires'] = ['one']
        third = self.change('three', body='Again'); third['requires'] = ['one', 'two']
        for event in (first, second, third):
            self.request('/api/changes', event)
        plan = self.request('/api/cancel', {'ids': ['one'], 'dry_run': True})
        self.assertEqual(plan['cancelled'], ['one', 'three'])
        self.assertEqual(plan['paths'], ['todo/001-first.md'])
        self.assertEqual(len(self.request('/api/changes')), 3, 'a dry run changes nothing')
        self.assertEqual(self.request('/api/cancel', {'ids': ['one']})['cancelled'], ['one', 'three'])
        pending = self.request('/api/changes')
        self.assertEqual([e['id'] for e in pending], ['two'])
        self.assertEqual(pending[0]['requires'], [], 'a cancelled prerequisite is no longer required')
        self.assertEqual(self.request('/api/check-change', {'id': 'two'})['blocked_by'], [])
        self.assertEqual(self.request('/api/check-change', {'id': 'one'}), {'cancelled': True})
        state = serve.Inbox(self.view, self.board).state()
        self.assertEqual([q['id'] for q in state['queue']], ['two'])
        self.assertEqual(state['cancelled'], ['one', 'three'])
        self.request('/api/changes', first)
        self.assertEqual([e['id'] for e in self.request('/api/changes')], ['two'], 'a retry stays cancelled')
        with self.assertRaises(HTTPError): self.request('/api/applied', {'ids': ['two', 'one']})
        self.assertEqual(self.server.inbox.state()['applied'], [], 'acknowledging a cancelled change rolls back')
        with self.assertRaises(HTTPError): self.request('/api/change-status', {'id': 'one', 'reason': 'x'})
        self.assertIn('Before', (self.board / 'todo/001-first.md').read_text(), 'the server never writes the board')

    def test_cancel_refuses_applied_changes_and_tombstones_unseen_ones(self):
        self.request('/api/changes', self.change('one'))
        self.request('/api/applied', {'ids': ['one']})
        with self.assertRaises(HTTPError): self.request('/api/cancel', {'ids': ['one']})
        self.assertEqual(self.request('/api/cancel', {'ids': ['late']})['cancelled'], ['late'])
        self.request('/api/changes', self.change('late'))
        self.assertEqual(self.request('/api/changes'), [], 'a delivery that arrives after its cancel stays out')
        with self.assertRaises(HTTPError): self.request('/api/cancel', {'ids': []})
        with self.assertRaises(HTTPError): self.request('/api/cancel', {'ids': ['../x']})

    def test_an_old_inbox_gains_cancellation(self):
        event = self.change('old')
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        db = self.view / 'inbox.sqlite3'
        db.unlink()
        with sqlite3.connect(db) as conn:
            conn.execute('CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0)')
            conn.execute('INSERT INTO changes (id, payload) VALUES (?, ?)', ('old', json.dumps(event)))
        conn.close()
        self.server = serve.DashboardServer(('127.0.0.1', 0), self.view, self.board)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.assertEqual(self.request('/api/cancel', {'ids': ['old']})['cancelled'], ['old'])
        self.assertEqual(self.server.inbox.state()['queue'], [])

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
