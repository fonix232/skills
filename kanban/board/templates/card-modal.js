/*
 * The card modal: a card to read or to edit, laid out as JIRA lays out an issue. The main
 * column holds the title and the details (Markdown: the description, the acceptance criteria
 * and the tasks); the side column holds the fields. Mustache, filled in by app.js
 * (`cardView` there), into the page's <dialog class="dialog">. Also here: the confirmation
 * a delete asks for.
 */

// Data: id, ticket, title, columnTitle, key, editable, editing, marker (a colour),
// file { path, created, modified, size }, columns[] { id, title, selected }; reading: fields[]
// { label, hasValue, values[] { text, variant, color, card } }, sections[] { name, done, total,
// pct }, bodyHtml; editing: fields[] (see the fieldInputs partial), body.
KanbanTemplates.cardModal = /*html*/ `
<header class="kb-detail-header">
  <div class="flex items-center gap-2 text-xs font-mono text-muted-foreground">
    {{#marker}}<span class="kb-dot" style="background: {{marker}}" aria-hidden="true"></span>{{/marker}}
    <span>{{ticket}}</span><span aria-hidden="true">·</span><span>{{columnTitle}}</span>
    <span class="kb-info" tabindex="0" aria-label="File details">
      {{> iconInfo}}
      <span class="kb-info-pop" role="tooltip">
        <span class="kb-info-row"><span>File</span><code>{{file.path}}</code></span>
        {{#file.created}}<span class="kb-info-row"><span>Created</span><span>{{file.created}}</span></span>{{/file.created}}
        {{#file.modified}}<span class="kb-info-row"><span>Modified</span><span>{{file.modified}}</span></span>{{/file.modified}}
        {{#file.size}}<span class="kb-info-row"><span>Size</span><span>{{file.size}}</span></span>{{/file.size}}
      </span>
    </span>
  </div>
  {{^editing}}<h2 id="modal-title" class="text-xl font-semibold leading-snug">{{title}}</h2>{{/editing}}
  {{#editing}}<h2 id="modal-title" class="sr-only">Edit {{ticket}}</h2>{{/editing}}
</header>

<section class="kb-modal-body">
  {{^editing}}
  <div class="kb-detail">
    <article class="kb-markdown" data-card="{{id}}">{{{bodyHtml}}}</article>
    <aside class="kb-side">
      <dl class="kb-fields">
        <div><dt>Status</dt><dd><span class="badge" data-variant="outline">{{columnTitle}}</span></dd></div>
        {{#fields}}{{#hasValue}}
        <div>
          <dt>{{label}}</dt>
          <dd>
            {{#values}}
              {{#card}}<a href="#" class="badge" data-variant="outline" data-action="open-card" data-id="{{card}}">{{text}}</a>{{/card}}
              {{^card}}<span class="badge{{#color}} kb-pill{{/color}}" data-variant="{{variant}}" {{#color}}style="--kb-pill: {{color}}"{{/color}}>{{text}}</span>{{/card}}
            {{/values}}
          </dd>
        </div>
        {{/hasValue}}{{/fields}}
      </dl>
      {{#sections.length}}
      <div class="kb-side-progress">
        {{#sections}}
        <div>
          <div class="flex justify-between text-xs"><span class="text-muted-foreground">{{name}}</span><span>{{done}}/{{total}}</span></div>
          <div class="kb-progress" role="progressbar" aria-label="{{name}}" aria-valuemin="0" aria-valuemax="{{total}}" aria-valuenow="{{done}}"><span style="width: {{pct}}%"></span></div>
        </div>
        {{/sections}}
      </div>
      {{/sections.length}}
    </aside>
  </div>
  {{/editing}}

  {{#editing}}
  <form id="card-form" class="kb-detail" data-action="save-card" data-id="{{id}}">
    <div class="kb-form">
      <div class="field">
        <label for="f-title">Title</label>
        <input id="f-title" name="title" type="text" value="{{title}}" required autofocus>
      </div>
      {{> markdownEditor}}
    </div>
    <aside class="kb-side kb-form">
      <div class="field">
        <label for="f-column">Status</label>
        <select id="f-column" name="column">
          {{#columns}}<option value="{{id}}" {{#selected}}selected{{/selected}}>{{title}}</option>{{/columns}}
        </select>
      </div>
      {{> fieldInputs}}
    </aside>
  </form>
  {{/editing}}
</section>

<footer>
  {{^editing}}
    {{#editable}}
    <button type="button" class="btn mr-auto" data-variant="destructive" data-action="delete-card" data-id="{{id}}">Delete</button>
    <button type="button" class="btn" data-action="edit-card" data-id="{{id}}" autofocus>Edit</button>
    <button type="button" class="btn" data-variant="outline" data-action="close">Close</button>
    {{/editable}}
    {{^editable}}
    <button type="button" class="btn" data-variant="outline" data-action="close" autofocus>Close</button>
    {{/editable}}
  {{/editing}}
  {{#editing}}
    <button type="button" class="btn" data-variant="outline" data-action="open-card" data-id="{{id}}">Cancel</button>
    <button type="submit" class="btn" form="card-form">Save</button>
  {{/editing}}
</footer>

<button type="button" aria-label="Close" data-action="close">{{> iconClose}}</button>
`;

