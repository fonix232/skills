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
 * Nothing here writes a file. A change made on the page (dragging a card, editing one,
 * creating one, ticking or reordering a criterion or task) is applied to the page's own copy
 * at once and sent to the board's static server as GET .changes/<base64url JSON>. The server
 * answers 404 and logs the request: that log is the queue the agent applies to the Markdown.
 * A change carries what it means (op and its fields, a one-line summary) and the files it
 * results in (`writes`, `deletes`) from the version it was made on (`base`), so the agent can
 * write them as they are when nothing else changed in between. It shows as pending until
 * data.js lists its id in `applied`.
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
    modal: null, // { kind: 'card', id, editing } or { kind: 'new' }
    sortables: [],
    followed: false,
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

  function base64url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Applies a change on the page and hands it to the agent.
  function commit(op, fields, summary) {
    if (!LIVE) return;
    const c = { id: uid(), at: new Date().toISOString(), base: S.data?.version ?? null, op, summary, ...fields };
    const before = S.files;
    const after = applyChange(before, c);
    c.writes = {};
    c.deletes = [];
    for (const [p, t] of Object.entries(after)) if (before[p] !== t) c.writes[p] = t;
    for (const p of Object.keys(before)) if (!(p in after)) c.deletes.push(p);
    if (!Object.keys(c.writes).length && !c.deletes.length) return;
    S.pending.push(c);
    S.files = after;
    S.board = buildBoard(after);
    render();
    const url = new URL(`.changes/${base64url(JSON.stringify(c))}`, location.href);
    fetch(url, { cache: 'no-store' }).catch(() => {});
    window.dispatchEvent(new CustomEvent('kanban:change', { detail: c }));
  }

  // ---------------------------------------------------------------- data from the agent

  function accept(data) {
    S.data = data;
    const applied = new Set(data.applied || []);
    S.pending = S.pending.filter((c) => !applied.has(c.id));
    let files = { ...(data.files || {}) };
    for (const c of S.pending) files = applyChange(files, c);
    S.files = files;
    S.board = buildBoard(files);
    render();
    refreshModal();
    if (!S.followed) {
      S.followed = true;
      followHash();
    }
  }

  function poll() {
    const s = document.createElement('script');
    s.src = `data.js?t=${Date.now()}`;
    s.onload = s.onerror = () => {
      s.remove();
      const d = window.KANBAN_DATA;
      if (d && d.version !== S.data?.version) accept(d);
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
      marker: marker.color,
      markerLabel: marker.label,
    };
  }

  function dashboardView() {
    const c = S.board.config;
    return {
      name: c.name,
      key: c.key,
      query: S.query,
      editable: LIVE,
      pending: { count: S.pending.length, list: S.pending.map((p) => ({ summary: p.summary })) },
      columns: S.board.columns.map((col) => ({ id: col.id, title: col.title, count: col.cards.length, cards: col.cards.map(tileView) })),
    };
  }

  function fieldInputView(field, value) {
    const values = fieldValues(field, value);
    const kind = field.kind;
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
      options: field.options.map((o) => ({ value: o.value, label: o.label || o.value, selected: values.includes(o.value) })),
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
      fields: cfg.fields.map((f) => fieldInputView(f, f.default)),
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

  // ---------------------------------------------------------------- rendering

  const $ = (sel, root = document) => root.querySelector(sel);

  function render() {
    const app = $('#app');
    if (!S.board) {
      app.innerHTML = Mustache.render(T.noData, {}, T.partials);
      return;
    }
    const scroll = [...document.querySelectorAll('.kb-cards')].map((el) => [el.dataset.column, el.scrollTop]);
    const boardScroll = $('.kb-board')?.scrollLeft || 0;
    const focused = document.activeElement?.dataset?.action === 'filter';
    app.innerHTML = Mustache.render(T.dashboard, dashboardView(), T.partials);
    for (const [col, top] of scroll) {
      const el = $(`.kb-cards[data-column="${CSS.escape(col)}"]`);
      if (el) el.scrollTop = top;
    }
    if ($('.kb-board')) $('.kb-board').scrollLeft = boardScroll;
    if (focused) {
      const input = $('[data-action="filter"]');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    applyFilter();
    bindSortables();
  }

  function applyFilter() {
    const q = S.query.trim().toLowerCase();
    document.querySelectorAll('.kb-tile').forEach((el) => {
      el.classList.toggle('kb-hidden', q !== '' && !q.split(/\s+/).every((w) => el.dataset.search.includes(w)));
    });
  }

  function bindSortables() {
    S.sortables.forEach((s) => s.destroy());
    S.sortables = [];
    if (!LIVE) return;
    document.querySelectorAll('.kb-cards').forEach((list) => {
      S.sortables.push(
        Sortable.create(list, {
          group: 'cards',
          animation: 150,
          ghostClass: 'kb-ghost',
          chosenClass: 'kb-chosen',
          filter: '.kb-hidden',
          onEnd: (e) => {
            const id = Number(e.item.dataset.id);
            const column = e.to.dataset.column;
            // The index among the column's cards, counting the ones the filter hides.
            const index = [...e.to.children].indexOf(e.item);
            const card = S.board.cards.get(id);
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

  function showModal(html) {
    $('#modal-body').innerHTML = html;
    const d = $('#modal');
    if (!d.open) d.showModal();
  }

  function openCard(id, editing = false) {
    const card = S.board.cards.get(Number(id));
    if (!card) return;
    S.modal = { kind: 'card', id: card.id, editing };
    showModal(Mustache.render(T.cardModal, cardView(card, editing), T.partials));
    if (!editing && LIVE) bindTaskSortables($('#modal-body'), card.id);
  }

  function openNew(column) {
    S.modal = { kind: 'new' };
    showModal(Mustache.render(T.newCard, newCardView(column), T.partials));
    $('#f-title')?.focus();
  }

  function closeModal() {
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

  // New data while a card is open: show the new version, unless it's being edited.
  function refreshModal() {
    if (!S.modal || S.modal.kind !== 'card' || S.modal.editing || !$('#modal').open) return;
    if (S.board.cards.has(S.modal.id)) openCard(S.modal.id);
    else closeModal();
  }

  // ---------------------------------------------------------------- board settings

  // The settings editor works on a draft of board.yml: typing changes the draft, and adding,
  // removing or reordering re-renders the modal from it. Saving validates it and sends one
  // `config` change.
  const KINDS = ['select', 'multiselect', 'text', 'list', 'number', 'date', 'cards'];
  const TABS = ['general', 'columns', 'fields', 'template'];

  function openSettings(tab = 'general') {
    const c = S.board.config;
    const counts = Object.fromEntries(S.board.columns.map((col) => [col.id, col.cards.length]));
    S.settings = {
      tab,
      errors: [],
      palette: null,
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
          renderSettings();
        },
      });
    document.querySelectorAll('#modal [data-list="columns"]').forEach((el) => sortable(el, () => S.settings.draft.columns));
    document.querySelectorAll('#modal [data-list="fields"]').forEach((el) => sortable(el, () => S.settings.draft.fields));
    document.querySelectorAll('#modal [data-list="options"]').forEach((el) =>
      sortable(el, () => S.settings.draft.fields[Number(el.dataset.i)].options));
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
    const d = S.settings.draft;
    const errors = validateSettings(d);
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
    };
    S.settings = null;
    closeModal();
    commit('config', { board }, 'Edit the board settings');
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

  // ---------------------------------------------------------------- forms

  function readFields(form) {
    const data = new FormData(form);
    const out = {};
    for (const f of S.board.config.fields) {
      if (f.kind === 'multiselect') out[f.name] = data.getAll(f.name).map(String);
      else {
        const raw = String(data.get(f.name) ?? '').trim();
        if (f.kind === 'list') out[f.name] = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        else if (f.kind === 'cards') out[f.name] = [...raw.matchAll(/\d+/g)].map((m) => Number(m[0]));
        else if (f.kind === 'number') out[f.name] = raw === '' ? null : Number(raw);
        else out[f.name] = raw;
      }
    }
    return { title: String(data.get('title') || '').trim(), column: String(data.get('column') || ''), body: String(data.get('body') || ''), fields: out };
  }

  function saveCard(form) {
    const id = Number(form.dataset.id);
    const { title, column, body, fields } = readFields(form);
    if (!title) return;
    S.modal = { kind: 'card', id, editing: false };
    commit('save', { card: id, title, column, fields, body }, `Edit ${ticketOf(id)}: ${title}`);
    openCard(id);
  }

  function createCard(form) {
    const { title, column, body, fields } = readFields(form);
    if (!title) return;
    const id = nextId();
    const created = new Date().toISOString().slice(0, 10);
    const col = S.board.columns.find((c) => c.id === column);
    commit('create', { card: id, title, column, fields, body, created }, `New card ${ticketOf(id)} in ${col ? col.title : column}: ${title}`);
    closeModal();
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
    const tab = e.target.closest('.kb-editor [role="tab"]');
    if (tab) {
      const editor = tab.closest('.kb-editor');
      editor.querySelectorAll('[role="tab"]').forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (tab.id === 'tab-preview') $('[data-preview]', editor).innerHTML = markdown($('textarea', editor).value, false);
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'filter' || (action === 'toggle-task' && e.target !== el)) return;
    if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
    if (action.startsWith('settings')) {
      if (action === 'settings') openSettings();
      else if (S.settings) settingsAction(action, el);
      return;
    }
    switch (action) {
      case 'open-card':
        openCard(el.dataset.id);
        break;
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches?.('.kb-tile')) openCard(e.target.dataset.id);
  });

  // Typing in the settings editor changes its draft; a new kind re-renders it (options appear
  // or go).
  function bindSetting(e) {
    const bind = e.target.dataset?.bind;
    if (!bind || !S.settings) return false;
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setPath(S.settings.draft, bind, bind === 'key' ? value.toUpperCase() : value);
    if (e.type === 'change' && bind.endsWith('.kind')) renderSettings();
    return true;
  }
  document.addEventListener('change', bindSetting);

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

  $('#modal').addEventListener('close', () => {
    S.modal = null;
    S.settings = null;
  });

  // ---------------------------------------------------------------- start

  // Links to a card: #KEY-12 opens it, #KEY-12/edit its editor, #new the New card modal.
  function followHash() {
    if (!S.board) return;
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === 'new') return LIVE && openNew();
    const s = /^settings(?:\/(\w+))?$/.exec(h);
    if (s) return LIVE && openSettings(TABS.includes(s[1]) ? s[1] : 'general');
    const m = new RegExp(`^${S.board.config.key}-(\\d+)(/edit)?$`).exec(h);
    if (m) openCard(m[1], Boolean(m[2]) && LIVE);
  }
  window.addEventListener('hashchange', followHash);

  if (window.KANBAN_DATA) accept(window.KANBAN_DATA);
  else render();
  setInterval(poll, POLL_MS);

  // For tests and for poking at the board from the console.
  window.kanban = { state: S, buildBoard, parseCard, serializeCard, serializeBoard, normalizeConfig, tasks, toggleTask, moveTask, applyChange, openCard, openNew, openSettings, commit, accept, LIVE };
})();
