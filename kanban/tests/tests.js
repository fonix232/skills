// The board's tests: run by tests/index.html, on the board in fixture.js. Served over http
// (see README.md), the page can send changes, so the editing checks run too.
(async () => {
  const lines = [];
  let failed = 0;
  let passed = 0;
  const check = (name, ok, detail = '') => {
    lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
    ok ? passed++ : failed++;
  };
  const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  const has = (name, text, part) => check(name, String(text).includes(part), `${JSON.stringify(part)} not in ${JSON.stringify(String(text).slice(0, 400))}`);

  const k = window.kanban;
  const data = window.KANBAN_DATA;
  const files = data.files;
  const ids = (board, col) => board.columns.find((c) => c.id === col).cards.map((c) => c.id);

  // ---- reading the board
  const board = k.buildBoard(files);
  eq('columns come from board.yml', board.columns.map((c) => c.title), ['Ready to start', 'In progress', 'Done']);
  eq('a column follows its order file; unlisted cards go last', ids(board, 'todo'), [2, 1, 4]);
  eq('an empty column', ids(board, 'done'), []);
  const first = board.cards.get(1);
  eq('front matter lists', first.meta.roles, ['router', 'ap']);
  eq('dates stay text', first.meta.created, '2026-09-29');
  has('the body follows the front matter', first.body.slice(0, 40), 'The first card');
  eq('a quoted title', board.cards.get(3).title, 'Third: with a colon');

  // ---- writing a card back
  const order = ['id', 'title', 'type', 'priority', 'roles', 'components', 'depends_on', 'created'];
  const again = k.serializeCard(first.meta, first.body, order);
  has('lists are written inline', again, 'roles: [router, ap]');
  eq('a card survives a round trip', k.parseCard(again), k.parseCard(files['todo/001-first-card.md']));
  has('a title with a colon is quoted', k.serializeCard({ id: 3, title: 'Third: with a colon' }, 'x', order), "title: 'Third: with a colon'");

  // ---- acceptance criteria
  eq('criteria in code blocks are not criteria; tasks count too', k.tasks(first.body).length, 6);
  eq('ticked criteria and tasks', k.tasks(first.body).map((t) => t.done), [true, false, false, false, true, false]);
  eq('each knows its section', k.tasks(first.body).map((t) => t.section), ['Acceptance criteria', 'Acceptance criteria', 'Acceptance criteria', 'Tasks', 'Tasks', 'Tasks']);
  const toggled = k.toggleTask(first.body, 1);
  has('ticking the second criterion', toggled, '- [x] Not yet');
  has('the code block stays', toggled, '- [ ] Not a criterion');

  // ---- reordering criteria and tasks
  const moved = k.moveTask(first.body, 4, 0);
  has('a task moves to the top of its list, with its second line', moved, '## Tasks\n\n- [x] Task two\n  with a second line\n- [ ] Task one\n- [ ] Task three');
  has('and the criteria stay as they were', moved, '- [x] Done already\n- [ ] Not yet');
  const loose = '- [ ] a\n\n- [ ] b\n\n- [ ] c\n\nAfter.';
  eq('a loose list reorders too', k.moveTask(loose, 2, 0), '- [ ] c\n\n- [ ] a\n\n- [ ] b\n\nAfter.');
  const nested = '- [ ] a\n  - [ ] a1\n  - [ ] a2\n- [ ] b';
  eq('a nested item moves within its own list', k.moveTask(nested, 2, 0), '- [ ] a\n  - [ ] a2\n  - [ ] a1\n- [ ] b');
  eq('a parent moves with its children', k.moveTask(nested, 0, 1), '- [ ] b\n- [ ] a\n  - [ ] a1\n  - [ ] a2');

  // ---- changes, as the files they write
  const move = k.applyChange(files, { op: 'move', card: 1, column: 'doing', index: 0 });
  check('a move writes the card in its new column', 'doing/001-first-card.md' in move);
  check('and removes it from the old one', !('todo/001-first-card.md' in move));
  eq('the new column\'s order', ids(k.buildBoard(move), 'doing'), [1, 3]);
  eq('the old column\'s order', ids(k.buildBoard(move), 'todo'), [2, 4]);
  has('order files link the cards', move['doing/_doing.md'], '1. [DEMO-1: First card](001-first-card.md)');

  const reorder = k.applyChange(files, { op: 'move', card: 4, column: 'todo', index: 0 });
  eq('reordering within a column', ids(k.buildBoard(reorder), 'todo'), [4, 2, 1]);

  const save = k.applyChange(files, { op: 'save', card: 2, title: 'Second, renamed', fields: { priority: 'P0', roles: ['switch'], components: [] }, body: 'New body.' });
  const saved = k.parseCard(save['todo/002-second-card.md']);
  eq('a saved card', [saved.meta.title, saved.meta.priority, saved.meta.roles, saved.body.trim()], ['Second, renamed', 'P0', ['switch'], 'New body.']);
  check('empty fields are left out', !('components' in saved.meta));
  has('a new title reaches the order file', save['todo/_todo.md'], 'DEMO-2: Second, renamed');

  const saveMove = k.applyChange(files, { op: 'save', card: 2, title: 'Second card', fields: {}, body: 'Second.', column: 'done' });
  eq('saving with another column moves the card', ids(k.buildBoard(saveMove), 'done'), [2]);

  const create = k.applyChange(files, { op: 'create', card: 5, title: 'A new card!', column: 'done', fields: { type: 'bug' }, body: 'Hi.', created: '2026-09-30' });
  const made = create['done/005-a-new-card.md'];
  check('a new card gets a numbered file named after its title', Boolean(made));
  eq('its front matter', k.parseCard(made).meta, { id: 5, title: 'A new card!', type: 'bug', created: '2026-09-30' });
  has('and a place in its column', create['done/_done.md'], '1. [DEMO-5: A new card!](005-a-new-card.md)');

  const del = k.applyChange(files, { op: 'delete', card: 3 });
  check('a deleted card is gone', !('doing/003-third-card.md' in del));
  has('and so is its line', del['doing/_doing.md'], 'No cards.');

  const reorder2 = k.applyChange(files, { op: 'reorder', card: 1, task: 5, index: 0 });
  has('reordering writes the card', reorder2['todo/001-first-card.md'], '## Tasks\n\n- [ ] Task three\n- [ ] Task one');
  eq('and keeps its front matter', reorder2['todo/001-first-card.md'].split('---')[1], files['todo/001-first-card.md'].split('---')[1]);

  const task = k.applyChange(files, { op: 'task', card: 1, task: 2 });
  has('ticking a criterion writes it', task['todo/001-first-card.md'], '- [x] Last one');
  eq('and leaves the front matter as it was', task['todo/001-first-card.md'].split('---')[1], files['todo/001-first-card.md'].split('---')[1]);

  // ---- board.yml, as the settings editor writes it
  const cfg = k.normalizeConfig(jsyaml.load(files['board.yml'], { schema: jsyaml.CORE_SCHEMA }));
  const written = k.serializeBoard(cfg);
  eq('board.yml survives a round trip', k.normalizeConfig(jsyaml.load(written, { schema: jsyaml.CORE_SCHEMA })), cfg);
  has('options are one line each', written, '      - {value: P0, label: Critical, color: red}');
  has('an option with only a value is just the value', written, '      - P2\n');
  has('columns are one line each', written, '  - {id: todo, title: Ready to start}');
  has('the template is a block', written, 'template: |\n  Describe the card.\n');
  const addColumn = k.applyChange(files, { op: 'config', board: { ...cfg, columns: [...cfg.columns, { id: 'blocked', title: 'Blocked' }] } });
  eq('a new column gets its order file', addColumn['blocked/_blocked.md'], '# Blocked\n\nNo cards.\n');
  const rekey = k.applyChange(files, { op: 'config', board: { ...cfg, key: 'APP' } });
  has('a new key rewrites the order files', rekey['todo/_todo.md'], '1. [APP-2: Second card](002-second-card.md)');
  const drop = k.applyChange(files, { op: 'config', board: { ...cfg, columns: cfg.columns.filter((c) => c.id !== 'todo') } });
  eq('a column with cards can\'t be removed', drop, files);
  const dropEmpty = k.applyChange(files, { op: 'config', board: { ...cfg, columns: cfg.columns.filter((c) => c.id !== 'done') } });
  check('an empty one can, order file and all', !('done/_done.md' in dropEmpty) && !dropEmpty['board.yml'].includes('id: done'));

  // ---- the rich editor: what it didn't change keeps its exact text
  const original = 'An intro naming snake_case.\n\n- one\n  - nested\n- two\n\n\n## Tasks\n\n- [ ] first\n- [x] second\n\nClosing words.\n';
  const host = document.createElement('div');
  document.body.append(host);
  const ed = new toastui.Editor({ el: host, initialValue: original, initialEditType: 'wysiwyg', usageStatistics: false, customMarkdownRenderer: { bulletList: () => ({ delim: '-' }) } });
  const base = ed.getMarkdown();
  ed.destroy();
  host.remove();
  check('the editor writes Markdown its own way', base !== original, 'it wrote the original unchanged');
  eq('an untouched body comes back byte for byte', k.mergeMarkdown(original, base, base), original);
  eq('an edited paragraph is the only change', k.mergeMarkdown(original, base, base.replace('Closing words.', 'Closing words, edited.')), original.replace('Closing words.', 'Closing words, edited.'));
  eq('new blocks come in with - bullets and no escapes', k.mergeMarkdown(original, base, `${base.trimEnd()}\n\nA new\\_name.\n\n* added`), `${original}\nA new_name.\n\n- added\n`);
  eq('a deleted block goes', k.mergeMarkdown(original, base, base.replace(/\n*Closing words\.\n*$/, '')), original.replace('\n\nClosing words.', ''));
  eq('blocks that don\'t line up take the editor\'s text', k.mergeMarkdown('one\n\ntwo', 'one two', '* x'), '- x');

  // ---- the dashboard
  const tiles = (col) => [...document.querySelectorAll(`.kb-cards[data-column="${col}"] .kb-tile`)].map((t) => Number(t.dataset.id));
  eq('tiles in their columns, in order', [tiles('todo'), tiles('doing'), tiles('done')], [[2, 1, 4], [3], []]);
  const tile = document.querySelector('.kb-tile[data-id="1"]');
  eq('a tile\'s badges are its tile fields, by label', [...tile.querySelectorAll('.badge')].map((b) => b.textContent), ['Router', 'ap']);
  eq('a coloured option is a pill in its palette colour', [tile.querySelector('.badge').classList.contains('kb-pill'), tile.querySelector('.badge').style.getPropertyValue('--kb-pill').trim()], [true, 'var(--kb-blue)']);
  check('an option without a colour is a plain badge', !tile.querySelectorAll('.badge')[1].classList.contains('kb-pill'));
  eq('its priority is the marker\'s colour, from the palette', tile.style.getPropertyValue('--kb-marker').trim(), 'var(--kb-red)');
  has('and the marker says which', tile.title, 'Priority: Critical');
  eq('a plain CSS colour still works', document.querySelector('.kb-tile[data-id="2"]').style.getPropertyValue('--kb-marker').trim(), '#ffc53d');
  check('marked tiles have the marker class', tile.classList.contains('kb-marked'));
  const bar = tile.querySelector('.kb-progress');
  eq('a progress bar counts criteria and tasks', [bar && bar.getAttribute('aria-valuenow'), bar && bar.getAttribute('aria-valuemax')], ['2', '6']);
  eq('its width is the share done', bar && bar.querySelector('span').style.width, '33%');
  check('a card without criteria has no bar', !document.querySelector('.kb-tile[data-id="2"] .kb-progress'));
  has('and names what it depends on', tile.textContent, 'Depends on DEMO-2');

  const filter = document.querySelector('[data-action="filter"]');
  filter.value = 'colon';
  filter.dispatchEvent(new Event('input', { bubbles: true }));
  eq('the filter hides what doesn\'t match', [...document.querySelectorAll('.kb-tile:not(.kb-hidden)')].map((t) => Number(t.dataset.id)), [3]);
  filter.value = '';
  filter.dispatchEvent(new Event('input', { bubbles: true }));

  // ---- the card modal
  k.openCard(1);
  const modal = document.getElementById('modal');
  check('a card opens in the modal', modal.open);
  const labels = [...modal.querySelectorAll('.kb-side .kb-fields dt')].map((d) => d.textContent);
  eq('the fields sit in the side column, each by name', labels, ['Status', 'Type', 'Priority', 'Runs on', 'Components', 'Depends on']);
  check('the details are the main column', Boolean(modal.querySelector('.kb-detail > .kb-markdown')));
  eq('progress per section', [...modal.querySelectorAll('.kb-side-progress .flex')].map((d) => [...d.children].map((c) => c.textContent).join(' ')), ['Acceptance criteria 1/3', 'Tasks 1/3']);
  const info = modal.querySelector('.kb-info-pop');
  has('the file is in the info popover', info && info.textContent, '.ai/kanban/todo/001-first-card.md');
  has('with when it was created', info && info.textContent, '2026-09-29');
  check('the file isn\'t shown otherwise', !modal.querySelector('.kb-detail').textContent.includes('001-first-card.md'));
  eq('Delete is red', modal.querySelector('[data-action="delete-card"]')?.dataset.variant, k.LIVE ? 'destructive' : undefined);
  check('Markdown tables render', Boolean(modal.querySelector('.kb-markdown table')));
  check('a ticket number opens its card', Boolean(modal.querySelector('.kb-markdown a[data-action="open-card"][data-id="2"]')));
  eq('criteria and tasks are numbered checkboxes', [...modal.querySelectorAll('.kb-markdown input[type="checkbox"]')].map((c) => c.dataset.task), ['0', '1', '2', '3', '4', '5']);
  eq('each task list item has a drag handle', modal.querySelectorAll('.kb-task-list > li > .kb-grip').length, k.LIVE ? 6 : 0);

  // ---- editing, which needs the board's server
  if (!k.LIVE) {
    lines.push('skip editing: served from a file');
  } else {
    const sent = [];
    window.addEventListener('kanban:change', (e) => sent.push(e.detail));
    const fetched = [];
    const realFetch = window.fetch;
    let simulateFailure = false;
    window.fetch = async (url, opts) => {
      fetched.push({ url: String(url), opts });
      if (simulateFailure) throw new Error('offline');
      const payload = JSON.parse(opts.body);
      return { ok: true, json: async () => String(url).endsWith('/api/reserve-id') ? { card: 5 } : { queued: payload.id } };
    };
    const settled = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };


    k.openCard(1, true);
    const form = document.getElementById('card-form');
    form.querySelector('[name="title"]').value = 'First card, edited';
    form.querySelector('[name="priority"]').value = 'P2';
    form.querySelector('[name="roles"][value="switch"]').checked = true;
    form.querySelector('[name="components"]').value = 'agent, web';
    form.querySelector('[name="depends_on"]').value = 'DEMO-2, 3';
    form.requestSubmit();
    const c = sent[0];
    eq('saving sends one change', [sent.length, c && c.op, c && c.card], [1, 'save', 1]);
    const written = c && k.parseCard(c.writes['todo/001-first-card.md']).meta;
    eq('with the card as the agent should write it', written && [written.title, written.priority, written.roles, written.components, written.depends_on], ['First card, edited', 'P2', ['router', 'ap', 'switch'], ['agent', 'web'], [2, 3]]);
    eq('and what it was made on', c && c.base, 'fixture-1');
    has('and a summary', c && c.summary, 'Edit DEMO-1');
    const decoded = JSON.parse(fetched[0].opts.body);
    eq('the request carries JSON in a POST body', [fetched[0].opts.method, decoded.id], ['POST', c.id]);
    eq('the before snapshot is the original file', c.before['todo/001-first-card.md'], files['todo/001-first-card.md']);
    await settled();
    check('the card shows as pending', document.querySelector('.kb-tile[data-id="1"]').classList.contains('kb-pending'));
    has('and the top bar counts it', document.querySelector('.kb-topbar').textContent, '1 pending changes');
    check('the modal shows the saved card', document.getElementById('modal-title').textContent === 'First card, edited');

    // Deleting asks twice: the ticket must be typed before the red button works.
    k.openCard(4);
    document.querySelector('#modal [data-action="delete-card"]').click();
    const confirmBox = document.getElementById('confirm');
    check('Delete opens a confirmation', confirmBox.open);
    const go = confirmBox.querySelector('[data-action="confirm-delete"]');
    check('its button waits for the ticket', go.disabled);
    const typed = document.getElementById('confirm-ticket');
    typed.value = 'DEMO-9';
    typed.dispatchEvent(new Event('input', { bubbles: true }));
    check('a wrong ticket doesn\'t do', go.disabled);
    typed.value = 'demo-4';
    typed.dispatchEvent(new Event('input', { bubbles: true }));
    check('the right one does', !go.disabled);
    go.click();
    const d = sent[sent.length - 1];
    eq('then the delete is sent', [d.op, d.card, d.deletes], ['delete', 4, ['todo/004-unlisted.md']]);
    check('and both dialogs close', !confirmBox.open && !document.getElementById('modal').open);

    // The board settings editor.
    k.openSettings('fields');
    check('the settings open on the fields', Boolean(document.querySelector('#modal [data-list="fields"]')));
    const prio = [...document.querySelectorAll('#modal .kb-settings-field')][1];
    prio.querySelector('[data-action="settings-add-option"]').click();
    const newOpt = [...document.querySelectorAll('#modal .kb-settings-field')][1].querySelectorAll('.kb-settings-option');
    const last = newOpt[newOpt.length - 1];
    const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    setVal(last.querySelector('[data-bind$=".value"]'), 'P3');
    setVal(last.querySelector('[data-bind$=".label"]'), 'Low');
    last.querySelector('[data-action="settings-color"]').click();
    const swatches = document.querySelectorAll('#modal .kb-palette [data-action="settings-pick"]');
    eq('the colour picker offers the theme\'s palette, and none', swatches.length, 14);
    [...swatches].find((b) => b.dataset.color === 'gray').click();
    check('picking closes the palette', !document.querySelector('#modal .kb-palette'));
    document.querySelector('#modal [data-action="settings-tab"][data-tab="columns"]').click();
    document.querySelector('#modal [data-action="settings-add-column"]').click();
    const colRows = document.querySelectorAll('#modal [data-list="columns"] .kb-settings-row');
    setVal(colRows[colRows.length - 1].querySelector('[data-bind$=".title"]'), 'Blocked');
    document.querySelector('#modal [data-action="settings-save"]').click();
    has('a column without a folder isn\'t saved', document.querySelector('#modal .kb-settings-errors')?.textContent, "folder is lowercase");
    setVal(document.querySelectorAll('#modal [data-list="columns"] .kb-settings-row')[colRows.length - 1].querySelector('[data-bind$=".id"]'), 'blocked');
    document.querySelector('#modal [data-action="settings-save"]').click();
    const conf = sent[sent.length - 1];
    eq('saving sends the settings', conf.op, 'config');
    has('with the new option, labelled and coloured', conf.writes['board.yml'], '{value: P3, label: Low, color: gray}');
    has('and the new column', conf.writes['board.yml'], '{id: blocked, title: Blocked}');
    eq('whose order file comes too', conf.writes['blocked/_blocked.md'], '# Blocked\n\nNo cards.\n');
    check('the settings close', !document.getElementById('modal').open);
    eq('the board shows the new column at once', [...document.querySelectorAll('.kb-column')].map((c) => c.dataset.column).pop(), 'blocked');

    // The settings keep one height across their tabs; the template has the rich editor.
    sessionStorage.clear(); k.openSettings('general');
    const heights = [];
    for (const tab of ['general', 'columns', 'fields', 'template']) {
      document.querySelector(`#modal [data-action="settings-tab"][data-tab="${tab}"]`).click();
      heights.push(Math.round(document.querySelector('#modal > div').getBoundingClientRect().height));
    }
    eq('the settings keep one height across tabs', new Set(heights).size, 1);
    const tpl = document.querySelector('#modal textarea[data-bind="template"]');
    k.rich(tpl).setMarkdown(`${k.rich(tpl).getMarkdown().trimEnd()}\n\nA template line.`);
    has('editing the template changes the draft', k.state.settings.draft.template, 'A template line.');
    const keepConfirm = window.confirm;
    window.confirm = () => true; document.querySelector('#modal [data-action="close"]').click(); await settled(); window.confirm = keepConfirm;
    sessionStorage.clear();

    k.openNew('doing');
    const nf = document.getElementById('new-card-form');
    has('a new card starts from the template', nf.querySelector('[name="body"]').value, '## Acceptance criteria');
    nf.querySelector('[name="title"]').value = 'Brand new';
    nf.querySelector('[name="type"]').value = 'chore';
    nf.requestSubmit();
    await settled();
    const n = sent[sent.length - 1];
    eq('creating sends a change', [n && n.op, n && n.card, n && n.column], ['create', 5, 'doing']);
    check('with the new file', Boolean(n && n.writes['doing/005-brand-new.md']));
    check('the modal closes', !document.getElementById('modal').open);
    eq('the new card shows at once', tiles('doing'), [3, 5]);

    // The agent applies the first change: newer data lists it; the other stays pending.
    const next = { version: 'fixture-2', applied: [c.id], files: { ...files, ...c.writes } };
    k.accept(next);
    eq('applied changes stop being pending', k.state.pending.map((p) => p.op), ['delete', 'config', 'create']);
    eq('the rest still shows', tiles('doing'), [3, 5]);
    has('and the applied one is the data now', document.querySelector('.kb-tile[data-id="1"]').textContent, 'First card, edited');

    // A settings draft retains its original before snapshot even if polling advances.
    k.state.pending = [];
    k.accept(data);
    k.openSettings();
    k.state.settings.draft.name = 'My settings draft';
    const remoteConfig = { ...data, version: 'remote-config', files: { ...files, 'board.yml': files['board.yml'].replace('name: Demo', 'name: Remote') } };
    k.accept(remoteConfig);
    check('incoming settings disable Save until resolved', document.querySelector('[data-action="settings-save"]').disabled);
    const incomingSettings = document.querySelector('.kb-settings-incoming');
    check('incoming settings show a decision notice', Boolean(incomingSettings));
    [...incomingSettings.querySelectorAll('button')].find(b => b.textContent === 'Decline').click();
    document.querySelector('[data-action="settings-save"]').click();
    await settled();
    const settingsEdit = sent[sent.length - 1];
    eq('resolved settings use the explicitly reviewed snapshot', settingsEdit.before['board.yml'], remoteConfig.files['board.yml']);
    eq('settings changes use JSON POST without a card number', [settingsEdit.op, settingsEdit.card], ['config', undefined]);

    k.state.pending = [];
    k.accept(data);
    k.openSettings('columns');
    k.state.settings.draft.columns = k.state.settings.draft.columns.filter(c => c.id !== 'done');
    k.accept({ ...data, version: 'column-filled', files: k.applyChange(files, { op: 'move', card: 1, column: 'done' }) });
    document.querySelector('[data-action="settings-save"]').click();
    has('a newly occupied column cannot disappear through a stale settings draft', document.querySelector('.kb-settings-errors').textContent, 'now contains cards');
    check('the settings draft remains open for correction', document.getElementById('modal').open && k.state.settings !== null);
    document.getElementById('modal').close();

    // Resolve each incoming field independently without losing a local draft.
    k.state.pending = [];
    k.accept(data);
    k.openCard(1, true);
    const edit = document.getElementById('card-form');
    const bodyArea = edit.querySelector('[name="body"]');
    check('the details open in the rich editor', Boolean(edit.querySelector('.kb-rich .toastui-editor-ww-container')) && bodyArea.hidden);
    check('its toolbar never submits the form', [...edit.querySelectorAll('.toastui-editor-toolbar button')].every((b) => b.type === 'button'));
    const before = bodyArea.value;
    k.rich(bodyArea).setMarkdown(`${k.rich(bodyArea).getMarkdown().trimEnd()}\n\nTyped in the editor.`);
    eq('an edit reaches the form, the rest of the body as it was', bodyArea.value, `${before.trimEnd()}\n\nTyped in the editor.\n`);
    bodyArea.value = before;
    edit.querySelector('[name="title"]').value = 'My local title';
    edit.querySelector('[name="body"]').value = 'My local body';
    const incomingFiles = k.applyChange(files, { op: 'save', card: 1, title: 'Remote title', column: 'doing',
      fields: { priority: 'P2', roles: ['switch'], components: ['web'], depends_on: [3] }, body: 'Remote body' });
    k.accept({ ...data, version: 'incoming-1', files: incomingFiles });
    eq('incoming edits leave typing intact', [edit.querySelector('[name="title"]').value, edit.querySelector('[name="body"]').value], ['My local title', 'My local body']);
    eq('each changed field gets a notice', edit.querySelectorAll('.kb-incoming').length, 7);
    check('Save waits for all choices', document.querySelector('[form="card-form"][type="submit"]').disabled);
    const decide = (key, action) => edit.querySelector(`.kb-incoming[data-field="${key}"] [data-action="incoming-${action}"]`).click();
    decide('title', 'decline');
    decide('body', 'accept');
    decide('column', 'accept');
    decide('field:priority', 'accept');
    decide('field:roles', 'accept');
    decide('field:components', 'accept');
    decide('field:depends_on', 'accept');
    eq('Decline keeps the local field', edit.querySelector('[name="title"]').value, 'My local title');
    eq('Accept updates the body and status', [edit.querySelector('[name="body"]').value, edit.querySelector('[name="column"]').value], ['Remote body\n', 'doing']);
    eq('and shows the body in the editor', k.rich(bodyArea).getMarkdown().trim(), 'Remote body');
    eq('Accept updates multiselects and card references', [[...edit.querySelectorAll('[name="roles"]:checked')].map(el => el.value), edit.querySelector('[name="depends_on"]').value], [['switch'], 'DEMO-3']);
    check('Save enabled after all decisions', !document.querySelector('[form="card-form"][type="submit"]').disabled);
    k.accept({ ...data, version: 'incoming-repeat', files: incomingFiles });
    eq('decided notices do not recur on unchanged fields', edit.querySelectorAll('.kb-incoming').length, 0);
    edit.requestSubmit();
    await settled();
    const resolved = sent[sent.length - 1];
    eq('saved decision keeps local title and accepted body', [resolved.title, resolved.body], ['My local title', 'Remote body\n']);
    eq('saved decision compares against the incoming disk snapshot', resolved.before['doing/001-first-card.md'], incomingFiles['doing/001-first-card.md']);

    // The same field changing again needs a new decision; deletion retains the draft.
    k.state.pending = [];
    k.accept(data);
    k.openCard(1, true);
    const edit2 = document.getElementById('card-form');
    k.accept({ ...data, version: 'incoming-2', files: incomingFiles });
    const newer = k.applyChange(incomingFiles, { op: 'save', card: 1, title: 'Newest title', fields: {}, body: 'Remote body' });
    k.accept({ ...data, version: 'incoming-3', files: newer });
    has('a second incoming value updates its notice', edit2.querySelector('[data-field="title"]').textContent, 'Newest title');
    const removed = k.applyChange(newer, { op: 'delete', card: 1 });
    k.accept({ ...data, version: 'deleted', files: removed });
    check('incoming deletion disables Save', document.querySelector('[form="card-form"][type="submit"]').disabled);
    check('incoming deletion preserves the draft', edit2.querySelector('[name="title"]').value === first.title);
    document.getElementById('modal').close();

    // Content can return to its original hash while acknowledgement IDs still change.
    k.state.pending = [];
    k.accept(data);
    k.commit('task', { card: 1, task: 1 }, 'tick');
    k.commit('task', { card: 1, task: 1 }, 'untick');
    await settled();
    const acknowledgements = k.state.pending.map(p => p.id);
    window.KANBAN_DATA = { ...data, applied: acknowledgements };
    const append = document.head.append;
    document.head.append = script => script.onload();
    k.poll();
    document.head.append = append;
    eq('acknowledgement-only polling clears pending edits', k.state.pending.length, 0);

    // Collision detection preserves an existing ticket instead of shadowing it in the Map.
    let collision = false;
    try { k.applyChange(files, { op: 'create', card: 1, column: 'todo', title: 'Duplicate', body: 'x' }); }
    catch { collision = true; }
    check('creating with an existing ID fails without altering the board', collision && k.buildBoard(files).cards.get(1).title === first.title);

    // Failed deliveries stay visible, persist for reload, and retry the exact event ID.
    k.accept(data);
    simulateFailure = true;
    k.commit('save', { card: 2, title: 'Large card', body: 'x'.repeat(30000), fields: {} }, 'large save');
    await settled();
    const failedId = k.state.pending[0].id;
    check('a failed delivery shows Retry', Boolean(document.querySelector('[data-action="retry-delivery"]')));
    check('a failed delivery is retained in session storage', Object.keys(sessionStorage).some(key => (sessionStorage.getItem(key) || '').includes(failedId)));
    simulateFailure = false;
    await k.sendPending();
    check('retry clears the delivery error', !document.querySelector('[data-action="retry-delivery"]'));
    eq('retry uses the same change id', JSON.parse(fetched[fetched.length - 1].opts.body).id, failedId);
    check('large payloads are sent in the body, not URL', fetched[fetched.length - 1].url.length < 200 && fetched[fetched.length - 1].opts.body.length > 60000);
    k.state.pending = [];
    k.accept(data);
    // Settings migrations require a review and update the cards with the settings.
    k.state.pending = []; k.accept(data); sessionStorage.clear();
    k.openSettings('fields');
    const originalType = k.state.settings.draft.fields.find(f => f.name === 'type');
    originalType.options = originalType.options.filter(o => o.value !== first.meta.type);
    document.querySelector('[data-action="settings-save"]').click();
    check('removing an in-use option opens a migration review', Boolean(document.querySelector('#migration-review')));
    eq('reviewing a migration has not queued a change', k.state.pending.length, 0);
    for (const input of document.querySelectorAll('[data-migration]')) input.value = originalType.options[0].value;
    document.querySelector('[data-action="settings-save"]').click();
    await settled();
    eq('the reviewed option migration updates the card', k.state.board.cards.get(1).meta.type, originalType.options[0].value);
    check('migration and settings are delivered as one event', k.state.pending.length === 1 && k.state.pending[0].migrations.length > 0 && Boolean(k.state.pending[0].writes['board.yml']) && Boolean(k.state.pending[0].writes[first.path]));
    const migrationEvent = k.state.pending[0];
    let staleMigration = false;
    const changedCard = k.applyChange(files, { op: 'save', card: 1, title: first.title, body: first.body, fields: { type: 'elsewhere' } });
    try { k.applyChange(changedCard, migrationEvent); } catch { staleMigration = true; }
    check('migration replay refuses to overwrite a changed card value', staleMigration);

    k.state.pending = []; k.accept(data); sessionStorage.clear();
    k.openSettings('fields');
    k.state.settings.draft.fields = k.state.settings.draft.fields.filter(f => f.name !== 'roles');
    document.querySelector('[data-action="settings-save"]').click();
    document.querySelector('[data-action="settings-save"]').click();
    check('field removal needs explicit per-card confirmation', document.querySelector('#migration-review [role="alert"]').textContent.includes('Confirm removal'));
    [...document.querySelectorAll('#migration-review button')].find(b => b.textContent === 'Preserve roles').click();
    document.querySelector('[data-action="settings-save"]').click();
    eq('preserving the field leaves card values intact', k.state.board.cards.get(1).meta.roles, first.meta.roles);
    await settled();

    k.state.pending = []; k.accept(data); sessionStorage.clear(); k.openSettings('fields');
    k.state.settings.draft.fields.find(f => f.name === 'type').kind = 'number';
    document.querySelector('[data-action="settings-save"]').click();
    document.querySelector('[data-action="settings-save"]').click();
    has('type migration rejects an invalid numeric conversion', document.querySelector('#migration-review [role="alert"]').textContent, 'valid number');
    for (const input of document.querySelectorAll('[data-migration]')) input.value = '42';
    document.querySelector('[data-action="settings-save"]').click(); await settled();
    eq('explicit type migration writes a numeric value', k.state.board.cards.get(1).meta.type, 42);

    k.state.pending = []; k.accept(data); sessionStorage.clear(); k.openSettings();
    setVal(document.querySelector('[data-bind="name"]'), 'Keep my name');
    const incomingTemplate = { ...data, version: 'incoming-template', files: { ...files, 'board.yml': files['board.yml'].replace('Describe the card.', 'Incoming template text.') } };
    k.accept(incomingTemplate);
    [...document.querySelectorAll('.kb-settings-incoming button')].find(b => b.textContent === 'Accept').click();
    eq('accepting incoming template preserves independent settings typing', k.state.settings.draft.name, 'Keep my name');
    has('accepting incoming template updates only that setting', k.state.settings.draft.template, 'Incoming template text.');
    const closeConfirm = window.confirm; window.confirm = () => true;
    document.querySelector('#modal [data-action="close"]').click(); await settled(); window.confirm = closeConfirm;

    // Unknown choices remain selectable when an older board already contains them.
    k.state.pending = [];
    const legacy = { ...data, version: 'legacy-option', files: k.applyChange(files, { op: 'save', card: 1, title: first.title, body: first.body, fields: { type: 'legacy' } }) };
    k.accept(legacy); sessionStorage.clear(); k.openCard(1, true);
    eq('an unknown select value is preserved in the editor', document.querySelector('[name="type"]').value, 'legacy');
    document.querySelector('#card-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    eq('saving an unknown option retains it', k.state.board.cards.get(1).meta.type, 'legacy');
    await settled();

    // Unsaved card and settings drafts restore without becoming queued changes.
    k.state.pending = []; k.accept(data); sessionStorage.clear(); k.openCard(1, true);
    setVal(document.querySelector('[name="title"]'), 'Unsaved draft title');
    const savedDraft = Object.keys(sessionStorage).find(key => key.includes(':draft:card:1'));
    check('typing persists the unsaved card draft', Boolean(savedDraft));
    const originalConfirm = window.confirm;
    window.confirm = () => false;
    document.querySelector('#modal [data-action="close"]').click();
    check('declining discard keeps the draft open', document.querySelector('#modal').open);
    document.querySelector('#modal').dispatchEvent(new Event('cancel', { cancelable: true }));
    check('Escape also asks before discarding the draft', document.querySelector('#modal').open);
    k.openCard(1, true);
    eq('reopening restores unsaved card text', document.querySelector('[name="title"]').value, 'Unsaved draft title');
    window.confirm = () => true;
    document.querySelector('#modal [data-action="close"]').click();
    check('confirmed discard removes the saved draft', !sessionStorage.getItem(savedDraft));
    await settled();
    window.confirm = originalConfirm;
    k.openSettings(); setVal(document.querySelector('[data-bind="name"]'), 'Unsaved board name');
    k.openSettings();
    eq('settings draft restores on reopening', document.querySelector('[data-bind="name"]').value, 'Unsaved board name');
    window.confirm = () => true; document.querySelector('#modal [data-action="close"]').click(); await settled(); window.confirm = originalConfirm;

    // An open editor cannot submit with controls from an obsolete schema.
    k.accept(data); sessionStorage.clear(); k.openCard(1, true);
    setVal(document.querySelector('[name="title"]'), 'Retain while schema changes');
    const schemaFiles = { ...files, 'board.yml': files['board.yml'].replace('label: Type', 'label: Changed type') };
    k.accept({ ...data, version: 'schema-changed', files: schemaFiles });
    check('schema change blocks stale card submission', document.querySelector('[form="card-form"][type="submit"]').disabled);
    document.querySelector('#schema-notice button').click();
    eq('schema review retains typed text', document.querySelector('[name="title"]').value, 'Retain while schema changes');
    check('schema review uses the updated controls', document.querySelector('#card-form').textContent.includes('Changed type'));
    window.confirm = () => true; document.querySelector('#modal [data-action="close"]').click(); await settled(); window.confirm = originalConfirm;

    // Poll failures and server resolution states are visible even without board changes.
    k.accept(data);
    const appendPoll = document.head.append;
    document.head.append = script => script.onerror(); k.poll(); document.head.append = appendPoll;
    has('failed polling announces stale board data', document.querySelector('.kb-app').textContent, 'Connection lost');
    window.KANBAN_DATA = { ...data, queue: [{ id: 'remote-pending', summary: 'Remote edit', status: 'Needs resolution', reason: 'Choose the intended title' }] };
    document.head.append = script => script.onload(); k.poll(); document.head.append = appendPoll;
    check('successful polling clears the connection warning', !k.state.connectionError);
    has('status-only polling shows resolution details', document.querySelector('.kb-change-status').textContent, 'Needs resolution');
    has('resolution reason is visible', document.querySelector('.kb-change-status').textContent, 'Choose the intended title');
    k.accept(data); window.KANBAN_DATA = data;

    window.fetch = realFetch;
  }

  document.getElementById('results').textContent = lines.join('\n');
  document.title = `${failed ? 'FAIL' : 'PASS'} ${failed ? failed : passed}`;
})().catch(error => { document.title = 'FAIL exception'; document.getElementById('results').textContent += '\n' + error.stack; });
