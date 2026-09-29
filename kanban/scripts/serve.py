#!/usr/bin/env python3
"""Loopback dashboard and durable change inbox. Never writes the Markdown board."""
import argparse
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sqlite3
import subprocess
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BODY = 8 * 1024 * 1024


def board_files(board):
    files, stats = {}, {}
    for path in sorted(board.rglob('*')):
        if not path.is_file() or path.suffix not in ('.md', '.yml') or path.name == 'README.md':
            continue
        if not path.resolve().is_relative_to(board.resolve()):
            raise ValueError(f'Board file escapes its directory: {path.name}')
        name = path.relative_to(board).as_posix()
        files[name] = path.read_text(encoding='utf-8')
        stat = path.stat()
        stats[name] = {'size': stat.st_size, 'modified': datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()}
    return files, stats


def version_of(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:12]


def historical_ids(board):
    """Card filenames keep their original number, including in deleted history."""
    root = subprocess.run(['git', '-C', str(board), 'rev-parse', '--show-toplevel'],
                          capture_output=True, text=True, timeout=10)
    if root.returncode:
        return []  # A new board may not have a Git repository yet.
    repo = Path(root.stdout.strip()).resolve()
    relative = board.resolve().relative_to(repo).as_posix()
    log = subprocess.run(['git', '-C', str(repo), 'log', '--all', '--format=', '--name-only', '--', relative],
                         capture_output=True, text=True, timeout=15)
    if log.returncode:
        # An unborn repository has no history; other failures must not silently reuse IDs.
        head = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--verify', 'HEAD'], capture_output=True, timeout=10)
        if not head.returncode:
            raise ValueError('Could not check historical ticket numbers')
        return []
    return [int(m.group(1)) for line in log.stdout.splitlines()
            if (m := re.search(r'(?:^|/)([0-9]+)-[^/]*\.md$', line.strip()))]


def valid_path(path):
    return (isinstance(path, str) and path and not path.startswith('/') and '\\' not in path
            and all(p not in ('', '.', '..') for p in path.split('/'))
            and PurePosixPath(path).suffix in ('.md', '.yml'))


