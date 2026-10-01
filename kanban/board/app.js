/*
 * kanban: a board of Markdown cards, rendered in the browser; the agent keeps the files.
 *
 * The agent injects the board next to this page as data.js:
 *   window.KANBAN_DATA = { version, applied: [change ids], files: { path: text },
 *                          stats: { path: { modified, size } } }
 * where `files` is the board folder (a project's .ai/kanban): board.yml (columns, fields,
 * card template), and per column a folder of cards (Markdown with YAML front matter) with
 * `_<column>.md` listing them in order. This page parses those files, fills in the Mustache
 * templates in templates/, and reloads data.js every few seconds to pick up changes.
 *
 * The page sends JSON changes to the loopback server's durable inbox. The server never
 * writes Markdown: the agent checks each change against fresh board files and applies it.
 * Before snapshots protect touched paths; applied IDs acknowledge changes independently
 * of the board's content version. Pending browser changes survive reloads when storage
 * is available, and failed deliveries remain visible for retry.
 */
(() => {
  'use strict';

  const T = window.KanbanTemplates;
  const POLL_MS = 3000;
  const YAML = { schema: jsyaml.CORE_SCHEMA };
  // Changes can reach the agent only through the board's server.
  const LIVE = location.protocol === 'http:' || location.protocol === 'https:';

  const S = {
    data: null, // the injected data, as last loaded
    files: {}, // the files as shown: the data plus pending changes
    board: null,
    pending: [],
    query: '',
    // The board scope's value chosen in the address or on the page; null follows the board
    // (the option marked `current`). See scopeValue().
    scope: new URLSearchParams(location.search).get('scope'),
    // Which view shows: the columns ('board') or the outline of the board's levels.
    view: new URLSearchParams(location.search).get('view') === 'outline' ? 'outline' : 'board',
    // Swimlanes the viewer folded or unfolded, by lane value; loaded per board (see lanes()).
    lanes: null,
    folded: null, // outline documents folded, by path; loaded per board (see folded())
    modal: null, // { kind: 'card', id, editing } or { kind: 'new' }
    sortables: [],
    cancelling: false, // a cancellation is on its way to the server
    cancelError: '',
    bellOpen: false, // the notifications drop-down is open
    history: [], // what the toasts said, newest first (notify); the drop-down's Recent list
    dragging: false, // a card is being dragged; a redraw waits for the drop (redraw)
    redraw: false,
    followed: false,
    restored: false,
    delivery: {},
    deliveryError: '',
    storageError: '',
    sending: false,
    connectionError: '',
    lastApplied: 0,
  };

  // ---------------------------------------------------------------- the Markdown files

  const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
  const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

  function parseCard(text) {
    const m = FRONT.exec(text);
    if (!m) return { meta: {}, body: text };
    let meta;
    try {
      meta = jsyaml.load(m[1], YAML) || {};
    } catch (e) {
      meta = { title: `(front matter unreadable: ${e.message})` };
    }
    return { meta, body: text.slice(m[0].length).replace(/^\s*\n/, '') };
  }

  // The card's text with a new body, its front matter as it was written.
  function withBody(text, body) {
    const fm = FRONT.exec(text);
    return fm ? `${fm[0].replace(/\n*$/, '\n')}\n${body}` : body;
  }

  function yamlValue(v) {
    const opts = { ...YAML, lineWidth: -1, flowLevel: Array.isArray(v) ? 0 : -1 };
    return jsyaml.dump(v, opts).trimEnd();
  }

  // Front matter in a fixed key order (id, title, the board's fields, created, the rest),
  // without empty values; then the body.
  function serializeCard(meta, body, keyOrder) {
    const keys = [...keyOrder.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !keyOrder.includes(k))];
    const lines = keys.filter((k) => !isEmpty(meta[k])).map((k) => `${k}: ${yamlValue(meta[k])}`);
    return `---\n${lines.join('\n')}\n---\n\n${String(body || '').trim()}\n`;
  }

  const flow = (v) => jsyaml.dump(v, { ...YAML, flowLevel: 0, lineWidth: -1 }).trim();

  // board.yml, as the settings editor writes it: columns and options one per line, the
  // template as a block. Comments aren't kept (the editor can't know where they belonged).
  function serializeBoard(c) {
    const out = [
      "# The board's settings. The kanban skill (github.com/fonix232/skills, kanban/) documents every key.",
      `name: ${yamlValue(c.name)}`,
      `key: ${yamlValue(c.key)}`,
      '',
      'columns:',
      ...c.columns.map((col) => `  - ${flow({ id: col.id, title: col.title })}`),
      '',
      'fields:',
    ];
    for (const f of c.fields) {
      const { name, label, kind, options, ...rest } = f;
      out.push(`  - name: ${yamlValue(name)}`);
      if (label && label !== name) out.push(`    label: ${yamlValue(label)}`);
      out.push(`    kind: ${yamlValue(kind || 'text')}`);
      for (const [k, v] of Object.entries(rest)) if (!isEmpty(v) && v !== false) out.push(`    ${k}: ${yamlValue(v)}`);
      if (['select', 'multiselect'].includes(kind) && options && options.length) {
        out.push('    options:');
        for (const o of options) {
          const clean = Object.fromEntries(Object.entries(o).filter(([k, v]) => !isEmpty(v) && !(k === 'label' && v === o.value)));
          out.push(`      - ${Object.keys(clean).length === 1 ? yamlValue(clean.value) : flow(clean)}`);
        }
      }
    }
    if (c.levels && c.levels.length) {
      out.push('', 'levels:', ...c.levels.map((l) => `  - ${flow(Object.fromEntries(Object.entries(l).filter(([, v]) => !isEmpty(v))))}`));
    }
    const t = String(c.template || '').replace(/\s+$/, '');
    out.push('', t ? `template: |${/^\s/.test(t) ? '2' : ''}` : "template: ''", ...(t ? t.split('\n').map((l) => (l ? `  ${l}` : '')) : []));
    return `${out.join('\n')}\n`;
  }

  const orderPath = (column) => `${column}/_${column}.md`;

  // A column's order file: its cards' file names, in the order of their links.
  function parseOrder(text) {
    return [...String(text || '').matchAll(/\]\(<?([^)>\s]+\.md)>?\)/g)].map((m) => decodeURIComponent(m[1]));
  }

  function orderText(column, cards, key) {
    const esc = (t) => String(t).replace(/([\\[\]])/g, '\\$1');
    const items = cards.map((c, i) => `${i + 1}. [${key}-${c.id}: ${esc(c.title)}](${encodeURI(c.name)})`);
    return `# ${column.title}\n\n${items.length ? items.join('\n') : 'No cards.'}\n`;
  }

  // ---------------------------------------------------------------- criteria and tasks

  const TASK = /^(\s*)((?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])(?=\s|$)/;
  const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;

  // The body's lines, each marked when it's inside a fenced code block.
  function scan(body) {
    let fence = null;
    return String(body || '').split('\n').map((text) => {
      const f = /^\s*(```+|~~~+)/.exec(text);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        return { text, code: true };
      }
      return { text, code: Boolean(fence) };
    });
  }

  // Task list items (`- [ ]`, `- [x]`) outside code blocks, in order, with the `##` section
  // each is under ("Acceptance criteria", "Tasks") and its indent. The page renders their
  // checkboxes in this same order.
  function tasks(body) {
    const out = [];
    let section = '';
    scan(body).forEach(({ text, code }, i) => {
      if (code) return;
      const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
      if (h) {
        section = h[1];
        return;
      }
      const m = TASK.exec(text);
      if (m) out.push({ line: i, done: m[3] !== ' ', indent: m[1].length, section });
    });
    return out;
  }

  function toggleTask(body, n) {
    const t = tasks(body)[n];
    if (!t) return body;
    const lines = body.split('\n');
    lines[t.line] = lines[t.line].replace(TASK, (_, sp, a, b, c) => sp + a + (b === ' ' ? 'x' : ' ') + c);
    return lines.join('\n');
  }

  // The list item starting at `start` runs until the next line that isn't part of it: a
  // line indented no deeper than it (another item, or text after the list), or a blank line
  // that isn't followed by more of the item.
  function itemEnd(lines, start, indent) {
    let i = start + 1;
    while (i < lines.length) {
      const text = lines[i];
      if (text.trim() === '') {
        const next = lines.slice(i + 1).find((l) => l.trim() !== '');
        if (next === undefined || next.match(/^\s*/)[0].length <= indent) break;
      } else if (text.match(/^\s*/)[0].length <= indent) break;
      i++;
    }
    return i;
  }

  // Moves task `n`, with whatever belongs to it (a continuation, nested items), to position
  // `index` among the items of its own list.
  function moveTask(body, n, index) {
    const t = tasks(body)[n];
    if (!t) return body;
    const lines = body.split('\n');
    const sibling = (text) => {
      const m = LIST_ITEM.exec(text || '');
      return Boolean(m) && m[1].length === t.indent;
    };
    // Walk back to the list's first item at this indent (blank lines between items are
    // still the same list), then collect its items.
    let first = t.line;
    for (let i = t.line - 1; i >= 0; i--) {
      const text = lines[i];
      if (text.trim() === '') continue;
      if (sibling(text)) first = i;
      else if (text.match(/^\s*/)[0].length <= t.indent) break;
    }
    // Items without the blank lines between them; a list with those (a loose list) gets
    // them back between items, so the spacing survives the move.
    const items = [];
    const starts = [];
    let loose = false;
    let at = first;
    while (at < lines.length && sibling(lines[at])) {
      const end = itemEnd(lines, at, t.indent);
      let next = end;
      while (next < lines.length && lines[next].trim() === '') next++;
      items.push(lines.slice(at, end));
      starts.push(at);
      if (next < lines.length && sibling(lines[next])) {
        loose = loose || next > end;
        at = next;
      } else {
        at = end;
        break;
      }
    }
    const from = starts.indexOf(t.line);
    if (from < 0) return body;
    const [moved] = items.splice(from, 1);
    items.splice(Math.max(0, Math.min(index, items.length)), 0, moved);
    const joined = items.flatMap((item, k) => (loose && k < items.length - 1 ? [...item, ''] : item));
    return [...lines.slice(0, first), ...joined, ...lines.slice(at)].join('\n');
  }

  function progressOf(list) {
    const total = list.length;
    const done = list.filter((t) => t.done).length;
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  // ---------------------------------------------------------------- the board

  function normalizeConfig(c) {
    c = c && typeof c === 'object' ? c : {};
    return {
      name: c.name || 'Board',
      key: c.key || 'CARD',
      columns: (c.columns || []).map((col) => (typeof col === 'string' ? { id: col, title: col } : col)),
      fields: (c.fields || []).map((f) => ({
        kind: 'text',
        label: f.name,
        ...f,
        options: (f.options || []).map((o) => (o && typeof o === 'object' ? { ...o, value: String(o.value) } : { value: String(o) })),
      })),
      template: c.template || '',
      // The outline above the cards: each level is a folder of Markdown documents in the board.
      levels: (Array.isArray(c.levels) ? c.levels : []).filter((l) => l && l.id).map((l) => ({ ...l, id: String(l.id), title: String(l.title || l.id) })),
    };
  }

  function buildBoard(files) {
    let raw = {};
    try {
      raw = jsyaml.load(files['board.yml'] || '', YAML);
    } catch (e) {
      console.error('board.yml:', e);
    }
    const config = normalizeConfig(raw);
    const cards = new Map();
    const columns = config.columns.map((col) => {
      const prefix = `${col.id}/`;
      const list = [];
      for (const [path, text] of Object.entries(files)) {
        if (!path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length);
        if (name.includes('/') || !name.endsWith('.md') || name.startsWith('_')) continue;
        const { meta, body } = parseCard(text);
        const id = Number(meta.id ?? parseInt(name, 10));
        const card = { id, name, path, column: col.id, meta, body, title: String(meta.title ?? name) };
        list.push(card);
        cards.set(id, card);
      }
      const order = parseOrder(files[orderPath(col.id)]);
      const rank = (n) => (order.includes(n) ? order.indexOf(n) : Infinity);
      list.sort((a, b) => rank(a.name) - rank(b.name) || a.id - b.id);
      return { ...col, cards: list };
    });
    return { config, columns, cards };
  }

  const keyOrder = (config) => ['id', 'title', ...config.fields.map((f) => f.name), 'created'];
  const ticketOf = (id) => `${S.board.config.key}-${id}`;

  function slug(title) {
    const s = String(title).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-');
    return s.slice(0, 60).replace(/-+$/, '') || 'card';
  }

  // ---------------------------------------------------------------- changes

  // What each change does to the files. They run on a copy of the files, on the page when
  // the change is made, and again on newer data while the change is still pending.
  const ops = {
    move(files, c) {
      const b = buildBoard(files);
      const card = b.cards.get(c.card);
      const from = card && b.columns.find((x) => x.id === card.column);
      const to = b.columns.find((x) => x.id === c.column);
      if (!card || !to) return;
      const fromCards = from.cards.filter((x) => x !== card);
      const toCards = from === to ? fromCards : to.cards.slice();
      toCards.splice(Math.max(0, Math.min(c.index ?? toCards.length, toCards.length)), 0, card);
      if (from !== to) {
        files[`${to.id}/${card.name}`] = files[card.path];
        delete files[card.path];
      }
      files[orderPath(to.id)] = orderText(to, toCards, b.config.key);
      if (from !== to) files[orderPath(from.id)] = orderText(from, fromCards, b.config.key);
    },

    save(files, c) {
      const b = buildBoard(files);
      const card = b.cards.get(c.card);
      if (!card) return;
      const meta = { ...card.meta, title: c.title };
      for (const [k, v] of Object.entries(c.fields || {})) {
        if (isEmpty(v)) delete meta[k];
        else meta[k] = v;
      }
      files[card.path] = serializeCard(meta, c.body, keyOrder(b.config));
      if (c.column && c.column !== card.column) ops.move(files, { card: c.card, column: c.column });
      else if (c.title !== card.title) {
        const col = b.columns.find((x) => x.id === card.column);
        files[orderPath(col.id)] = orderText(col, col.cards.map((x) => (x === card ? { ...x, title: c.title } : x)), b.config.key);
      }
    },

    create(files, c) {
      const b = buildBoard(files);
      if (b.cards.has(c.card)) throw new Error(`Ticket ${b.config.key}-${c.card} already exists. Create it with a new ticket number.`);
      const col = b.columns.find((x) => x.id === c.column) || b.columns[0];
      if (!col) return;
      const meta = { id: c.card, title: c.title, ...c.fields, created: c.created };
      const name = `${String(c.card).padStart(3, '0')}-${slug(c.title)}.md`;
      files[`${col.id}/${name}`] = serializeCard(meta, c.body, keyOrder(b.config));
      files[orderPath(col.id)] = orderText(col, [...col.cards, { id: c.card, name, title: c.title }], b.config.key);
    },

    delete(files, c) {
      const b = buildBoard(files);
      const card = b.cards.get(c.card);
      if (!card) return;
      const col = b.columns.find((x) => x.id === card.column);
      delete files[card.path];
      files[orderPath(col.id)] = orderText(col, col.cards.filter((x) => x !== card), b.config.key);
    },

    // Only the criterion's line changes: the front matter stays as it was written.
    task(files, c) {
      const card = buildBoard(files).cards.get(c.card);
      if (card) files[card.path] = withBody(files[card.path], toggleTask(parseCard(files[card.path]).body, c.task));
    },

    // New board settings: board.yml, and each column's order file (a new column gets one; a
    // new key or title rewrites them). A removed column must be empty.
    config(files, c) {
      const before = buildBoard(files);
      const keeps = (col) => c.board.columns.some((x) => x.id === col.id);
      if (before.columns.some((col) => !keeps(col) && col.cards.length)) return;
      files['board.yml'] = serializeBoard(c.board);
      for (const migration of c.migrations || []) {
        const card = buildBoard(files).cards.get(migration.card);
        if (!card || !sameValue(card.meta[migration.field], migration.before)) throw new Error('A card changed during migration. Resolve it before applying settings.');
        const meta = { ...card.meta };
        if (migration.remove) delete meta[migration.field];
        else meta[migration.field] = migration.value;
        files[card.path] = serializeCard(meta, card.body, keyOrder(c.board));
      }
      const after = buildBoard(files);
      for (const col of after.columns) files[orderPath(col.id)] = orderText(col, col.cards, after.config.key);
      for (const col of before.columns) if (!keeps(col)) delete files[orderPath(col.id)];
    },

    // A criterion or task moved within its list.
    reorder(files, c) {
      const card = buildBoard(files).cards.get(c.card);
      if (card) files[card.path] = withBody(files[card.path], moveTask(parseCard(files[card.path]).body, c.task, c.index));
    },
  };

  function applyChange(files, c) {
    const next = { ...files };
    ops[c.op](next, c);
    return next;
  }

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const outboxKey = () => `kanban-outbox:${S.data?.boardId || location.pathname}`;

  function persistPending() {
    try {
      sessionStorage.setItem(outboxKey(), JSON.stringify(S.pending));
      S.storageError = '';
    } catch {
      S.storageError = 'Browser storage is unavailable. Keep this page open until all changes are applied.';
    }
  }

  async function post(path, data) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(new URL(path, location.href), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data), signal: controller.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `Request failed (${response.status})`);
      }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  async function sendPending() {
    if (S.sending || !LIVE) return;
    S.sending = true;
    S.deliveryError = '';
    try {
      let c;
      while ((c = S.pending.find((event) => S.delivery[event.id] !== 'queued'))) {
        const result = await post('api/changes', c);
        if (result.queued !== c.id) throw new Error('The server did not acknowledge this change. Retry delivery.');
        S.delivery[c.id] = 'queued';
      }
    } catch (error) {
      S.deliveryError = `Changes could not be delivered: ${error.message}. Your edits are retained; retry when the server is available.`;
    } finally {
      S.sending = false;
      render();
    }
  }

  // Withdraws a change waiting for the agent. The server cancels it with every later change
  // to the same files (their contents were built on it), after asking when there are any; the
  // board then shows the files without them. Everything is delivered first, so the server
  // knows each change it's asked about.
  async function cancelChange(id) {
    if (!LIVE || S.cancelling) return;
    S.cancelling = true;
    try {
      await sendPending();
      if (S.pending.some((c) => S.delivery[c.id] !== 'queued')) throw new Error('some changes haven\'t reached the server yet. Retry delivery first');
      const plan = await post('api/cancel', { ids: [id], dry_run: true });
      if (plan.cancelled.length > 1) askCancel(id, plan);
      else await cancelNow(plan.cancelled.length ? plan.cancelled : [id]);
    } catch (error) {
      cancelFailed(error);
    } finally {
      S.cancelling = false;
    }
  }

  async function cancelNow(ids) {
    const result = await post('api/cancel', { ids });
    const gone = new Set(result.cancelled);
    S.cancelError = '';
    accept({ ...S.data, queue: (S.data?.queue || []).filter((row) => !gone.has(row.id)), cancelled: [...(S.data?.cancelled || []), ...result.cancelled] });
  }

  function cancelFailed(error) {
    const old = /\((404|501)\)/.test(error.message);
    S.cancelError = old
      ? 'This board\'s server predates cancelling. Restart serve.py to cancel changes.'
      : `The change couldn't be cancelled: ${error.message}.`;
    render();
  }

  function askCancel(id, plan) {
    const d = $('#confirm');
    const count = plan.cancelled.length;
    d.innerHTML = `<div>${Mustache.render(T.confirmCancel, {
      count, ids: plan.cancelled.join(' '), first: plan.summaries[id] || 'This change',
      later: plan.cancelled.filter((i) => i !== id).map((i) => plan.summaries[i] || i),
    }, T.partials)}</div>`;
    d.showModal();
  }

  // Applies a change on the page and hands it to the agent.
  function commit(op, fields, summary, sourceFiles = null) {
    if (!LIVE) return;
    const c = { id: uid(), at: new Date().toISOString(), base: S.data?.version ?? null, op, summary, ...fields };
    const before = S.files;
    const after = applyChange(before, c);
    c.writes = {};
    c.deletes = [];
    c.before = {};
    c.requires = S.pending.map((p) => p.id);
    for (const [p, t] of Object.entries(after)) if (before[p] !== t) c.writes[p] = t;
    for (const p of Object.keys(before)) if (!(p in after)) c.deletes.push(p);
    for (const p of [...Object.keys(c.writes), ...c.deletes]) c.before[p] = (sourceFiles || before)[p] ?? null;
    if (!Object.keys(c.writes).length && !c.deletes.length) return;
    S.pending.push(c);
    S.files = after;
    S.board = buildBoard(after);
    persistPending();
    render();
    void sendPending();
    window.dispatchEvent(new CustomEvent('kanban:change', { detail: c }));
  }

  // ---------------------------------------------------------------- data from the agent

  function accept(data) {
    S.data = data;
    if (!S.restored) {
      S.restored = true;
      try {
        const saved = JSON.parse(sessionStorage.getItem(outboxKey()) || '[]');
        if (Array.isArray(saved)) S.pending = saved;
      } catch { S.storageError = 'The saved browser outbox could not be read. Keep this page open and check the server inbox.'; }
    }
    const applied = new Set(data.applied || []);
    const cancelled = new Set(data.cancelled || []);
    S.lastApplied += S.pending.filter((c) => applied.has(c.id)).length;
    S.pending = S.pending.filter((c) => !applied.has(c.id) && !cancelled.has(c.id));
    let files = { ...(data.files || {}) };
    S.replayError = '';
    for (const c of S.pending) {
      try { files = applyChange(files, c); }
      catch (error) { S.replayError = `A pending change needs the agent's attention: ${error.message}`; break; }
    }
    persistPending();
    S.files = files;
    S.board = buildBoard(files);
    render();
    refreshModal();
    if (!S.followed) {
      S.followed = true;
      followHash();
      if (S.pending.length) void sendPending();
    }
  }

  function poll() {
    if (S.polling) return;
    S.polling = true;
    const s = document.createElement('script');
    s.src = `data.js?t=${Date.now()}`;
    const timeout = setTimeout(() => failed(), 10000);
    const failed = () => {
      clearTimeout(timeout); s.remove(); S.polling = false; s.onload = s.onerror = null;
      S.connectionError = 'Connection lost. The board may be out of date; your drafts are retained.';
      render();
    };
    s.onerror = failed;
    s.onload = () => {
      clearTimeout(timeout); S.polling = false;
      const wasLost = S.connectionError !== '';
      S.connectionError = '';
      s.remove();
      const d = window.KANBAN_DATA;
      // An unchanged board isn't drawn again: redrawing every poll loses the reader's place.
      if (d && (d.version !== S.data?.version || JSON.stringify(d.applied || []) !== JSON.stringify(S.data?.applied || []) || JSON.stringify(d.queue || []) !== JSON.stringify(S.data?.queue || []) || (d.cancelled || []).length !== (S.data?.cancelled || []).length)) accept(d);
      else if (wasLost) render();
    };
    document.head.append(s);
  }

  // ---------------------------------------------------------------- views for the templates

  function fieldValues(field, v) {
    if (isEmpty(v)) return [];
    return (Array.isArray(v) ? v : [v]).map(String);
  }

  function optionOf(field, value) {
    return field.options.find((x) => x.value === value);
  }

  function variantOf(field, value) {
    return optionOf(field, value)?.variant || field.variant || 'secondary';
  }

  // A colour from board.yml, for a style attribute: nothing that could end the declaration.
  const safeColor = (c) => (typeof c === 'string' && /^[#\w(),.%\s-]+$/.test(c) ? c : '');

  // The theme's palette: app.css defines each as --kb-<name>, for light and dark. An option's
  // colour names one of them (`color: red`), so pills and markers follow the theme. Any other
  // CSS colour works too, the same in both themes.
  const PALETTE = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink', 'gray'];
  const colorOf = (c) => (!c ? '' : PALETTE.includes(c) ? `var(--kb-${c})` : safeColor(c));
  const labelOf = (field, value) => optionOf(field, value)?.label || value;

  // The card's priority marker: the colour of its value in the first `marker` field.
  function markerOf(card) {
    for (const f of S.board.config.fields.filter((x) => x.marker)) {
      const v = fieldValues(f, card.meta[f.name])[0];
      if (v !== undefined) return { color: colorOf(optionOf(f, v)?.color), label: `${f.label}: ${labelOf(f, v)}` };
    }
    return { color: '', label: '' };
  }

  // The board's scope: the first select field with `scope: true`, usually the milestone. The
  // page shows one of its values at a time: the one picked on the page or in the address
  // (?scope=M2), else the option marked `current: true`, else every card. `*` is every card
  // and `-` the cards without a value.
  const ALL = '*';
  const NONE = '-';
  const scopeField = () => S.board.config.fields.find((f) => f.scope && f.kind === 'select');

  function scopeValue() {
    const f = scopeField();
    if (!f) return ALL;
    if (S.scope !== null && S.scope !== '') return S.scope;
    return f.options.find((o) => o.current)?.value ?? ALL;
  }

  function inScope(card) {
    const f = scopeField();
    const want = scopeValue();
    if (!f || want === ALL) return true;
    const v = fieldValues(f, card.meta[f.name])[0];
    return want === NONE ? v === undefined : v === want;
  }

  function scopeView() {
    const f = scopeField();
    if (!f) return null;
    const want = scopeValue();
    const known = [ALL, NONE, ...f.options.map((o) => o.value)];
    return {
      label: f.label,
      options: [
        { value: ALL, text: `Every ${f.label.toLowerCase()}`, selected: want === ALL },
        ...f.options.map((o) => ({ value: o.value, text: `${o.label || o.value}${o.current ? ' (current)' : ''}`, selected: want === o.value })),
        ...(known.includes(want) ? [] : [{ value: want, text: want, selected: true }]),
        { value: NONE, text: `No ${f.label.toLowerCase()}`, selected: want === NONE },
      ],
    };
  }

  function tileView(card) {
    const badges = [];
    for (const f of S.board.config.fields.filter((x) => x.tile)) {
      for (const v of fieldValues(f, card.meta[f.name])) {
        const cards = f.kind === 'cards';
        badges.push({ text: cards ? ticketOf(v) : labelOf(f, v), variant: variantOf(f, v), label: f.label, color: cards ? '' : colorOf(optionOf(f, v)?.color) });
      }
    }
    const depends = fieldValues({}, card.meta.depends_on).map(ticketOf);
    const marker = markerOf(card);
    const search = [ticketOf(card.id), card.title, ...badges.map((b) => b.text), marker.label].join(' ').toLowerCase();
    const pending = S.pending.some((c) => c.card === card.id);
    const progress = progressOf(tasks(card.body));
    return {
      id: card.id,
      ticket: ticketOf(card.id),
      title: card.title,
      badges,
      hasBadges: badges.length > 0,
      progress,
      depends,
      search,
      pending,
      outOfScope: !inScope(card),
      marker: marker.color,
      markerLabel: marker.label,
    };
  }

  // Swimlanes: one per value of the scope field (a milestone each), plus one for cards without
  // a value. With every value shown, the current one is open and the others folded, unless the
  // viewer folded or opened them; with one value picked, only its lane shows, open.
  const lanesKey = () => `kanban-lanes:${S.data?.boardId || location.pathname}`;

  function lanes() {
    if (S.lanes === null) {
      try {
        S.lanes = JSON.parse(localStorage.getItem(lanesKey()) || '{}') || {};
      } catch {
        S.lanes = {};
      }
    }
    return S.lanes;
  }

  function toggleLane(value, open) {
    lanes()[value] = !open;
    try {
      localStorage.setItem(lanesKey(), JSON.stringify(S.lanes));
    } catch {}
    render();
  }

  // Outline documents the viewer folded, by path; kept per board like the lanes.
  const foldedKey = () => `kanban-outline:${S.data?.boardId || location.pathname}`;

  function folded() {
    if (S.folded === null) {
      try {
        S.folded = JSON.parse(localStorage.getItem(foldedKey()) || '{}') || {};
      } catch {
        S.folded = {};
      }
    }
    return S.folded;
  }

  function toggleNode(path, open) {
    if (open) delete folded()[path];
    else folded()[path] = true;
    try {
      localStorage.setItem(foldedKey(), JSON.stringify(S.folded));
    } catch {}
    render();
  }

  const cardsText = (n) => `${n} card${n === 1 ? '' : 's'}`;

  function lanesView() {
    const f = scopeField();
    const cell = (lane, match) => S.board.columns.map((col) => ({ column: col.id, lane, cards: col.cards.filter(match).map(tileView) }));
    if (!f) return [{ value: '', header: false, collapsed: false, cells: cell('', () => true) }];
    const want = scopeValue();
    const valueOf = (card) => fieldValues(f, card.meta[f.name])[0];
    const extra = [...new Set([...S.board.cards.values()].map(valueOf).filter((v) => v !== undefined && !f.options.some((o) => o.value === v)))];
    const all = [
      ...f.options.map((o) => ({ value: o.value, label: o.label || o.value, current: Boolean(o.current), always: true })),
      ...extra.map((v) => ({ value: v, label: v, current: false, always: false })),
      { value: NONE, label: `No ${f.label.toLowerCase()}`, current: false, always: false },
    ];
    return all
      .map((l) => {
        const cells = cell(l.value, (card) => (l.value === NONE ? valueOf(card) === undefined : valueOf(card) === l.value));
        const count = cells.reduce((n, c) => n + c.cards.length, 0);
        const stored = lanes()[l.value];
        const collapsed = want === ALL ? (stored === undefined ? !l.current : stored) : false;
        // Each column's count in this lane, for the headers while the lane is under them.
        const counts = JSON.stringify(Object.fromEntries(cells.map((c) => [c.column, c.cards.length])));
        return { ...l, header: true, count, countText: cardsText(count), collapsed, cells, counts };
      })
      .filter((l) => (want === ALL ? l.always || l.count > 0 : l.value === want));
  }

  // The outline: the board's levels (initiatives, then epics, say), each a folder of Markdown
  // documents in the board with `id`, `title` and `status` in their front matter. A level's
  // `parent` names the front matter key that points at its parent level's document; the last
  // level's `field` is the card field that points at it.
  const STATUS_COLORS = { draft: 'gray', proposed: 'gray', planned: 'gray', reviewed: 'blue', approved: 'blue', 'in-progress': 'amber', active: 'amber', closing: 'amber', done: 'green', closed: 'green', superseded: 'gray' };

  function levelDocs(level) {
    const prefix = `${level.id}/`;
    return Object.entries(S.files)
      .filter(([path]) => path.startsWith(prefix) && path.endsWith('.md') && !path.slice(prefix.length).includes('/') && !path.slice(prefix.length).startsWith('_'))
      .map(([path, text]) => {
        const { meta, body } = parseCard(text);
        const id = String(meta.id ?? path.slice(prefix.length, -3));
        return { id, title: String(meta.title ?? id), status: isEmpty(meta.status) ? '' : String(meta.status), meta, body, path, level };
      })
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  function outlineView() {
    const levels = S.board.config.levels;
    const f = scopeField();
    const want = scopeValue();
    const doneColumn = S.board.columns.at(-1)?.id;
    const last = levels.length - 1;
    const link = levels[last].field;
    const docs = levels.map(levelDocs);
    const cards = [...S.board.cards.values()];
    const linked = (card) => (link ? fieldValues({}, card.meta[link])[0] : undefined);
    const docScoped = (doc) => {
      if (!f || want === ALL) return true;
      const v = [...fieldValues({}, doc.meta[f.name]), ...fieldValues({}, doc.meta[`${f.name}s`])];
      return want === NONE ? v.length === 0 : v.includes(want);
    };
    const storyView = (c) => ({ id: c.id, ticket: ticketOf(c.id), title: c.title, columnTitle: S.board.columns.find((col) => col.id === c.column)?.title || c.column, done: c.column === doneColumn });
    const progress = (list) => {
      const done = list.filter((c) => c.column === doneColumn).length;
      return { done, total: list.length, pct: list.length ? Math.round((done / list.length) * 100) : 0 };
    };
    // With one scope value picked, a last-level document shows when it carries that value or
    // has cards in it; a higher one shows when any of its children does.
    const filtering = Boolean(f) && want !== ALL;
    const node = (doc, depth) => {
      const childLevel = levels[depth + 1];
      const children = childLevel ? docs[depth + 1].filter((d) => String(d.meta[childLevel.parent] ?? '') === doc.id).map((d) => node(d, depth + 1)).filter(Boolean) : [];
      const own = depth === last ? cards.filter((c) => linked(c) === doc.id) : [];
      const stories = own.filter(inScope);
      if (filtering && (depth === last ? !(docScoped(doc) || stories.length) : children.length === 0)) return null;
      const all = [...own, ...children.flatMap((ch) => ch.cardList)];
      const collapsible = stories.length > 0 || children.length > 0;
      return {
        id: doc.id, title: doc.title, path: doc.path, depth, levelTitle: doc.level.title,
        collapsible, collapsed: collapsible && Boolean(folded()[doc.path]),
        status: doc.status, statusColor: `var(--kb-${STATUS_COLORS[doc.status] || 'gray'})`,
        progress: progress(all), cardList: all,
        stories: stories.map(storyView), children,
      };
    };
    // Top level: the first level's documents, then any lower-level ones whose parent is missing.
    const orphan = (depth, doc) => !docs[depth - 1].some((p) => p.id === String(doc.meta[levels[depth].parent] ?? ''));
    const roots = docs.flatMap((list, depth) => list.filter((d) => depth === 0 || orphan(depth, d)).map((d) => node(d, depth))).filter(Boolean);
    const loose = cards.filter((c) => inScope(c) && !docs[last].some((d) => d.id === linked(c)));
    return {
      roots,
      empty: roots.length === 0 && loose.length === 0,
      loose: loose.map(storyView),
      looseCount: cardsText(loose.length),
      looseTitle: `Not in any ${levels[last].title.replace(/s$/i, '').toLowerCase()}`,
      folders: levels.map((l) => l.id).join('/, ') + '/',
    };
  }

  function dashboardView() {
    const c = S.board.config;
    const outline = S.view === 'outline' && c.levels.length > 0;
    return {
      name: c.name,
      key: c.key,
      query: S.query,
      scope: scopeView(),
      views: c.levels.length ? { board: !outline, outline, label: c.levels.map((l) => l.title).join(' & ') } : null,
      outline: outline ? outlineView() : null,
      lanes: outline ? [] : lanesView(),
      hasLanes: Boolean(scopeField()),
      columnCount: S.board.columns.length,
      editable: LIVE,
      pending: { count: changeStatuses().length, list: changeStatuses() },
      bell: { open: S.bellOpen, recent: S.history.map((n) => ({ ...n, time: new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })) },
      columns: S.board.columns.map((col) => ({ id: col.id, title: col.title, count: col.cards.filter(inScope).length, cards: col.cards.map(tileView) })),
    };
  }

  function changeStatuses() {
    const queued = S.data?.queue || [];
    const rows = new Map(queued.map(row => [row.id, { ...row, summary: row.reason ? `${row.summary}: ${row.reason}` : row.summary }]));
    for (const event of S.pending) if (!rows.has(event.id)) rows.set(event.id, { id: event.id, summary: event.summary,
      status: S.replayError ? 'Needs resolution' : S.delivery[event.id] === 'queued' ? 'Queued for agent' : 'Not delivered' });
    return [...rows.values()];
  }

  function fieldInputView(field, value) {
    const values = fieldValues(field, value);
    const invalidTypedValue = !isEmpty(value) && ((field.kind === 'number' && !Number.isFinite(Number(value))) || (field.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))));
    const kind = invalidTypedValue ? 'text' : field.kind;
    const text = kind === 'cards' ? values.map(ticketOf).join(', ') : values.join(', ');
    return {
      name: field.name,
      label: field.label,
      help: field.help,
      isSelect: kind === 'select',
      isMulti: kind === 'multiselect',
      isText: kind === 'text',
      isList: kind === 'list',
      isCards: kind === 'cards',
      isNumber: kind === 'number',
      isDate: kind === 'date',
      options: [...field.options, ...values.filter(v => !field.options.some(o => o.value === String(v))).map(v => ({ value: String(v), label: `${v} (existing value)` }))].map((o) => ({ value: o.value, label: o.label || o.value, selected: values.includes(o.value) })),
      text,
    };
  }

  function columnOptions(selected) {
    return S.board.columns.map((c) => ({ id: c.id, title: c.title, selected: c.id === selected }));
  }

  function sizeText(n) {
    if (n === undefined || n === null) return null;
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
  }

  function when(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  // The card's file, for the info popover: where it is, and what the agent's data says of it.
  function fileInfo(card) {
    const stat = S.data?.stats?.[card.path];
    const changed = S.data?.files?.[card.path] !== S.files[card.path];
    return {
      path: `.ai/kanban/${card.path}`,
      created: card.meta.created ? String(card.meta.created) : null,
      modified: changed ? 'changed on this page, not written yet' : when(stat?.modified),
      size: sizeText(changed ? new TextEncoder().encode(S.files[card.path] || '').length : stat?.size),
    };
  }

  // Criteria and tasks per section, for the side column.
  function sectionsOf(body) {
    const by = new Map();
    for (const t of tasks(body)) {
      const name = t.section || 'Checklist';
      if (!by.has(name)) by.set(name, []);
      by.get(name).push(t);
    }
    return [...by].map(([name, list]) => ({ name, ...progressOf(list) }));
  }

  function cardView(card, editing) {
    const cfg = S.board.config;
    const col = S.board.columns.find((c) => c.id === card.column);
    const marker = markerOf(card);
    const view = {
      id: card.id,
      ticket: ticketOf(card.id),
      title: card.title,
      columnTitle: col ? col.title : card.column,
      key: cfg.key,
      editable: LIVE,
      editing,
      marker: marker.color,
      file: fileInfo(card),
      columns: columnOptions(card.column),
    };
    if (editing) {
      view.fields = cfg.fields.map((f) => fieldInputView(f, card.meta[f.name]));
      view.body = card.body;
    } else {
      view.fields = cfg.fields.map((f) => {
        const values = fieldValues(f, card.meta[f.name]).map((v) =>
          f.kind === 'cards' ? { text: ticketOf(v), card: Number(v) } : { text: labelOf(f, v), variant: variantOf(f, v), color: colorOf(optionOf(f, v)?.color) });
        return { label: f.label, hasValue: values.length > 0, values };
      });
      view.sections = sectionsOf(card.body);
      view.bodyHtml = markdown(card.body, true);
    }
    return view;
  }

  // The next card number. A number is never used twice, so cards deleted on this page (and
  // in the data the page has seen) still count.
  function nextId() {
    const seen = [...S.board.cards.keys(), ...S.pending.map((c) => Number(c.card) || 0)];
    for (const path of Object.keys(S.data?.files || {})) {
      const n = parseInt(path.split('/').pop(), 10);
      if (n) seen.push(n);
    }
    return Math.max(0, ...seen) + 1;
  }

  function newCardView(column) {
    const cfg = S.board.config;
    return {
      key: cfg.key,
      nextTicket: ticketOf(nextId()),
      columns: columnOptions(column || cfg.columns[0]?.id),
      fields: cfg.fields.map((f) => fieldInputView(f, f === scopeField() && ![ALL, NONE].includes(scopeValue()) ? scopeValue() : f.default)),
      body: cfg.template,
    };
  }

  // Lucide's grip-vertical: the handle a criterion or task is dragged by.
  const GRIP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>';

  // Markdown to safe HTML. With `live`, criteria and tasks can be ticked and dragged (by
  // their order in the body), and ticket numbers (KEY-12) open their card.
  function markdown(md, live) {
    const html = DOMPurify.sanitize(marked.parse(String(md || ''), { gfm: true }));
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    // A card's images live in the board's attachments/ folder and are linked from the card
    // as ../attachments/<KEY>-<n>/<file>; the server serves that folder at /attachments/.
    tpl.content.querySelectorAll('img').forEach((img) => {
      const m = /^(?:\.\.\/)?(attachments\/[^?#]+)$/.exec(img.getAttribute('src') || '');
      if (m) img.setAttribute('src', m[1]);
      img.setAttribute('loading', 'lazy');
    });
    const boxes = [...tpl.content.querySelectorAll('input[type="checkbox"]')];
    boxes.forEach((cb, n) => {
      cb.dataset.task = String(n);
      if (live && LIVE) {
        cb.removeAttribute('disabled');
        cb.dataset.action = 'toggle-task';
      }
    });
    if (live && LIVE) {
      // A list whose items are all tasks can be reordered by a handle next to each checkbox.
      tpl.content.querySelectorAll('ul, ol').forEach((list) => {
        const items = [...list.children].filter((li) => li.tagName === 'LI');
        const own = (li) => [...li.querySelectorAll('input[type="checkbox"]')].find((cb) => cb.closest('li') === li);
        if (!items.length || !items.every(own)) return;
        list.classList.add('kb-task-list');
        for (const li of items) {
          const grip = document.createElement('span');
          grip.className = 'kb-grip';
          grip.title = 'Drag to reorder';
          grip.setAttribute('aria-hidden', 'true');
          grip.innerHTML = GRIP_ICON;
          li.prepend(grip);
          li.dataset.task = own(li).dataset.task;
        }
      });
    }
    linkTickets(tpl.content);
    return tpl.innerHTML;
  }

  function linkTickets(root) {
    const key = S.board.config.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${key}-(\\d+)\\b`, 'g');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) {
      re.lastIndex = 0;
      if (re.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      let last = 0;
      node.nodeValue.replace(re, (m, id, at) => {
        frag.append(node.nodeValue.slice(last, at));
        const a = document.createElement('a');
        a.href = '#';
        a.dataset.action = 'open-card';
        a.dataset.id = id;
        a.textContent = m;
        frag.append(a);
        last = at + m.length;
        return m;
      });
      frag.append(node.nodeValue.slice(last));
      node.replaceWith(frag);
    }
  }

  // ---------------------------------------------------------------- the rich editor

  // A card's details are edited in Toast UI's WYSIWYG editor. Its textarea stays the value
  // the form sends (and what incoming edits change); the editor fills it on every change.
  // Toast UI writes Markdown in its own style (`*` bullets, escapes, four-space nesting), so
  // the blocks you didn't touch keep their exact original text: `mergeMarkdown`.
  const RICH = new WeakMap(); // textarea → { editor, original, base, quiet }

  // A body's blocks (paragraphs, lists, headings, link definitions, …), each with the blank
  // lines before it, and what follows the last one: together, the text exactly.
  function blocksOf(md) {
    const blocks = [];
    let gap = '';
    for (const t of marked.lexer(String(md || ''))) {
      if (t.type === 'space') {
        gap += t.raw;
        continue;
      }
      const text = t.raw.replace(/\n+$/, '');
      blocks.push({ text, gap });
      gap = t.raw.slice(text.length);
    }
    return { blocks, tail: gap };
  }

  // A block's text as it reads, to check that two blocks say the same thing.
  function plainOf(md) {
    const tpl = document.createElement('template');
    tpl.innerHTML = DOMPurify.sanitize(marked.parse(md));
    tpl.content.querySelectorAll('input[type="checkbox"]').forEach((cb) => cb.replaceWith(cb.checked ? '[x]' : '[ ]'));
    return tpl.content.textContent.replace(/\s+/g, '');
  }

  // Toast UI's style for a block it wrote: `-` bullets, and no escapes inside words.
  const tidy = (block) => block.replace(/^(\s*)\*(\s)/gm, '$1-$2').replace(/(\w)\\_(?=\w)/g, '$1_');

  // `edited` is what the editor holds now; `base` is what it wrote for `original` before any
  // edit. Blocks unchanged since `base` come back as `original` had them, spacing and all.
  function mergeMarkdown(original, base, edited) {
    if (edited === base) return original;
    const { blocks: O, tail } = blocksOf(original);
    const A = blocksOf(base).blocks.map((b) => b.text);
    const B = blocksOf(edited).blocks.map((b) => b.text);
    const end = original.endsWith('\n') ? '\n' : '';
    // Only when the editor's blocks line up with the original's, one for one.
    if (O.length !== A.length || O.some((o, i) => plainOf(o.text) !== plainOf(A[i]))) return B.map(tidy).join('\n\n') + end;
    const n = A.length;
    const m = B.length;
    const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
    let out = '';
    let last = -2; // the original's block written last, when it was
    let i = 0;
    let j = 0;
    while (j < m) {
      if (i < n && A[i] === B[j]) {
        if (out) out += last === i - 1 ? O[i].gap : '\n\n';
        out += O[i].text;
        last = i++;
        j++;
      } else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) i++;
      else {
        out += (out ? '\n\n' : '') + tidy(B[j++]);
        last = -2;
      }
    }
    return out + (last === n - 1 ? tail : end);
  }

  function mountRichEditors(root) {
    if (!window.toastui) return;
    root.querySelectorAll('textarea.kb-body').forEach((textarea) => {
      if (RICH.has(textarea)) return;
      const host = document.createElement('div');
      host.className = 'kb-rich';
      textarea.hidden = true;
      textarea.after(host);
      const state = { original: textarea.value, base: '', quiet: true };
      state.editor = new toastui.Editor({
        el: host,
        height: 'auto',
        minHeight: '22rem',
        initialEditType: 'wysiwyg',
        initialValue: textarea.value,
        previewStyle: 'tab',
        usageStatistics: false,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        toolbarItems: [['heading', 'bold', 'italic', 'strike'], ['hr', 'quote'], ['ul', 'ol', 'task', 'indent', 'outdent'], ['table', 'link'], ['code', 'codeblock']],
        customMarkdownRenderer: { bulletList: () => ({ delim: '-' }) },
        events: {
          change: () => {
            if (state.quiet) return;
            textarea.value = mergeMarkdown(state.original, state.base, state.editor.getMarkdown());
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          },
        },
      });
      state.base = state.editor.getMarkdown();
      state.quiet = false;
      RICH.set(textarea, state);
    });
  }

  // Replaces what an editor holds (an accepted incoming edit), as if it had opened on it.
  function loadRich(textarea, text) {
    textarea.value = text;
    const state = RICH.get(textarea);
    if (!state) return;
    state.quiet = true;
    state.original = text;
    state.editor.setMarkdown(text, false);
    state.base = state.editor.getMarkdown();
    state.quiet = false;
  }

  // ---------------------------------------------------------------- rendering

  const $ = (sel, root = document) => root.querySelector(sel);

  function render() {
    const app = $('#app');
    if (!S.board) {
      app.innerHTML = Mustache.render(T.noData, {}, T.partials);
      return;
    }
    // A card being dragged would be dropped by redrawing: draw once the drag ends.
    if (S.dragging) { S.redraw = true; return; }
    // Every scrolling area keeps its place across a redraw: the board (both ways, it scrolls
    // vertically with swimlanes), the outline, each lane's list, and the page itself.
    const listKey = (el) => `${el.dataset.column}\u0000${el.dataset.lane ?? ''}`;
    const lists = new Map([...document.querySelectorAll('.kb-cards')].map((el) => [listKey(el), el.scrollTop]));
    const areas = ['.kb-board', '.kb-outline', '.kb-bell-panel'].map((sel) => [sel, $(sel)?.scrollTop || 0, $(sel)?.scrollLeft || 0]);
    const page = [window.scrollX, window.scrollY];
    const focused = document.activeElement?.dataset?.action === 'filter';
    const bellFocused = document.activeElement?.dataset?.action === 'bell';
    syncToasts(); // first: it records what the bell's drop-down lists
    app.innerHTML = Mustache.render(T.dashboard, dashboardView(), T.partials);
    for (const [sel, top, left] of areas) {
      const el = $(sel);
      if (el) { el.scrollTop = top; el.scrollLeft = left; }
    }
    document.querySelectorAll('.kb-cards').forEach((el) => {
      if (lists.has(listKey(el))) el.scrollTop = lists.get(listKey(el));
    });
    window.scrollTo(page[0], page[1]);
    if (bellFocused) $('[data-action="bell"]')?.focus();
    if (focused) {
      const input = $('[data-action="filter"]');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    applyFilter();
    bindSortables();
    showDeliveryError();
    $('.kb-board')?.addEventListener('scroll', updateHeaderCounts, { passive: true });
    updateHeaderCounts();
  }

  // While a swimlane is under the sticky column headers, each header counts that lane's cards
  // out of the column's, as "20/50"; above the first lane, and with one lane, the column's alone.
  function updateHeaderCounts() {
    const board = $('.kb-board.kb-has-lanes');
    if (!board) return;
    const edge = $('.kb-board-head', board).getBoundingClientRect().bottom;
    const lanes = [...board.querySelectorAll('.kb-lane')];
    const lane = lanes.length > 1 ? lanes.find((el) => {
      const r = el.getBoundingClientRect();
      return r.top < edge && r.bottom > edge;
    }) : null;
    let counts = {};
    try { counts = lane ? JSON.parse(lane.dataset.counts || '{}') : {}; } catch {}
    board.querySelectorAll('.kb-column').forEach((col) => {
      const badge = $('.kb-column-count', col);
      if (!badge) return;
      const total = badge.dataset.total;
      const n = lane ? counts[col.dataset.column] ?? 0 : null;
      const text = n === null ? total : `${n}/${total}`;
      if (badge.textContent !== text) badge.textContent = text;
      if (n === null) badge.removeAttribute('title');
      else badge.title = `${n} of ${total} cards in ${lane.dataset.label}`;
    });
  }

  function applyFilter() {
    const q = S.query.trim().toLowerCase();
    document.querySelectorAll('.kb-tile').forEach((el) => {
      const unmatched = q !== '' && !q.split(/\s+/).every((w) => el.dataset.search.includes(w));
      el.classList.toggle('kb-hidden', el.dataset.out === '1' || unmatched);
    });
  }

  // Where a dropped card goes in its column's whole order: before the card it was dropped
  // above, after the one it was dropped below, else last. A swimlane shows only part of a
  // column, so its list's own position isn't the column's.
  function dropIndex(column, id, nextId, prevId) {
    const others = S.board.columns.find((c) => c.id === column).cards.filter((c) => c.id !== id);
    const at = (n) => others.findIndex((c) => c.id === n);
    if (nextId !== null && at(nextId) >= 0) return at(nextId);
    if (prevId !== null && at(prevId) >= 0) return at(prevId) + 1;
    return others.length;
  }

  function bindSortables() {
    S.sortables.forEach((s) => s.destroy());
    S.sortables = [];
    if (!LIVE) return;
    document.querySelectorAll('.kb-cards').forEach((list) => {
      S.sortables.push(
        Sortable.create(list, {
          group: `cards-${list.dataset.lane || ''}`,
          animation: 150,
          ghostClass: 'kb-ghost',
          chosenClass: 'kb-chosen',
          filter: '.kb-hidden',
          onStart: () => { S.dragging = true; },
          onEnd: (e) => {
            S.dragging = false;
            if (S.redraw) { S.redraw = false; queueMicrotask(render); }
            const id = Number(e.item.dataset.id);
            const column = e.to.dataset.column;
            const card = S.board.cards.get(id);
            const near = (dir) => {
              let el = e.item[dir];
              while (el && !el.matches('.kb-tile')) el = el[dir];
              return el ? Number(el.dataset.id) : null;
            };
            const index = dropIndex(column, id, near('nextElementSibling'), near('previousElementSibling'));
            if (!card || (card.column === column && S.board.columns.find((c) => c.id === column).cards.indexOf(card) === index)) return;
            const title = S.board.columns.find((c) => c.id === column)?.title || column;
            commit('move', { card: id, column, index }, card.column === column ? `Reorder ${ticketOf(id)} in ${title}` : `Move ${ticketOf(id)} to ${title}`);
          },
        }),
      );
    });
  }

  // Dragging a criterion or task within its list, in the card modal.
  function bindTaskSortables(root, cardId) {
    root.querySelectorAll('.kb-task-list').forEach((list) => {
      Sortable.create(list, {
        handle: '.kb-grip',
        animation: 150,
        ghostClass: 'kb-ghost',
        onEnd: (e) => {
          if (e.oldIndex === e.newIndex) return;
          const n = Number(e.item.dataset.task);
          commit('reorder', { card: cardId, task: n, index: e.newIndex }, `Reorder a checklist item on ${ticketOf(cardId)}`);
          openCard(cardId);
        },
      });
    });
  }

  // ---------------------------------------------------------------- toasts

  // Changes and problems show as toasts in the top right corner, outside #app, so a redraw
  // leaves them alone. A change's toast follows it (not delivered, queued, applied) and goes
  // TOAST_MS after its last update, held while the pointer is on it; a problem's toast stays
  // until the problem clears. A toast closed by hand comes back only when what it says changes.
  const TOAST_MS = 15000;
  const HISTORY = 30;
  const TOASTS = new Map(); // key -> { el, sticky, timer }, the toasts on screen
  const SHOWN = new Map(); // key -> what its toast last said
  const TRACKED = new Map(); // change id -> summary, the changes with a toast to follow

  function notify(key, { title, text = '', tone = 'info', sticky = false, action = null }) {
    const said = JSON.stringify([title, text, tone, action]);
    if (SHOWN.get(key) === said) return;
    SHOWN.set(key, said);
    S.history = [{ title, text, tone, at: Date.now() }, ...S.history].slice(0, HISTORY);
    let t = TOASTS.get(key);
    if (!t) {
      let box = $('#kb-toasts');
      if (!box) {
        box = document.createElement('section');
        box.id = 'kb-toasts';
        box.className = 'kb-toasts';
        box.setAttribute('aria-label', 'Notifications');
        document.body.append(box);
      }
      const el = document.createElement('div');
      el.className = 'kb-toast';
      el.dataset.toast = key;
      el.addEventListener('mouseenter', () => clearTimeout(TOASTS.get(key)?.timer));
      el.addEventListener('mouseleave', () => armToast(key));
      t = { el };
      TOASTS.set(key, t);
      box.append(el);
    }
    // Below the top bar, which wraps to two rows on a narrow window.
    const bar = $('.kb-topbar')?.getBoundingClientRect().bottom;
    if (bar) $('#kb-toasts').style.setProperty('--kb-toasts-top', `${Math.round(bar) + 8}px`);
    t.sticky = sticky;
    t.el.dataset.tone = tone;
    t.el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    const heading = document.createElement('strong');
    heading.className = 'kb-toast-title';
    heading.textContent = title;
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'btn kb-toast-close'; close.dataset.variant = 'ghost'; close.dataset.size = 'icon-sm';
    close.dataset.action = 'dismiss-toast'; close.dataset.toast = key; close.setAttribute('aria-label', 'Dismiss'); close.textContent = '×';
    const parts = [heading, close];
    if (text) {
      const body = document.createElement('p');
      body.className = 'kb-toast-text';
      body.textContent = text;
      parts.push(body);
    }
    if (action) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn'; button.dataset.size = 'sm'; button.dataset.variant = 'outline';
      button.dataset.action = action.action; button.textContent = action.label;
      if (action.id) button.dataset.change = action.id;
      parts.push(button);
    }
    t.el.replaceChildren(...parts);
    armToast(key);
  }

  function armToast(key) {
    const t = TOASTS.get(key);
    if (!t) return;
    clearTimeout(t.timer);
    if (!t.sticky) t.timer = setTimeout(() => dismissToast(key), TOAST_MS);
  }

  function dismissToast(key) {
    const t = TOASTS.get(key);
    if (!t) return;
    clearTimeout(t.timer);
    t.el.remove();
    TOASTS.delete(key);
  }

  // A problem's toast, while it lasts.
  function problem(key, message, action = null) {
    if (message) notify(key, { title: action ? 'Not delivered' : 'Attention', text: message, tone: 'error', sticky: true, action });
    else { SHOWN.delete(key); dismissToast(key); }
  }

  function syncToasts() {
    const rows = new Map(changeStatuses().map((row) => [row.id, row]));
    // What already waited when the page opened is in the bell's list, not a burst of toasts.
    const opening = !syncToasts.primed && Boolean(S.data);
    if (S.data) syncToasts.primed = true;
    for (const [id, row] of rows) {
      if (!id) continue;
      TRACKED.set(id, row.summary);
      const stuck = row.status === 'Needs resolution';
      const action = LIVE ? { label: 'Cancel', action: 'cancel-change', id } : null;
      if (opening && !stuck) { SHOWN.set(`change:${id}`, JSON.stringify([row.status, row.summary, 'info', action])); continue; }
      notify(`change:${id}`, { title: row.status, text: row.summary, tone: stuck ? 'error' : 'info', sticky: stuck, action });
    }
    const applied = new Set(S.data?.applied || []);
    const cancelled = new Set(S.data?.cancelled || []);
    for (const [id, summary] of TRACKED) {
      if (rows.has(id)) continue;
      TRACKED.delete(id);
      if (applied.has(id)) notify(`change:${id}`, { title: 'Applied', text: summary, tone: 'done' });
      else if (cancelled.has(id)) notify(`change:${id}`, { title: 'Cancelled', text: summary, tone: 'muted' });
      else dismissToast(`change:${id}`);
    }
    problem('problem:connection', S.connectionError);
    problem('problem:delivery', S.deliveryError, { label: 'Retry delivery', action: 'retry-delivery' });
    problem('problem:replay', S.replayError);
    problem('problem:storage', S.storageError);
    problem('problem:cancel', S.cancelError);
  }

  function showDeliveryError() {
    const body = $('#modal-body');
    if (!body) return;
    body.querySelectorAll('.kb-modal-delivery').forEach((el) => el.remove());
    if (!S.deliveryError) return;
    const notice = document.createElement('div');
    notice.className = 'kb-delivery-error kb-modal-delivery';
    notice.setAttribute('role', 'alert');
    const message = document.createElement('p');
    message.textContent = S.deliveryError;
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'btn'; retry.dataset.action = 'retry-delivery';
    retry.textContent = 'Retry delivery';
    notice.append(message, retry);
    body.prepend(notice);
  }

  function showModal(html) {
    $('#modal-body').innerHTML = html;
    // The settings keep one height across their tabs; cards size to their content.
    $('#modal').classList.toggle('kb-settings-modal', S.modal?.kind === 'settings');
    mountRichEditors($('#modal-body'));
    showDeliveryError();
    const d = $('#modal');
    if (!d.open) d.showModal();
  }

  function openCard(id, editing = false) {
    persistDraft();
    const card = S.board.cards.get(Number(id));
    if (!card) return;
    S.modal = { kind: 'card', id: card.id, editing, schema: structuredClone(S.board.config), seen: editing ? editorValues(card) : null, incoming: {} };
    showModal(Mustache.render(T.cardModal, cardView(card, editing), T.partials));
    if (editing) restoreDraft();
    if (!editing && LIVE) bindTaskSortables($('#modal-body'), card.id);
  }

  // A level's document (an initiative or an epic): read-only here; the agent writes them.
  function openDoc(path) {
    persistDraft();
    const text = S.files[path];
    if (text === undefined) return;
    const { meta, body } = parseCard(text);
    const level = S.board.config.levels.find((l) => path.startsWith(`${l.id}/`));
    const hidden = new Set(['id', 'title']);
    S.modal = { kind: 'doc', path };
    showModal(Mustache.render(T.docModal, {
      id: String(meta.id ?? ''), title: String(meta.title ?? path), levelTitle: level?.title || '', path: `.ai/kanban/${path}`,
      status: isEmpty(meta.status) ? '' : String(meta.status), statusColor: `var(--kb-${STATUS_COLORS[meta.status] || 'gray'})`,
      fields: Object.entries(meta).filter(([k, v]) => !hidden.has(k) && k !== 'status' && !isEmpty(v)).map(([k, v]) => ({ label: k, text: (Array.isArray(v) ? v : [v]).join(', ') })),
      bodyHtml: markdown(body, false),
    }, T.partials));
  }

  function openNew(column) {
    persistDraft();
    S.modal = { kind: 'new', schema: structuredClone(S.board.config) };
    showModal(Mustache.render(T.newCard, newCardView(column), T.partials));
    restoreDraft();
    $('#f-title')?.focus();
  }

  function closeModal(saved = false) {
    if (!saved && S.modal?.dirty && !window.confirm('Discard this unsaved draft? Cancel keeps it open.')) return;
    clearDraft();
    S.modal = null;
    $('#modal').close();
  }

  // Deleting asks twice: the Delete button, then this dialog, where the ticket is typed.
  function askDelete(id) {
    const card = S.board.cards.get(id);
    if (!card) return;
    const d = $('#confirm');
    d.innerHTML = `<div>${Mustache.render(T.confirmDelete, { id, ticket: ticketOf(id), title: card.title, path: `.ai/kanban/${card.path}` }, T.partials)}</div>`;
    d.showModal();
    $('#confirm-ticket')?.focus();
  }

  // Incoming values are offered next to each field; typing is never overwritten by polling.
  function editorValues(card) {
    return { title: card.title, column: card.column, body: card.body,
      ...Object.fromEntries(S.board.config.fields.map((f) => [`field:${f.name}`, card.meta[f.name] ?? null])) };
  }

  const sameValue = (a, b) => (isEmpty(a) && isEmpty(b)) || JSON.stringify(a) === JSON.stringify(b);

  function editorControl(key) {
    const name = key.startsWith('field:') ? key.slice(6) : key;
    return $(`[name="${CSS.escape(name)}"]`, $('#card-form'));
  }

  function showIncoming() {
    const form = $('#card-form');
    if (!form || !S.modal?.editing) return;
    form.querySelectorAll('.kb-incoming').forEach((el) => el.remove());
    for (const [key, value] of Object.entries(S.modal.incoming)) {
      const control = editorControl(key);
      if (!control) continue;
      const notice = document.createElement('section');
      notice.className = 'kb-incoming';
      notice.dataset.field = key;
      notice.setAttribute('role', 'status');
      const title = document.createElement('strong');
      title.textContent = 'Incoming edit';
      const preview = document.createElement('pre');
      preview.textContent = isEmpty(value) ? '(empty)' : Array.isArray(value) ? value.join(', ') : String(value);
      notice.append(title, preview);
      const actions = document.createElement('div');
      actions.className = 'kb-incoming-actions';
      notice.append(actions);
      for (const action of ['accept', 'decline']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.dataset.size = 'sm';
        if (action === 'decline') button.dataset.variant = 'outline';
        button.dataset.action = `incoming-${action}`;
        button.dataset.field = key;
        button.textContent = action === 'accept' ? 'Accept' : 'Decline';
        actions.append(button);
      }
      (control.closest('.field, .kb-editor') || control.parentElement).append(notice);
    }
    if (S.modal.deleted) {
      const notice = document.createElement('p');
      notice.className = 'kb-incoming';
      notice.setAttribute('role', 'alert');
      notice.textContent = 'This card was deleted elsewhere. Your draft is still here to copy; close it when finished.';
      form.prepend(notice);
    }
    const save = $('[type="submit"][form="card-form"]');
    if (save) save.disabled = S.modal.schemaChanged || S.modal.deleted || Object.keys(S.modal.incoming).length > 0;
  }

  function resolveIncoming(key, acceptValue) {
    if (!S.modal?.editing || !(key in S.modal.incoming)) return;
    const value = S.modal.incoming[key];
    const control = editorControl(key);
    if (acceptValue && control) {
      const field = key.startsWith('field:') && S.board.config.fields.find((f) => f.name === key.slice(6));
      if (field?.kind === 'multiselect') {
        const selected = (Array.isArray(value) ? value : []).map(String);
        for (const value of selected) if (![...$('#card-form').querySelectorAll(`[name="${CSS.escape(field.name)}"]`)].some(el => el.value === value)) {
          const label = document.createElement('label');
          const input = document.createElement('input'); input.type = 'checkbox'; input.name = field.name; input.value = value;
          label.append(input, document.createTextNode(` ${value} (existing value)`));
          (control.closest('.field') || control.parentElement).append(label);
        }
        $('#card-form').querySelectorAll(`[name="${CSS.escape(field.name)}"]`).forEach((el) => { el.checked = selected.includes(el.value); });
      } else {
        const text = isEmpty(value) ? '' : Array.isArray(value)
          ? value.map((v) => field?.kind === 'cards' ? ticketOf(v) : String(v)).join(', ') : String(value);
        if (control.tagName === 'SELECT' && ![...control.options].some((o) => o.value === text)) {
          control.add(new Option(text, text));
        }
        control.value = text;
        if (key === 'body') loadRich(control, text);
      }
    }
    delete S.modal.incoming[key];
    S.modal.dirty = true; persistDraft();
    showIncoming();
  }

  function refreshModal() {
    if (S.modal?.kind === 'settings') { refreshSettings(); return; }
    if (S.modal?.kind === 'doc') { if ($('#modal').open && S.files[S.modal.path] !== undefined) openDoc(S.modal.path); return; }
    if (S.modal?.schema && !sameValue(S.modal.schema, S.board.config)) showSchemaNotice();
    if (!S.modal || S.modal.kind !== 'card' || !$('#modal').open) return;
    const card = S.board.cards.get(S.modal.id);
    if (S.modal.editing) {
      S.modal.deleted = !card;
      if (card) {
        const current = editorValues(card);
        for (const [key, value] of Object.entries(current)) {
          if (!sameValue(value, S.modal.seen[key])) S.modal.incoming[key] = value;
        }
        S.modal.seen = current;
      }
      showIncoming();
    } else if (card) openCard(S.modal.id);
    else closeModal();
  }

  // ---------------------------------------------------------------- board settings

  // The settings editor works on a draft of board.yml: typing changes the draft, and adding,
  // removing or reordering re-renders the modal from it. Saving validates it and sends one
  // `config` change.
  const KINDS = ['select', 'multiselect', 'text', 'list', 'number', 'date', 'cards'];
  const TABS = ['general', 'columns', 'fields', 'template'];

  function openSettings(tab = 'general') {
    persistDraft();
    const c = S.board.config;
    const counts = Object.fromEntries(S.board.columns.map((col) => [col.id, col.cards.length]));
    S.settings = {
      tab,
      errors: [],
      palette: null,
      sourceFiles: { ...S.files },
      incoming: {},
      seenConfig: structuredClone(c),
      draft: {
        name: c.name,
        key: c.key,
        columns: c.columns.map((col) => ({ id: col.id, title: col.title, existing: true, count: counts[col.id] || 0 })),
        fields: c.fields.map((f) => ({ ...f, existing: true, options: f.options.map((o) => ({ ...o })) })),
        template: c.template,
      },
    };
    S.modal = { kind: 'settings' };
    renderSettings();
    restoreDraft();
  }

  function settingsView() {
    const { draft, tab, errors, palette } = S.settings;
    return {
      tabs: Object.fromEntries(TABS.map((t) => [t, t === tab])),
      tabList: TABS.map((t) => ({ id: t, title: t[0].toUpperCase() + t.slice(1), selected: t === tab })),
      errors,
      name: draft.name,
      key: draft.key,
      columns: draft.columns.map((col, i) => ({ ...col, i, removable: !col.existing || col.count === 0 })),
      fields: draft.fields.map((f, i) => ({
        i,
        name: f.name,
        label: f.label,
        help: f.help,
        tile: Boolean(f.tile),
        marker: Boolean(f.marker),
        scope: Boolean(f.scope),
        isSelect: f.kind === 'select',
        existing: f.existing,
        kinds: KINDS.map((k) => ({ k, selected: k === (f.kind || 'text') })),
        hasOptions: ['select', 'multiselect'].includes(f.kind),
        options: (f.options || []).map((o, j) => ({
          i,
          j,
          value: o.value,
          label: o.label || '',
          color: o.color || '',
          css: colorOf(o.color),
          paletteOpen: palette === `${i}.${j}`,
          palette: PALETTE.map((name) => ({ i, j, name, css: `var(--kb-${name})`, selected: name === o.color })),
        })),
      })),
      body: draft.template,
      bind: 'template',
    };
  }

  function renderSettings() {
    const top = $('#modal .kb-modal-body')?.scrollTop || 0;
    showModal(Mustache.render(T.settings, settingsView(), T.partials));
    const body = $('#modal .kb-modal-body');
    if (body) body.scrollTop = top;
    const reorder = (list, from, to) => list.splice(to, 0, ...list.splice(from, 1));
    const sortable = (el, list) =>
      Sortable.create(el, {
        handle: '.kb-grip',
        animation: 150,
        ghostClass: 'kb-ghost',
        onEnd: (e) => {
          if (e.oldIndex === e.newIndex) return;
          reorder(list(), e.oldIndex, e.newIndex);
          S.settings.palette = null;
          S.modal.dirty = true; persistDraft();
          renderSettings();
        },
      });
    document.querySelectorAll('#modal [data-list="columns"]').forEach((el) => sortable(el, () => S.settings.draft.columns));
    document.querySelectorAll('#modal [data-list="fields"]').forEach((el) => sortable(el, () => S.settings.draft.fields));
    document.querySelectorAll('#modal [data-list="options"]').forEach((el) =>
      sortable(el, () => S.settings.draft.fields[Number(el.dataset.i)].options));
    refreshSettings();
  }

  // Sets `path` ("fields.2.options.1.label") in the draft.
  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    for (const k of keys) obj = obj[k];
    obj[last] = value;
  }

  function validateSettings(d) {
    const errors = [];
    if (!String(d.name || '').trim()) errors.push('The board needs a name.');
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(d.key || '')) errors.push('The ticket key is one to ten capitals or digits, starting with a capital (APP, OPS).');
    const ids = d.columns.map((c) => c.id);
    if (!d.columns.length) errors.push('The board needs a column.');
    d.columns.forEach((c, i) => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id || '')) errors.push(`Column ${i + 1}'s folder is lowercase letters, digits and dashes.`);
      if (!String(c.title || '').trim()) errors.push(`Column ${i + 1} needs a title.`);
    });
    if (new Set(ids).size !== ids.length) errors.push('Two columns share a folder.');
    const names = d.fields.map((f) => f.name);
    d.fields.forEach((f, i) => {
      const at = f.label || f.name || `Field ${i + 1}`;
      if (!/^[a-z_][a-z0-9_]*$/.test(f.name || '')) errors.push(`${at}: the name (its front matter key) is lowercase letters, digits and underscores.`);
      if (['id', 'title', 'created'].includes(f.name)) errors.push(`${at}: "${f.name}" is taken by the card itself.`);
      if (['select', 'multiselect'].includes(f.kind)) {
        const values = (f.options || []).map((o) => String(o.value || '').trim());
        if (!values.length) errors.push(`${at}: a ${f.kind} needs options.`);
        if (values.some((v) => !v)) errors.push(`${at}: every option needs a value.`);
        if (new Set(values).size !== values.length) errors.push(`${at}: two options share a value.`);
      }
    });
    if (new Set(names).size !== names.length) errors.push('Two fields share a name.');
    return errors;
  }

  function saveSettings() {
    if (Object.keys(S.settings.incoming || {}).length) return;
    const d = S.settings.draft;
    const errors = validateSettings(d);
    for (const col of S.board.columns) {
      if (col.cards.length && !d.columns.some((c) => c.id === col.id)) errors.push(`${col.title} now contains cards. Move them out before removing the column.`);
    }
    if (errors.length) {
      S.settings.errors = errors;
      renderSettings();
      return;
    }
    const board = {
      name: d.name.trim(),
      key: d.key,
      columns: d.columns.map((c) => ({ id: c.id, title: c.title.trim() })),
      fields: d.fields.map(({ existing, ...f }) => ({
        ...f,
        options: ['select', 'multiselect'].includes(f.kind)
          ? f.options.map((o) => Object.fromEntries(Object.entries({ ...o, value: String(o.value).trim(), label: (o.label || '').trim() }).filter(([, v]) => !isEmpty(v))))
          : [],
      })),
      template: d.template,
      levels: S.board.config.levels,
    };
    const migrations = reviewMigrations(board);
    if (migrations === null) return;
    const sourceFiles = S.settings.sourceFiles;
    commit('config', { board, migrations }, 'Edit the board settings', sourceFiles);
    closeModal(true);
    S.settings = null;
  }

  function settingsAction(action, el) {
    const d = S.settings.draft;
    const i = Number(el.dataset.i);
    const j = Number(el.dataset.j);
    switch (action) {
      case 'settings-tab':
        S.settings.tab = el.dataset.tab;
        break;
      case 'settings-add-column':
        d.columns.push({ id: '', title: '', existing: false, count: 0 });
        break;
      case 'settings-remove-column':
        d.columns.splice(i, 1);
        break;
      case 'settings-add-field':
        d.fields.push({ name: '', label: '', kind: 'select', options: [], existing: false });
        break;
      case 'settings-remove-field':
        d.fields.splice(i, 1);
        break;
      case 'settings-add-option':
        d.fields[i].options = [...(d.fields[i].options || []), { value: '', label: '', color: '' }];
        break;
      case 'settings-remove-option':
        d.fields[i].options.splice(j, 1);
        break;
      case 'settings-color':
        S.settings.palette = S.settings.palette === `${i}.${j}` ? null : `${i}.${j}`;
        break;
      case 'settings-pick':
        d.fields[i].options[j].color = el.dataset.color;
        S.settings.palette = null;
        break;
      case 'settings-save':
        return saveSettings();
      default:
        return;
    }
    renderSettings();
  }

  // Drafts are per tab and board, like the outbox. Keep the schema that rendered the form.
  const draftKey = () => `${outboxKey()}:draft:${S.modal?.kind}:${S.modal?.id || 'new'}`;
  function formSnapshot() {
    const form = $('#card-form') || $('#new-card-form');
    return form ? [...form.elements].filter(e => e.name).map(e => ({ name: e.name, value: e.value, checked: e.checked, type: e.type })) : [];
  }
  function fillSnapshot(values) {
    const form = $('#card-form') || $('#new-card-form');
    if (!form) return;
    for (const old of values || []) {
      const controls = [...form.elements].filter(e => e.name === old.name);
      for (const e of controls) {
        if (e.type === 'checkbox' || e.type === 'radio') { if (e.value === old.value) e.checked = old.checked; }
        else { if (['number', 'date'].includes(e.type)) e.type = 'text'; if (e.tagName === 'SELECT' && ![...e.options].some(o => o.value === old.value)) e.add(new Option(`${old.value} (draft value)`, old.value)); e.value = old.value; if (RICH.has(e)) loadRich(e, old.value); }
      }
    }
  }
  function persistDraft() {
    if (!S.modal?.dirty) return;
    try {
      sessionStorage.setItem(draftKey(), JSON.stringify({ modal: S.modal, settings: S.settings, values: formSnapshot() }));
    } catch { S.storageError = 'Draft storage is unavailable. Keep this page open until you save.'; }
  }
  function clearDraft() {
    try { sessionStorage.removeItem(draftKey()); } catch {}
    if (S.modal) S.modal.dirty = false;
  }
  function restoreDraft() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey()) || 'null');
      if (!saved) return;
      S.modal = saved.modal;
      if (saved.settings && S.modal.kind === 'settings') { S.settings = saved.settings; renderSettings(); }
      else {
        const current = S.board.config;
        S.board.config = saved.modal.schema || current;
        const card = S.board.cards.get(S.modal.id);
        if (S.modal.kind === 'new') showModal(Mustache.render(T.newCard, newCardView(), T.partials));
        else if (card) showModal(Mustache.render(T.cardModal, cardView(card, true), T.partials));
        S.board.config = current;
        fillSnapshot(saved.values);
      }
      const notice = document.createElement('p'); notice.className = 'kb-incoming';
      notice.textContent = 'Unsaved draft restored. Save it or close to discard it.';
      $('#modal-body').prepend(notice);
      refreshModal();
    } catch { S.storageError = 'The saved draft could not be restored. Its stored copy has been retained.'; }
  }

  function decisionNotice(label, value, resolve) {
    const box = document.createElement('section'); box.className = 'kb-incoming'; box.setAttribute('role', 'status');
    const title = document.createElement('strong'); title.textContent = label;
    const preview = document.createElement('pre'); preview.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const actions = document.createElement('div'); actions.className = 'kb-incoming-actions';
    for (const choice of ['Accept', 'Decline']) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = choice;
      button.addEventListener('click', () => resolve(choice === 'Accept'));
      actions.append(button);
    }
    box.append(title, preview, actions); return box;
  }
  function refreshSettings() {
    const st = S.settings;
    if (!st) return;
    const current = S.board.config;
    for (const key of ['name', 'key', 'columns', 'fields', 'template']) {
      if (!sameValue(current[key], st.seenConfig[key])) st.incoming[key] = structuredClone(current[key]);
    }
    st.seenConfig = structuredClone(current);
    $('#modal-body').querySelectorAll('.kb-settings-incoming').forEach(e => e.remove());
    for (const [key, value] of Object.entries(st.incoming)) {
      const box = decisionNotice(`Incoming settings: ${key}`, value, accept => {
        if (accept) {
          st.draft[key] = structuredClone(value);
          if (key === 'fields') st.draft.fields.forEach(f => { f.existing = true; });
          if (key === 'columns') st.draft.columns.forEach(c => { c.existing = true; c.count = S.board.columns.find(col => col.id === c.id)?.cards.length || 0; });
        }
        delete st.incoming[key];
        if (!Object.keys(st.incoming).length) st.sourceFiles = { ...S.files };
        S.modal.dirty = true;
        renderSettings(); refreshSettings(); persistDraft();
      });
      box.classList.add('kb-settings-incoming');
      ($('#modal .kb-modal-body') || $('#modal-body')).prepend(box);
    }
    const save = $('[data-action="settings-save"]');
    if (save) save.disabled = Boolean(Object.keys(st.incoming).length);
  }
  function showSchemaNotice() {
    S.modal.schemaChanged = true;
    if ($('#schema-notice')) return;
    const box = document.createElement('section'); box.id = 'schema-notice'; box.className = 'kb-incoming';
    box.textContent = 'Board fields or columns changed while this draft was open. Reload the editor to use the new settings; your text will be retained. Removed fields remain in the saved draft until resolved.';
    const button = document.createElement('button'); button.className = 'btn'; button.type = 'button'; button.textContent = 'Review updated fields';
    button.onclick = () => {
      const values = formSnapshot(), old = S.modal, original = readFields($('#card-form') || $('#new-card-form')).fields;
      clearDraft();
      if (old.kind === 'new') openNew(); else openCard(old.id, true);
      fillSnapshot(values);
      S.modal.dirty = true;
      // Retain controls that disappeared until the user explicitly keeps or discards their values.
      const form = $('#card-form') || $('#new-card-form');
      const removed = values.filter(v => ![...form.elements].some(e => e.name === v.name));
      S.modal.orphaned = old.orphaned || {};
      for (const v of removed) S.modal.orphaned[v.name] = original[v.name];
      persistDraft();
      const info = document.createElement('p'); info.className = 'kb-incoming';
      info.textContent = 'Draft retained. Review the updated fields before saving. Values for removed fields are preserved on the card.';
      $('#modal-body').prepend(info);
    };
    box.append(button); ($('#modal .kb-modal-body') || $('#modal-body')).prepend(box);
    const submit = $('[type="submit"][form="card-form"]') || $('[type="submit"][form="new-card-form"]');
    if (submit) submit.disabled = true;
  }

  function migrationValue(field, text) {
    if (!field) return undefined;
    if (field.kind === 'multiselect' || field.kind === 'list') return text.split(',').map(v => v.trim()).filter(Boolean);
    if (field.kind === 'cards') {
      if (!/^\s*(?:\d+(?:\s*,\s*\d+)*)?\s*$/.test(text)) throw new Error('Use comma-separated ticket numbers.');
      return text.trim() ? text.split(',').map(Number) : [];
    }
    if (field.kind === 'number') { if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('Enter a valid number.'); return Number(text); }
    if (field.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Use a date in YYYY-MM-DD format.');
    return text;
  }
  function reviewMigrations(board) {
    const rows = [];
    for (const previous of S.board.config.fields) {
      const field = board.fields.find(f => f.name === previous.name);
      for (const card of S.board.cards.values()) {
        const value = card.meta[previous.name];
        if (isEmpty(value)) continue;
        const invalidOption = field && ['select', 'multiselect'].includes(field.kind) && (Array.isArray(value) ? value : [value]).some(v => !field.options.some(o => String(o.value) === String(v)));
        if (!field || field.kind !== previous.kind || (invalidOption && !sameValue(previous.options, field.options))) rows.push({ card: card.id, field: previous.name, before: value, target: field });
      }
    }
    if (!rows.length) return [];
    const signature = JSON.stringify({ board, rows });
    const oldPanel = $('#migration-review');
    if (oldPanel?.dataset.signature === signature) {
      const migrations = [];
      try {
        rows.forEach((row, i) => {
          const control = oldPanel.querySelector(`[data-migration="${i}"]`);
          if (!row.target && !control.checked) throw new Error('Confirm removal for each affected card, or preserve its field.');
          const value = row.target ? migrationValue(row.target, control.value) : undefined;
          if (row.target && ['select', 'multiselect'].includes(row.target.kind) && (Array.isArray(value) ? value : [value]).some(v => !row.target.options.some(o => o.value === v))) throw new Error('Choose values from the new options.');
          migrations.push({ card: row.card, field: row.field, before: row.before, value, remove: !row.target });
        });
      } catch (error) { oldPanel.querySelector('[role="alert"]').textContent = error.message; return null; }
      return migrations;
    }
    oldPanel?.remove();
    const panel = document.createElement('section'); panel.id = 'migration-review'; panel.className = 'kb-incoming'; panel.dataset.signature = signature;
    const title = document.createElement('h3'); title.textContent = 'Review affected cards before saving'; panel.append(title);
    const help = document.createElement('p'); help.textContent = 'Choose replacement values, confirm removals, or preserve the original field. Save again to apply settings and these migrations together.'; panel.append(help);
    const error = document.createElement('p'); error.setAttribute('role', 'alert'); panel.append(error);
    rows.forEach((row, i) => {
      const label = document.createElement('label'); label.className = 'field'; label.textContent = `${ticketOf(row.card)} · ${row.field}: ${JSON.stringify(row.before)} → `;
      const input = document.createElement('input'); input.dataset.migration = i;
      input.type = row.target ? 'text' : 'checkbox';
      if (row.target) { input.value = Array.isArray(row.before) ? row.before.join(', ') : String(row.before); input.setAttribute('aria-label', `${ticketOf(row.card)} ${row.field} replacement`); }
      else input.setAttribute('aria-label', `Remove ${row.field} from ${ticketOf(row.card)}`);
      label.append(input);
      if (row.target?.options.length) label.append(document.createTextNode(` Options: ${row.target.options.map(o => o.value).join(', ')}`));
      panel.append(label);
    });
    for (const name of new Set(rows.map(r => r.field))) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = `Preserve ${name}`;
      button.onclick = () => {
        const field = structuredClone(S.board.config.fields.find(f => f.name === name)); field.existing = true;
        const index = S.settings.draft.fields.findIndex(f => f.name === name);
        if (index < 0) S.settings.draft.fields.push(field); else S.settings.draft.fields[index] = field;
        S.modal.dirty = true; persistDraft(); renderSettings(); refreshSettings();
      }; panel.append(button);
    }
    ($('#modal .kb-modal-body') || $('#modal-body')).prepend(panel); return null;
  }

  // ---------------------------------------------------------------- forms

  function readFields(form) {
    const data = new FormData(form);
    const out = { ...(S.modal?.orphaned || {}) };
    for (const f of (S.modal?.schema || S.board.config).fields) {
      if (f.kind === 'multiselect') out[f.name] = data.getAll(f.name).map(String);
      else {
        const raw = String(data.get(f.name) ?? '').trim();
        if (f.kind === 'list') out[f.name] = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        else if (f.kind === 'cards') out[f.name] = [...raw.matchAll(/\d+/g)].map((m) => Number(m[0]));
        else if (f.kind === 'number') {
          const original = S.board.cards.get(S.modal?.id)?.meta[f.name];
          out[f.name] = raw === String(original) ? original : raw === '' ? null : Number(raw);
        }
        else out[f.name] = raw;
      }
    }
    return { title: String(data.get('title') || '').trim(), column: String(data.get('column') || ''), body: String(data.get('body') || ''), fields: out };
  }

  function validateFormFields(form, fields) {
    form.querySelector('.kb-value-error')?.remove();
    const invalid = Object.entries(fields).find(([, value]) => typeof value === 'number' && !Number.isFinite(value));
    if (!invalid) return true;
    const error = document.createElement('p'); error.className = 'kb-incoming kb-value-error'; error.setAttribute('role', 'alert');
    error.textContent = `${invalid[0]} needs a valid number.`; form.prepend(error); return false;
  }

  function saveCard(form) {
    if (S.modal?.schemaChanged || S.modal?.deleted || Object.keys(S.modal?.incoming || {}).length) return;
    const id = Number(form.dataset.id);
    const { title, column, body, fields } = readFields(form);
    if (!title || !validateFormFields(form, fields)) return;
    clearDraft();
    S.modal = { kind: 'card', id, editing: false };
    commit('save', { card: id, title, column, fields, body }, `Edit ${ticketOf(id)}: ${title}`);
    openCard(id);
  }

  async function createCard(form) {
    if (form.dataset.submitting || S.modal?.schemaChanged) return;
    const { title, column, body, fields } = readFields(form);
    if (!title || !validateFormFields(form, fields)) return;
    form.dataset.submitting = 'true';
    // Reuse the reservation on retry, even if the response was lost after allocation.
    const requestId = form.dataset.requestId || (form.dataset.requestId = uid());
    const submit = $('[type="submit"][form="new-card-form"]');
    if (submit) submit.disabled = true;
    try {
      const { card: id } = await post('api/reserve-id', { id: requestId });
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('The server returned an invalid ticket number');
      const created = new Date().toISOString().slice(0, 10);
      const col = S.board.columns.find((c) => c.id === column);
      commit('create', { id: requestId, card: id, title, column, fields, body, created }, `New card ${ticketOf(id)} in ${col ? col.title : column}: ${title}`);
      if ($('#new-card-form') === form) closeModal(true);
    } catch (error) {
      let notice = $('.kb-create-error', form);
      if (!notice) {
        notice = document.createElement('p'); notice.className = 'kb-create-error kb-incoming';
        notice.setAttribute('role', 'alert'); form.prepend(notice);
      }
      notice.textContent = `Card not created: ${error.message}. Your draft is retained; try Create again.`;
    } finally {
      delete form.dataset.submitting;
      if (submit) submit.disabled = false;
    }
  }

  // ---------------------------------------------------------------- events

  document.addEventListener('click', (e) => {
    // A click on a backdrop (the dialog itself, outside its content) closes it.
    if (e.target === $('#modal')) {
      closeModal();
      return;
    }
    if (e.target === $('#confirm')) {
      $('#confirm').close();
      return;
    }
    if (S.bellOpen && !e.target.closest('.kb-bell')) {
      S.bellOpen = false;
      render();
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'filter' || (action === 'toggle-task' && e.target !== el)) return;
    if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
    if (action.startsWith('settings')) {
      if (S.modal) S.modal.dirty = true;
      if (action === 'settings') openSettings();
      else if (S.settings) settingsAction(action, el);
      persistDraft();
      return;
    }
    switch (action) {
      case 'retry-delivery':
        void sendPending();
        break;
      case 'cancel-change':
        void cancelChange(el.dataset.change);
        break;
      case 'confirm-cancel':
        $('#confirm').close();
        cancelNow(el.dataset.changes.split(' ')).catch(cancelFailed);
        break;
      case 'dismiss-toast':
        dismissToast(el.dataset.toast);
        break;
      case 'bell':
        S.bellOpen = !S.bellOpen;
        render();
        break;
      case 'bell-clear':
        S.history = [];
        render();
        break;
      case 'incoming-accept':
      case 'incoming-decline':
        resolveIncoming(el.dataset.field, action === 'incoming-accept');
        break;
      case 'open-card':
        openCard(el.dataset.id);
        break;
      case 'open-doc':
        openDoc(el.dataset.path);
        break;
      case 'toggle-node':
        toggleNode(el.dataset.path, el.getAttribute('aria-expanded') !== 'true');
        break;
      case 'toggle-lane':
        toggleLane(el.dataset.lane, el.getAttribute('aria-expanded') !== 'true');
        break;
      case 'view': {
        S.view = el.dataset.view === 'outline' ? 'outline' : 'board';
        const url = new URL(location.href);
        if (S.view === 'outline') url.searchParams.set('view', 'outline');
        else url.searchParams.delete('view');
        history.replaceState(history.state, '', url);
        render();
        break;
      }
      case 'edit-card':
        openCard(el.dataset.id, true);
        break;
      case 'new-card':
        openNew(el.dataset.column);
        break;
      case 'close':
        if (el.closest('#confirm')) $('#confirm').close();
        else closeModal();
        break;
      case 'delete-card':
        askDelete(Number(el.dataset.id));
        break;
      case 'confirm-delete': {
        const id = Number(el.dataset.id);
        const card = S.board.cards.get(id);
        if (!card || $('#confirm-ticket').value.trim().toUpperCase() !== ticketOf(id).toUpperCase()) return;
        commit('delete', { card: id }, `Delete ${ticketOf(id)}: ${card.title}`);
        $('#confirm').close();
        closeModal();
        break;
      }
      case 'toggle-task': {
        const id = Number(el.closest('[data-card]').dataset.card);
        const n = Number(el.dataset.task);
        commit('task', { card: id, task: n }, `${el.checked ? 'Tick' : 'Untick'} a checklist item on ${ticketOf(id)}`);
        openCard(id);
        break;
      }
      case 'theme': {
        const dark = !document.documentElement.classList.contains('dark');
        document.documentElement.classList.toggle('dark', dark);
        try {
          localStorage.setItem('kanban-theme', dark ? 'dark' : 'light');
        } catch {}
        break;
      }
    }
  });

  window.addEventListener('resize', updateHeaderCounts);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.bellOpen) {
      S.bellOpen = false;
      render();
      $('[data-action="bell"]')?.focus();
      return;
    }
    if (e.key === 'Enter' && e.target.matches?.('.kb-tile')) openCard(e.target.dataset.id);
  });

  // Typing in the settings editor changes its draft; a new kind re-renders it (options appear
  // or go).
  function bindSetting(e) {
    const bind = e.target.dataset?.bind;
    if (!bind || !S.settings) return false;
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setPath(S.settings.draft, bind, bind === 'key' ? value.toUpperCase() : value);
    S.modal.dirty = true;
    persistDraft();
    if (e.type === 'change' && bind.endsWith('.kind')) renderSettings();
    return true;
  }
  document.addEventListener('change', bindSetting);
  document.addEventListener('change', (e) => {
    if (e.target.dataset?.action !== 'scope') return;
    S.scope = e.target.value;
    const url = new URL(location.href);
    url.searchParams.set('scope', S.scope);
    history.replaceState(history.state, '', url);
    render();
  });
  for (const name of ['input', 'change']) document.addEventListener(name, event => {
    if (event.target.closest('#modal') && (S.modal?.editing || S.modal?.kind === 'new')) {
      S.modal.dirty = true; persistDraft();
    }
  });
  $('#modal').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });

  document.addEventListener('input', (e) => {
    if (bindSetting(e)) return;
    if (e.target.dataset?.action === 'filter') {
      S.query = e.target.value;
      applyFilter();
    }
    if (e.target.id === 'confirm-ticket') {
      const want = e.target.dataset.ticket.toUpperCase();
      $('[data-action="confirm-delete"]').disabled = e.target.value.trim().toUpperCase() !== want;
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    e.preventDefault();
    if (form.dataset.action === 'save-card') saveCard(form);
    else if (form.dataset.action === 'create-card') createCard(form);
  });

  // The close event comes a moment after close(): by then another modal may have opened.
  $('#modal').addEventListener('close', () => {
    if ($('#modal').open) return;
    S.modal = null;
    S.settings = null;
  });

  // ---------------------------------------------------------------- start

  // Links to a card: #KEY-12 opens it, #KEY-12/edit its editor, #new the New card modal.
  function followHash() {
    if (!S.board) return;
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === 'new') return LIVE && openNew();
    const m = new RegExp(`^${S.board.config.key}-(\\d+)(/edit)?$`).exec(h);
    if (m) openCard(m[1], Boolean(m[2]) && LIVE);
  }
  window.addEventListener('hashchange', followHash);
  window.addEventListener('beforeunload', (event) => {
    persistDraft();
    if (S.modal?.dirty || S.pending.some((c) => S.delivery[c.id] !== 'queued')) { event.preventDefault(); event.returnValue = ''; }
  });

  if (window.KANBAN_DATA) accept(window.KANBAN_DATA);
  else render();
  setInterval(poll, POLL_MS);

  // For tests and for poking at the board from the console.
  window.kanban = { mergeMarkdown, rich: (textarea) => RICH.get(textarea)?.editor, state: S, buildBoard, render, inScope, scopeValue, markdown, dropIndex, openDoc, toggleLane, toggleNode, parseCard, serializeCard, serializeBoard, normalizeConfig, tasks, toggleTask, moveTask, applyChange, openCard, openNew, openSettings, commit, accept, poll, sendPending, cancelChange, updateHeaderCounts, toasts: TOASTS, TOAST_MS, LIVE };
})();
