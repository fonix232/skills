/*
 * The dashboard: the top bar, the columns and their card tiles, and what shows when there's
 * no board data. Mustache templates, filled in by app.js (`dashboardView` and `tileView` there
 * build the data each one gets). The markup is Basecoat's (shadcn/ui's design system).
 */

// The board. Data: name, key, query, scope (null, or { label, options[] { value, text,
// selected } }), views (null, or { board, outline, label }), editable, pending { count, list[]
// { status, summary } }, bell { open, recent[] { title, text, tone, time } }, columns[] { id, title, count (the cards in scope) }, columnCount, hasLanes,
// lanes[] { value, label, current, header, count, countText, collapsed, cells[] { column, lane, cards[]
// (tiles) } }, outline (null, or the outline partial's data).
KanbanTemplates.dashboard = /*html*/ `
<div class="kb-app">
  <header class="kb-topbar">
    <div class="flex items-center gap-3 min-w-0">
      <h1 class="text-lg font-semibold truncate">{{name}}</h1>
      <span class="badge" data-variant="outline">{{key}}</span>
      {{^editable}}
      <span class="badge" data-variant="outline" title="Opened from a file: changes can't reach the agent. Open the board through its server to edit.">Read-only</span>
      {{/editable}}
    </div>
    <div class="flex items-center gap-2">
      {{#views}}
      <div class="kb-view-switch" role="group" aria-label="View">
        <button type="button" class="btn" data-size="sm" data-variant="{{#board}}secondary{{/board}}{{^board}}ghost{{/board}}" data-action="view" data-view="board" aria-pressed="{{#board}}true{{/board}}{{^board}}false{{/board}}">Board</button>
        <button type="button" class="btn" data-size="sm" data-variant="{{#outline}}secondary{{/outline}}{{^outline}}ghost{{/outline}}" data-action="view" data-view="outline" aria-pressed="{{#outline}}true{{/outline}}{{^outline}}false{{/outline}}">{{label}}</button>
      </div>
      {{/views}}
      {{#scope}}
      <select class="select w-auto" data-action="scope" aria-label="{{label}}" title="Show one {{label}} at a time">
        {{#options}}<option value="{{value}}" {{#selected}}selected{{/selected}}>{{text}}</option>{{/options}}
      </select>
      {{/scope}}
      <input class="input w-64" type="search" placeholder="Filter cards" aria-label="Filter cards"
             data-action="filter" value="{{query}}">
      {{#editable}}
      <button class="btn" data-size="sm" data-action="new-card">{{> iconPlus}} New card</button>
      <button class="btn" data-variant="outline" data-size="sm" data-action="settings" title="Columns, fields and the card template">{{> iconSettings}} Board</button>
      {{/editable}}
      <div class="kb-bell">
        <button type="button" class="btn" data-variant="ghost" data-size="sm" data-action="bell" aria-expanded="{{#bell.open}}true{{/bell.open}}{{^bell.open}}false{{/bell.open}}"
                aria-controls="kb-bell-panel" title="Notifications">
          {{> iconBell}}{{#pending.count}}<span class="kb-bell-count" aria-hidden="true">{{pending.count}}</span>{{/pending.count}}
          <span class="sr-only">Notifications{{#pending.count}}, {{pending.count}} pending changes{{/pending.count}}</span>
        </button>
        {{#bell.open}}
        <div id="kb-bell-panel" class="kb-bell-panel" role="region" aria-label="Notifications">
          <section>
            <h2 class="kb-bell-heading">Waiting for the agent</h2>
            {{#pending.list}}<div class="kb-bell-item kb-bell-waiting"><span><strong>{{status}}</strong> {{summary}}</span>
              {{#editable}}<button type="button" class="btn" data-variant="ghost" data-size="sm" data-action="cancel-change" data-change="{{id}}"
                      title="Withdraw this change and restore the board">Cancel</button>{{/editable}}</div>{{/pending.list}}
            {{^pending.list}}<p class="kb-bell-empty">Nothing waiting.</p>{{/pending.list}}
          </section>
          <section>
            <h2 class="kb-bell-heading">Recent
              {{#bell.recent.length}}<button type="button" class="btn" data-variant="ghost" data-size="sm" data-action="bell-clear">Clear</button>{{/bell.recent.length}}</h2>
            {{#bell.recent}}<div class="kb-bell-item" data-tone="{{tone}}"><strong>{{title}}</strong> {{text}} <time class="kb-bell-time">{{time}}</time></div>{{/bell.recent}}
            {{^bell.recent}}<p class="kb-bell-empty">No notifications yet.</p>{{/bell.recent}}
          </section>
        </div>
        {{/bell.open}}
      </div>
      <button class="btn" data-variant="ghost" data-size="icon-sm" data-action="theme"
              aria-label="Switch between light and dark">{{> iconTheme}}</button>
    </div>
  </header>
  <!-- Changes and problems show as toasts (app.js, syncToasts), outside this template. -->
  {{#outline}}{{> outline}}{{/outline}}
  {{^outline}}
  <main class="kb-board{{#hasLanes}} kb-has-lanes{{/hasLanes}}" style="--kb-columns: {{columnCount}}">
    <div class="kb-board-head">
      {{#columns}}
      <section class="kb-column" data-column="{{id}}" aria-label="{{title}}">
        <header class="kb-column-header">
          <h2 class="text-sm font-semibold">{{title}}</h2>
          <span class="badge kb-column-count" data-variant="secondary" data-total="{{count}}">{{count}}</span>
          {{#editable}}
          <button class="btn ml-auto" data-variant="ghost" data-size="icon-xs" data-action="new-card"
                  data-column="{{id}}" aria-label="New card in {{title}}">{{> iconPlus}}</button>
          {{/editable}}
        </header>
      </section>
      {{/columns}}
    </div>
    {{#lanes}}
    <section class="kb-lane{{#collapsed}} kb-collapsed{{/collapsed}}" data-lane="{{value}}" data-label="{{label}}" data-counts="{{counts}}">
      {{#header}}
      <button type="button" class="kb-lane-header" data-action="toggle-lane" data-lane="{{value}}"
              aria-expanded="{{#collapsed}}false{{/collapsed}}{{^collapsed}}true{{/collapsed}}">
        <span class="kb-chevron" aria-hidden="true">{{> iconChevron}}</span>
        <span class="font-semibold">{{label}}</span>
        {{#current}}<span class="badge" data-variant="secondary">Current</span>{{/current}}
        <span class="text-xs text-muted-foreground">{{countText}}</span>
      </button>
      {{/header}}
      {{^collapsed}}
      <div class="kb-lane-body">
        {{#cells}}
        <ol class="kb-cards" data-column="{{column}}" data-lane="{{lane}}">
          {{#cards}}{{> tile}}{{/cards}}
        </ol>
        {{/cells}}
      </div>
      {{/collapsed}}
    </section>
    {{/lanes}}
  </main>
  {{/outline}}
</div>
`;