class Inbox:
    def __init__(self, view, board):
        self.board = board.resolve()
        self.db = view / 'inbox.sqlite3'
        self.lock = threading.Lock()
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS changes (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                    payload TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, card INTEGER UNIQUE NOT NULL);
            ''')
            columns = {row[1] for row in db.execute('PRAGMA table_info(changes)')}
            if 'reason' not in columns:
                db.execute("ALTER TABLE changes ADD COLUMN reason TEXT NOT NULL DEFAULT ''")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db, timeout=10)
        try:
            db.execute('PRAGMA synchronous=FULL')
            with db:
                yield db
        finally:
            db.close()

    def state(self):
        files, stats = board_files(self.board)
        with self.connect() as db:
            applied = [row[0] for row in db.execute('SELECT id FROM changes WHERE applied = 1 ORDER BY seq')]
            queue = [{'id': row[0], 'summary': json.loads(row[1]).get('summary', 'Board change'),
                      'status': 'Needs resolution' if row[2] else 'Queued for agent', 'reason': row[2]}
                     for row in db.execute('SELECT id, payload, reason FROM changes WHERE applied = 0 ORDER BY seq')]
        return {'queue': queue, 'version': version_of(files), 'boardId': hashlib.sha256(str(self.board).encode()).hexdigest()[:16],
                'files': files, 'stats': stats, 'applied': applied}

    def pending(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT payload FROM changes WHERE applied = 0 ORDER BY seq')]

    def reserve(self, request_id):
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', request_id):
            raise ValueError('Invalid reservation id')
        with self.lock, self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT card FROM reservations WHERE id = ?', (request_id,)).fetchone()
            if existing:
                return existing[0]
            files, _ = board_files(self.board)
            ids = [0]
            for name, text in files.items():
                if not name.endswith('.md') or PurePosixPath(name).name.startswith('_'):
                    continue
                match = re.search(r'^id:\s*[\'\"]?(\d+)[\'\"]?\s*$', text.split('---', 2)[1] if text.startswith('---') else '', re.M)
                if match:
                    ids.append(int(match[1]))
                else:
                    prefix = re.match(r'(\d+)-', PurePosixPath(name).name)
                    if prefix:
                        ids.append(int(prefix[1]))
            ids.extend(historical_ids(self.board))
            ids.extend(row[0] for row in db.execute('SELECT card FROM reservations'))
            card = max(ids) + 1
            db.execute('INSERT INTO reservations VALUES (?, ?)', (request_id, card))
            return card

    def enqueue(self, event):
        if not isinstance(event, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', str(event.get('id', ''))):
            raise ValueError('Invalid change id')
        if event.get('op') not in ('move', 'save', 'create', 'delete', 'task', 'reorder', 'config'):
            raise ValueError('Unknown operation')
        if event['op'] != 'config' and (type(event.get('card')) is not int or event['card'] < 1):
            raise ValueError('Invalid ticket number')
        if not isinstance(event.get('writes'), dict) or not isinstance(event.get('deletes'), list) or not isinstance(event.get('before'), dict):
            raise ValueError('Changes need writes, deletes and before snapshots')
        paths = set(event['writes']) | set(event['deletes'])
        if not paths or set(event['before']) != paths or any(not valid_path(p) for p in paths):
            raise ValueError('Invalid board paths or incomplete before snapshots')
        if any(not isinstance(v, str) for v in event['writes'].values()) or any(v is not None and not isinstance(v, str) for v in event['before'].values()):
            raise ValueError('Board contents must be text')
        if not isinstance(event.get('requires', []), list) or any(not isinstance(v, str) for v in event.get('requires', [])):
            raise ValueError('Invalid change prerequisites')
        payload = json.dumps(event, sort_keys=True)
        with self.lock, self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT payload FROM changes WHERE id = ?', (event['id'],)).fetchone()
            if existing:
                if existing[0] != payload:
                    raise ValueError('A different change already uses this id')
                return
            if event['op'] == 'create':
                reserved = db.execute('SELECT card FROM reservations WHERE id = ?', (event['id'],)).fetchone()
                if not reserved or reserved[0] != event['card']:
                    raise ValueError('Reserve a ticket number before creating the card')
            for dependency in event.get('requires', []):
                if not db.execute('SELECT 1 FROM changes WHERE id = ?', (dependency,)).fetchone():
                    raise ValueError('A previous change has not reached the inbox yet; retry in order')
            db.execute('INSERT INTO changes (id, payload) VALUES (?, ?)', (event['id'], payload))

    def check(self, event_id):
        with self.connect() as db:
            row = db.execute('SELECT payload FROM changes WHERE id = ?', (event_id,)).fetchone()
            if not row:
                raise ValueError('Unknown change id')
            event = json.loads(row[0])
            applied = {r[0] for r in db.execute('SELECT id FROM changes WHERE applied = 1')}
        files, _ = board_files(self.board)
        changed = [path for path, old in event['before'].items() if files.get(path) != old]
        blocked = [i for i in event.get('requires', []) if i not in applied]
        written = all(files.get(p) == text for p, text in event['writes'].items()) and all(p not in files for p in event['deletes'])
        return {'base_is_current': version_of(files) == event.get('base'),
                'paths_match': not changed and not blocked, 'changed_paths': changed,
                'blocked_by': blocked, 'already_written': written and not blocked}

    def report(self, event_id, reason):
        if not isinstance(reason, str) or len(reason) > 2000:
            raise ValueError('A resolution reason must be text of at most 2000 characters')
        with self.lock, self.connect() as db:
            result = db.execute('UPDATE changes SET reason = ? WHERE id = ? AND applied = 0', (reason, event_id))
            if not result.rowcount:
                raise ValueError('Unknown or already applied change')

    def acknowledge(self, ids):
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise ValueError('Expected a list of applied change ids')
        with self.lock, self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for event_id in ids:
                if not db.execute('SELECT 1 FROM changes WHERE id = ?', (event_id,)).fetchone():
                    raise ValueError('Unknown change id')
                db.execute('UPDATE changes SET applied = 1 WHERE id = ?', (event_id,))


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128
    def __init__(self, address, view, board):
        self.view, self.board = view.resolve(), board.resolve()
        self.inbox = Inbox(self.view, self.board)
        super().__init__(address, Handler)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(args[2].view), **kwargs)

    def json_response(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if path == '/api/health':
                return self.json_response(200, {'board': str(self.server.board), 'service': 'kanban-inbox'})
            if path == '/api/changes':
                return self.json_response(200, self.server.inbox.pending())
            if path == '/data.js':
                payload = ('window.KANBAN_DATA = ' + json.dumps(self.server.inbox.state(), ensure_ascii=False) + ';\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/javascript; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            # Serve only dashboard assets, never the inbox, logs or repository files.
            if path == '/' or path in ('/index.html', '/app.js', '/app.css') or path.startswith(('/templates/', '/vendor/')):
                if '..' not in path and '%' not in path:
                    return super().do_GET()
            self.send_error(404)
        except (ValueError, OSError, sqlite3.Error) as exc:
            self.json_response(500, {'error': str(exc)})

    def do_POST(self):
        origin = self.headers.get('Origin')
        if origin and origin != f'http://{self.headers.get("Host")}':
            return self.json_response(403, {'error': 'Cross-origin changes are not allowed'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.json_response(415, {'error': 'Send application/json'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                return self.json_response(413, {'error': 'Change exceeds the 8 MiB limit'})
            data = json.loads(self.rfile.read(length))
            path = urlsplit(self.path).path
            if path == '/api/changes':
                self.server.inbox.enqueue(data)
                return self.json_response(200, {'queued': data['id']})
            if path == '/api/reserve-id':
                return self.json_response(200, {'card': self.server.inbox.reserve(data['id'])})
            if path == '/api/check-change':
                return self.json_response(200, self.server.inbox.check(data['id']))
            if path == '/api/change-status':
                self.server.inbox.report(data['id'], data['reason'])
                return self.json_response(200, {'id': data['id']})
            if path == '/api/applied':
                self.server.inbox.acknowledge(data['ids'])
                return self.json_response(200, {'applied': data['ids']})
            self.send_error(404)
        except (ValueError, KeyError, TypeError) as exc:
            self.json_response(400, {'error': str(exc)})
        except (OSError, sqlite3.Error, subprocess.SubprocessError) as exc:
            self.json_response(500, {'error': str(exc)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--board', type=Path, default=Path('.ai/kanban'))
    parser.add_argument('--view', type=Path, default=Path('.ai/local/kanban'))
    parser.add_argument('--port', type=int, default=8124)
    args = parser.parse_args()
    if not (args.board / 'board.yml').is_file():
        parser.error('The board directory needs board.yml')
    args.view.mkdir(parents=True, exist_ok=True)
    page = Path(__file__).resolve().parent.parent / 'board'
    for name in ('index.html', 'app.js', 'app.css', 'templates', 'vendor'):
        link = args.view / name
        if link.is_symlink():
            if link.resolve() == (page / name).resolve():
                continue
            link.unlink()
        elif link.exists():
            parser.error(f'Refusing to overwrite {link}')
        link.symlink_to(page / name)
    server = DashboardServer(('127.0.0.1', args.port), args.view, args.board)
    print(f'Kanban: http://127.0.0.1:{server.server_port}/ ({args.board.resolve()})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
