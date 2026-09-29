/*
 * The board settings editor: board.yml, visually. General (name, ticket key), Columns (their
 * order, titles and folders), Fields (their order, kind, tile and marker, and a select's
 * options with a label and a colour from the theme's palette) and the new-card Template.
 * Mustache, filled in by app.js (`settingsView` there). Inputs carry `data-bind`, the path of
 * what they change in the draft; buttons carry `data-action="settings-…"`.
 */

// Data: tabs { general, columns, fields, template }, tabList[] { id, title, selected },
// errors[], name, key, columns[] { i, id, title, existing, count, removable }, fields[] { i,
// name, label, help, tile, marker, existing, kinds[] { k, selected }, hasOptions, options[] {
// i, j, value, label, color, css, paletteOpen, palette[] { i, j, name, css, selected } } },
// body (the template), bind.
KanbanTemplates.settings = /*html*/ `
<header>
  <h2 id="modal-title" class="text-xl font-semibold">Board settings</h2>
  <p>Saved to <code>.ai/kanban/board.yml</code> once the agent writes it.</p>
</header>

<section class="kb-modal-body">
  {{#errors.length}}
  <div class="alert kb-settings-errors" data-variant="destructive">
    <h2>Not saved yet</h2>
    <section><ul>{{#errors}}<li>{{.}}</li>{{/errors}}</ul></section>
  </div>
  {{/errors.length}}

  <nav class="kb-settings-tabs" role="tablist">
    {{#tabList}}
    <button type="button" class="btn" data-size="sm" role="tab" aria-selected="{{selected}}"
            data-variant="{{#selected}}secondary{{/selected}}{{^selected}}ghost{{/selected}}"
            data-action="settings-tab" data-tab="{{id}}" {{#selected}}autofocus{{/selected}}>{{title}}</button>
    {{/tabList}}
  </nav>

  {{#tabs.general}}
  <div class="kb-form kb-settings-pane">
    <div class="field">
      <label for="s-name">Name</label>
      <input id="s-name" type="text" value="{{name}}" data-bind="name">
    </div>
    <div class="field">
      <label for="s-key">Ticket key</label>
      <input id="s-key" class="font-mono" type="text" value="{{key}}" data-bind="key" autocomplete="off">
      <p>Card 12 is {{key}}-12. Changing it rewrites every column's order file; commits keep the old tickets.</p>
    </div>
  </div>
  {{/tabs.general}}

  {{#tabs.columns}}
  <div class="kb-settings-pane">
    <p class="text-sm text-muted-foreground">Left to right. A column's folder is fixed once it exists; an empty column can go.</p>
    <ol class="kb-settings-list" data-list="columns">
      {{#columns}}
      <li class="kb-settings-row">
        <span class="kb-grip" title="Drag to reorder">{{> iconGrip}}</span>
        <input class="input" type="text" value="{{title}}" data-bind="columns.{{i}}.title" placeholder="Title" aria-label="Title">
        <input class="input font-mono kb-settings-id" type="text" value="{{id}}" data-bind="columns.{{i}}.id" placeholder="folder" aria-label="Folder"
               {{#existing}}readonly title="The column's folder"{{/existing}}>
        <span class="text-xs text-muted-foreground kb-settings-count">{{#existing}}{{count}} cards{{/existing}}{{^existing}}new{{/existing}}</span>
        <button type="button" class="btn" data-variant="ghost" data-size="icon-sm" data-action="settings-remove-column" data-i="{{i}}"
                aria-label="Remove the column" {{^removable}}disabled title="Move its cards out first"{{/removable}}>{{> iconClose}}</button>
      </li>
      {{/columns}}
    </ol>
    <button type="button" class="btn" data-variant="outline" data-size="sm" data-action="settings-add-column">{{> iconPlus}} Add a column</button>
  </div>
  {{/tabs.columns}}

  {{#tabs.fields}}
  <div class="kb-settings-pane">
    <p class="text-sm text-muted-foreground">In the order cards show them. A field's name is its front matter key, fixed once cards may use it.</p>
    <ol class="kb-settings-list" data-list="fields">
      {{#fields}}
      <li class="kb-settings-field">
        <div class="kb-settings-row">
          <span class="kb-grip" title="Drag to reorder">{{> iconGrip}}</span>
          <input class="input" type="text" value="{{label}}" data-bind="fields.{{i}}.label" placeholder="Label" aria-label="Label">
          <input class="input font-mono kb-settings-id" type="text" value="{{name}}" data-bind="fields.{{i}}.name" placeholder="name" aria-label="Name"
                 {{#existing}}readonly title="Its front matter key"{{/existing}}>
          <select data-bind="fields.{{i}}.kind" aria-label="Kind" class="kb-settings-kind">
            {{#kinds}}<option value="{{k}}" {{#selected}}selected{{/selected}}>{{k}}</option>{{/kinds}}
          </select>
          <button type="button" class="btn" data-variant="ghost" data-size="icon-sm" data-action="settings-remove-field" data-i="{{i}}" aria-label="Remove the field">{{> iconClose}}</button>
        </div>
        <div class="kb-settings-flags">
          <label class="label"><input type="checkbox" data-bind="fields.{{i}}.tile" {{#tile}}checked{{/tile}}> On tiles</label>
          <label class="label"><input type="checkbox" data-bind="fields.{{i}}.marker" {{#marker}}checked{{/marker}}> Tile border colour</label>
          <input class="input kb-settings-help" type="text" value="{{help}}" data-bind="fields.{{i}}.help" placeholder="Help, under its input" aria-label="Help">
        </div>
        {{#hasOptions}}
        <ol class="kb-settings-list kb-settings-options" data-list="options" data-i="{{i}}">
          {{#options}}
          <li class="kb-settings-option">
            <div class="kb-settings-row">
              <span class="kb-grip" title="Drag to reorder">{{> iconGrip}}</span>
              <input class="input font-mono" type="text" value="{{value}}" data-bind="fields.{{i}}.options.{{j}}.value" placeholder="value" aria-label="Value">
              <input class="input" type="text" value="{{label}}" data-bind="fields.{{i}}.options.{{j}}.label" placeholder="Label (the value if empty)" aria-label="Label">
              <button type="button" class="kb-swatch{{^color}} kb-swatch-none{{/color}}" {{#css}}style="--kb-pill: {{css}}"{{/css}}
                      data-action="settings-color" data-i="{{i}}" data-j="{{j}}" aria-label="Colour: {{#color}}{{color}}{{/color}}{{^color}}none{{/color}}"
                      title="{{#color}}{{color}}{{/color}}{{^color}}No colour{{/color}}"></button>
              <button type="button" class="btn" data-variant="ghost" data-size="icon-sm" data-action="settings-remove-option" data-i="{{i}}" data-j="{{j}}" aria-label="Remove the option">{{> iconClose}}</button>
            </div>
            {{#paletteOpen}}
            <div class="kb-palette" role="listbox" aria-label="Colours">
              {{#palette}}
              <button type="button" class="kb-swatch" style="--kb-pill: {{css}}" role="option" aria-selected="{{selected}}"
                      data-action="settings-pick" data-i="{{i}}" data-j="{{j}}" data-color="{{name}}" title="{{name}}"></button>
              {{/palette}}
              <button type="button" class="kb-swatch kb-swatch-none" role="option" data-action="settings-pick" data-i="{{i}}" data-j="{{j}}" data-color="" title="No colour"></button>
            </div>
            {{/paletteOpen}}
          </li>
          {{/options}}
        </ol>
        <button type="button" class="btn kb-settings-add-option" data-variant="ghost" data-size="sm" data-action="settings-add-option" data-i="{{i}}">{{> iconPlus}} Add an option</button>
        {{/hasOptions}}
      </li>
      {{/fields}}
    </ol>
    <button type="button" class="btn" data-variant="outline" data-size="sm" data-action="settings-add-field">{{> iconPlus}} Add a field</button>
  </div>
  {{/tabs.fields}}

  {{#tabs.template}}
  <div class="kb-form kb-settings-pane">
    <p class="text-sm text-muted-foreground">What a new card's details start with.</p>
    {{> markdownEditor}}
  </div>
  {{/tabs.template}}
</section>

<footer>
  <button type="button" class="btn" data-variant="outline" data-action="close">Cancel</button>
  <button type="button" class="btn" data-action="settings-save">Save</button>
</footer>

<button type="button" aria-label="Close" data-action="close">{{> iconClose}}</button>
`;