// One card on the board: its priority as the left border's colour, and its criteria and
// tasks as a progress bar along the bottom. Data: id, ticket, title, search, pending,
// outOfScope, marker (a colour), markerLabel, badges[] { text, variant, label }, hasBadges,
// progress { done, total, pct }, depends[] (tickets).
KanbanTemplates.partials.tile = /*html*/ `
<li class="card kb-tile{{#pending}} kb-pending{{/pending}}{{#marker}} kb-marked{{/marker}}" data-id="{{id}}"
    data-action="open-card" data-search="{{search}}" {{#outOfScope}}data-out="1"{{/outOfScope}} tabindex="0"
    {{#marker}}style="--kb-marker: {{marker}}"{{/marker}} {{#markerLabel}}title="{{markerLabel}}"{{/markerLabel}}>
  <div class="kb-tile-header">
    <span class="text-xs font-mono text-muted-foreground">{{ticket}}</span>
  </div>
  <p class="kb-tile-title">{{title}}</p>
  {{#hasBadges}}
  <div class="kb-tile-badges">
    {{#badges}}<span class="badge{{#color}} kb-pill{{/color}}" data-variant="{{variant}}" title="{{label}}" {{#color}}style="--kb-pill: {{color}}"{{/color}}>{{text}}</span>{{/badges}}
  </div>
  {{/hasBadges}}
  {{#depends.length}}
  <p class="text-xs text-muted-foreground">Depends on {{#depends}}{{.}} {{/depends}}</p>
  {{/depends.length}}
  {{#progress.total}}
  <div class="kb-progress" role="progressbar" aria-valuemin="0" aria-valuemax="{{progress.total}}"
       aria-valuenow="{{progress.done}}" title="{{progress.done}} of {{progress.total}} criteria and tasks done">
    <span style="width: {{progress.pct}}%"></span>
  </div>
  {{/progress.total}}
</li>
`;

// The outline view: the board's levels as a tree (initiatives, their epics, each epic's
// cards), with each document's status and its cards' progress. Data: roots[] (outlineNode),
// empty, loose[] (cards in no last-level document), looseCount, looseTitle, folders.
KanbanTemplates.partials.outline = /*html*/ `
<main class="kb-outline">
  {{#empty}}
  <div class="kb-connect card"><section class="text-sm">
    <p>Nothing here yet. Documents go in the board's <code>{{folders}}</code> folders, as Markdown with
       <code>id</code>, <code>title</code> and <code>status</code> in their front matter.</p>
  </section></div>
  {{/empty}}
  <ul class="kb-outline-list">{{#roots}}{{> outlineNode}}{{/roots}}</ul>
  {{#loose.length}}
  <section class="kb-node kb-node-loose">
    <div class="kb-node-row"><span class="font-semibold">{{looseTitle}}</span><span class="text-xs text-muted-foreground">{{looseCount}}</span></div>
    <ul class="kb-node-stories">{{#loose}}{{> outlineStory}}{{/loose}}</ul>
  </section>
  {{/loose.length}}
</main>
`;

