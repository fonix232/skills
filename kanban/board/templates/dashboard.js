/*
 * The dashboard: the top bar, the columns and their card tiles, and what shows when there's
 * no board data. Mustache templates, filled in by app.js (`dashboardView` and `tileView` there
 * build the data each one gets). The markup is Basecoat's (shadcn/ui's design system).
 */

// The board. Data: name, key, query, editable, pending { count, list[] { summary } },
// columns[] { id, title, count, cards[] (tiles) }.
KanbanTemplates.dashboard = /*html*/ `
<div class="kb-app">
  <header class="kb-topbar">
    <div class="flex items-center gap-3 min-w-0">
      <h1 class="text-lg font-semibold truncate">{{name}}</h1>
      <span class="badge" data-variant="outline">{{key}}</span>
      {{#pending.count}}
      <span class="badge" data-variant="secondary" title="{{#pending.list}}{{status}}: {{summary}}&#10;{{/pending.list}}">
        {{pending.count}} pending changes
      </span>
      {{/pending.count}}
      {{^editable}}
      <span class="badge" data-variant="outline" title="Opened from a file: changes can't reach the agent. Open the board through its server to edit.">Read-only</span>
      {{/editable}}
    </div>
    <div class="flex items-center gap-2">
      <input class="input w-64" type="search" placeholder="Filter cards" aria-label="Filter cards"
             data-action="filter" value="{{query}}">
      {{#editable}}
      <button class="btn" data-size="sm" data-action="new-card">{{> iconPlus}} New card</button>
      <button class="btn" data-variant="outline" data-size="sm" data-action="settings" title="Columns, fields and the card template">{{> iconSettings}} Board</button>
      {{/editable}}
      <button class="btn" data-variant="ghost" data-size="icon-sm" data-action="theme"
              aria-label="Switch between light and dark">{{> iconTheme}}</button>
    </div>
  </header>
  {{#deliveryError}}
  <div class="kb-delivery-error" role="alert">{{deliveryError}} <button type="button" class="btn" data-size="sm" data-action="retry-delivery">Retry delivery</button></div>
  {{/deliveryError}}
  {{#storageError}}<div class="kb-delivery-error" role="status">{{storageError}}</div>{{/storageError}}
  {{#replayError}}<div class="kb-delivery-error" role="alert">{{replayError}}</div>{{/replayError}}
  {{#connectionError}}<div class="kb-delivery-error" role="alert">{{connectionError}}</div>{{/connectionError}}
  <div class="kb-change-status" role="status">
    {{#pending.list}}<div><strong>{{status}}</strong>: {{summary}}</div>{{/pending.list}}
    {{#lastApplied}}<div>Applied: {{lastApplied}} changes this session</div>{{/lastApplied}}
  </div>
  <main class="kb-board">
    {{#columns}}
    <section class="kb-column" data-column="{{id}}" aria-label="{{title}}">
      <header class="kb-column-header">
        <h2 class="text-sm font-semibold">{{title}}</h2>
        <span class="badge" data-variant="secondary">{{count}}</span>
        {{#editable}}
        <button class="btn ml-auto" data-variant="ghost" data-size="icon-xs" data-action="new-card"
                data-column="{{id}}" aria-label="New card in {{title}}">{{> iconPlus}}</button>
        {{/editable}}
      </header>
      <ol class="kb-cards" data-column="{{id}}">
        {{#cards}}{{> tile}}{{/cards}}
      </ol>
    </section>
    {{/columns}}
  </main>
</div>
`;

// One card on the board: its priority as the left border's colour, and its criteria and
// tasks as a progress bar along the bottom. Data: id, ticket, title, search, pending,
// marker (a colour), markerLabel, badges[] { text, variant, label }, hasBadges,
// progress { done, total, pct }, depends[] (tickets).
KanbanTemplates.partials.tile = /*html*/ `
<li class="card kb-tile{{#pending}} kb-pending{{/pending}}{{#marker}} kb-marked{{/marker}}" data-id="{{id}}"
    data-action="open-card" data-search="{{search}}" tabindex="0"
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
KanbanTemplates.partials.iconTheme = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20z" fill="currentColor"/></svg>`;
KanbanTemplates.partials.iconSettings = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>`;
KanbanTemplates.partials.iconGrip = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;
KanbanTemplates.partials.iconInfo = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
KanbanTemplates.partials.iconClose = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
