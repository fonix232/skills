/*
 * The New card modal, laid out as the card modal is: the title and the details (Markdown,
 * started from board.yml's `template`) in the main column; the status and the fields in the
 * side column. Mustache, filled in by app.js (`newCardView` there).
 */

// Data: key, nextTicket, columns[] { id, title, selected }, fields[] (see the fieldInputs
// partial), body.
KanbanTemplates.newCard = /*html*/ `
<header>
  <h2 id="modal-title" class="text-xl font-semibold">New card</h2>
  <p>A unique ticket number is reserved when you create the card.</p>
</header>

<section class="kb-modal-body">
  <form id="new-card-form" class="kb-detail" data-action="create-card">
    <div class="kb-form">
      <div class="field">
        <label for="f-title">Title</label>
        <input id="f-title" name="title" type="text" required autofocus>
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
</section>

<footer>
  <button type="button" class="btn" data-variant="outline" data-action="close">Cancel</button>
  <button type="submit" class="btn" form="new-card-form">Create</button>
</footer>

<button type="button" aria-label="Close" data-action="close">{{> iconClose}}</button>
`;
