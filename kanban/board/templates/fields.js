/*
 * What the card and new-card modals share: the inputs for a card's fields, and the Markdown
 * editor for its details. Each field in board.yml gets the input its kind needs.
 */

// Data: fields[] { name, label, help, isSelect, isMulti, isText, isList, isCards, isNumber,
// isDate, options[] { value, selected }, text }, key.
KanbanTemplates.partials.fieldInputs = /*html*/ `
<div class="kb-field-grid">
  {{#fields}}
  <div class="field">
    <label for="f-{{name}}">{{label}}</label>
    {{#isSelect}}
    <select id="f-{{name}}" name="{{name}}">
      <option value="">None</option>
      {{#options}}<option value="{{value}}" {{#selected}}selected{{/selected}}>{{label}}</option>{{/options}}
    </select>
    {{/isSelect}}
    {{#isMulti}}
    <div class="kb-checks" role="group" id="f-{{name}}">
      {{#options}}
      <label class="label"><input type="checkbox" name="{{name}}" value="{{value}}" {{#selected}}checked{{/selected}}> {{label}}</label>
      {{/options}}
    </div>
    {{/isMulti}}
    {{#isText}}<input id="f-{{name}}" name="{{name}}" type="text" value="{{text}}">{{/isText}}
    {{#isList}}<input id="f-{{name}}" name="{{name}}" type="text" value="{{text}}" placeholder="Comma-separated">{{/isList}}
    {{#isCards}}<input id="f-{{name}}" name="{{name}}" type="text" value="{{text}}" placeholder="{{key}}-12, {{key}}-13">{{/isCards}}
    {{#isNumber}}<input id="f-{{name}}" name="{{name}}" type="number" value="{{text}}">{{/isNumber}}
    {{#isDate}}<input id="f-{{name}}" name="{{name}}" type="date" value="{{text}}">{{/isDate}}
    {{#help}}<p>{{help}}</p>{{/help}}
  </div>
  {{/fields}}
</div>
`;

// The details, in Markdown. app.js mounts the rich editor (Toast UI) over the textarea,
// which stays the value the form sends. Data: body, bind (the settings draft's path).
KanbanTemplates.partials.markdownEditor = /*html*/ `
<div class="kb-editor">
  <textarea class="textarea kb-body" name="body" aria-label="Details, in Markdown" spellcheck="true" {{#bind}}data-bind="{{bind}}"{{/bind}}>{{body}}</textarea>
</div>
`;