// The second step of a delete, in its own dialog over the card: the ticket has to be typed
// before the red button works. Data: id, ticket, title, path.
KanbanTemplates.confirmDelete = /*html*/ `
<header>
  <h2 class="text-lg font-semibold">Delete {{ticket}}?</h2>
  <p>“{{title}}” and its file, <code>{{path}}</code>, go. Git keeps its history.</p>
</header>
<section>
  <div class="field">
    <label for="confirm-ticket">Type <strong>{{ticket}}</strong> to confirm</label>
    <input id="confirm-ticket" type="text" autocomplete="off" spellcheck="false" data-ticket="{{ticket}}">
  </div>
</section>
<footer>
  <button type="button" class="btn" data-variant="outline" data-action="close" autofocus>Keep it</button>
  <button type="button" class="btn" data-variant="destructive" data-action="confirm-delete" data-id="{{id}}" disabled>Delete {{ticket}}</button>
</footer>
`;

// A level's document (an initiative or an epic), read-only. Data: id, title, levelTitle, path,
// status, statusColor, fields[] { label, text }, bodyHtml.
KanbanTemplates.docModal = /*html*/ `
<header class="kb-detail-header">
  <div class="flex items-center gap-2 text-xs font-mono text-muted-foreground">
    <span>{{levelTitle}}</span><span aria-hidden="true">·</span><span>{{id}}</span>
    <span class="kb-info" tabindex="0" aria-label="File details">
      {{> iconInfo}}
      <span class="kb-info-pop" role="tooltip"><span class="kb-info-row"><span>File</span><code>{{path}}</code></span></span>
    </span>
  </div>
  <h2 id="modal-title" class="text-xl font-semibold leading-snug">{{title}}</h2>
</header>
<section class="kb-modal-body">
  <div class="kb-detail">
    <article class="kb-markdown">{{{bodyHtml}}}</article>
    <aside class="kb-side">
      <dl class="kb-fields">
        {{#status}}<div><dt>Status</dt><dd><span class="badge kb-pill" style="--kb-pill: {{statusColor}}">{{status}}</span></dd></div>{{/status}}
        {{#fields}}<div><dt>{{label}}</dt><dd>{{text}}</dd></div>{{/fields}}
      </dl>
    </aside>
  </div>
</section>
<footer>
  <button type="button" class="btn" data-variant="outline" data-action="close" autofocus>Close</button>
</footer>

<button type="button" aria-label="Close" data-action="close">{{> iconClose}}</button>
`;