// One document in the outline and what's under it. Data: id, title, path, depth, levelTitle,
// status, statusColor, progress { done, total, pct }, stories[] (outlineStory), children[].
KanbanTemplates.partials.outlineNode = /*html*/ `
<li class="kb-node{{#collapsed}} kb-collapsed{{/collapsed}}" data-depth="{{depth}}" data-doc="{{id}}">
  <div class="kb-node-row">
    {{#collapsible}}<button type="button" class="kb-node-toggle" data-action="toggle-node" data-path="{{path}}"
            aria-expanded="{{#collapsed}}false{{/collapsed}}{{^collapsed}}true{{/collapsed}}" aria-label="{{#collapsed}}Unfold{{/collapsed}}{{^collapsed}}Fold{{/collapsed}} {{levelTitle}} {{id}}">
      <span class="kb-chevron" aria-hidden="true">{{> iconChevron}}</span></button>{{/collapsible}}
    {{^collapsible}}<span class="kb-node-toggle" aria-hidden="true"></span>{{/collapsible}}
    <button type="button" class="kb-node-title" data-action="open-doc" data-path="{{path}}" title="{{levelTitle}} {{id}}">
      <span class="text-xs font-mono text-muted-foreground">{{id}}</span>
      <span class="font-medium">{{title}}</span>
    </button>
    {{#status}}<span class="badge kb-pill" style="--kb-pill: {{statusColor}}">{{status}}</span>{{/status}}
    {{#progress.total}}
    <span class="kb-node-progress" title="{{progress.done}} of {{progress.total}} cards done">
      <span class="text-xs text-muted-foreground">{{progress.done}}/{{progress.total}}</span>
      <span class="kb-progress" role="progressbar" aria-valuemin="0" aria-valuemax="{{progress.total}}" aria-valuenow="{{progress.done}}"><span style="width: {{progress.pct}}%"></span></span>
    </span>
    {{/progress.total}}
  </div>
  {{^collapsed}}
  {{#stories.length}}<ul class="kb-node-stories">{{#stories}}{{> outlineStory}}{{/stories}}</ul>{{/stories.length}}
  {{#children.length}}<ul class="kb-outline-list">{{#children}}{{> outlineNode}}{{/children}}</ul>{{/children.length}}
  {{/collapsed}}
</li>
`;

// A card under a document. Data: id, ticket, title, columnTitle, done.
KanbanTemplates.partials.outlineStory = /*html*/ `
<li class="kb-node-story{{#done}} kb-done{{/done}}">
  <a href="#" data-action="open-card" data-id="{{id}}"><span class="text-xs font-mono text-muted-foreground">{{ticket}}</span> {{title}}</a>
  <span class="badge" data-variant="outline">{{columnTitle}}</span>
</li>
`;

// No board data next to the page.
KanbanTemplates.noData = /*html*/ `
<div class="kb-connect card">
  <header>
    <h2>No board here yet</h2>
    <p>This page shows the board the agent injects next to it as <code>data.js</code>.</p>
  </header>
  <section class="text-sm flex flex-col gap-2">
    <p>Ask the agent to open the board: the kanban skill injects the project's
       <code>.ai/kanban</code> folder and serves it on <code>http://127.0.0.1:8124</code>.</p>
  </section>
</div>
`;

// Icons (Lucide's, inline).
KanbanTemplates.partials.iconPlus = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;
// Cancelling a change that later changes were built on. Data: count, ids (space-separated),
// first (its summary), later[] (theirs).
KanbanTemplates.confirmCancel = /*html*/ `
<header>
  <h2 class="text-lg font-semibold">Cancel {{count}} changes?</h2>
  <p>Later changes touch the same files as “{{first}}”, and were built on it, so they're cancelled with it:</p>
</header>
<section>
  <ul class="kb-cancel-list">{{#later}}<li>{{.}}</li>{{/later}}</ul>
  <p class="text-sm text-muted-foreground">Changes to other files stay queued. Make the ones you still want again afterwards.</p>
</section>
<footer>
  <button type="button" class="btn" data-variant="outline" data-action="close" autofocus>Keep them</button>
  <button type="button" class="btn" data-variant="destructive" data-action="confirm-cancel" data-changes="{{ids}}">Cancel {{count}} changes</button>
</footer>
`;

KanbanTemplates.partials.iconBell = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>`;
KanbanTemplates.partials.iconTheme = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20z" fill="currentColor"/></svg>`;
KanbanTemplates.partials.iconSettings = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>`;
KanbanTemplates.partials.iconGrip = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;
KanbanTemplates.partials.iconInfo = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
KanbanTemplates.partials.iconChevron = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
KanbanTemplates.partials.iconClose = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
