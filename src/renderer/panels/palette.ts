/**
 * The built-in element library shown in the Add panel. Each entry is plain,
 * semantic HTML with no dependency on any stylesheet: where an element needs
 * layout to be recognisable (columns, a card) it carries a small inline
 * style, which the inspector can then move into a class rule.
 */

export interface PaletteItem {
  id: string;
  label: string;
  /** Short hint shown as a tooltip. */
  hint: string;
  html: string;
}

export interface PaletteGroup {
  title: string;
  items: PaletteItem[];
}

export const PALETTE: PaletteGroup[] = [
  {
    title: 'Structure',
    items: [
      { id: 'section', label: 'Section', hint: 'A thematic block of the page', html: '<section>\n  <h2>Section heading</h2>\n  <p>Write something about this section.</p>\n</section>' },
      { id: 'box', label: 'Box', hint: 'An empty container', html: '<div style="padding: 1rem;"></div>' },
      {
        id: 'columns-2',
        label: 'Two columns',
        hint: 'A two-column grid',
        html: '<div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.5rem;">\n  <div>\n    <p>First column.</p>\n  </div>\n  <div>\n    <p>Second column.</p>\n  </div>\n</div>',
      },
      {
        id: 'columns-3',
        label: 'Three columns',
        hint: 'A three-column grid',
        html: '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem;">\n  <div>\n    <p>First column.</p>\n  </div>\n  <div>\n    <p>Second column.</p>\n  </div>\n  <div>\n    <p>Third column.</p>\n  </div>\n</div>',
      },
      {
        id: 'row',
        label: 'Row',
        hint: 'Items side by side, wrapping when narrow',
        html: '<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 1rem;">\n  <div>One</div>\n  <div>Two</div>\n  <div>Three</div>\n</div>',
      },
      {
        id: 'card',
        label: 'Card',
        hint: 'A bordered block with a heading',
        html: '<article style="padding: 1.25rem; border: 1px solid #d0d4d8; border-radius: 6px;">\n  <h3>Card heading</h3>\n  <p>A short description.</p>\n  <a href="#">Read more</a>\n</article>',
      },
      { id: 'divider', label: 'Divider', hint: 'A horizontal rule', html: '<hr>' },
    ],
  },
  {
    title: 'Text',
    items: [
      { id: 'h1', label: 'Page heading', hint: 'The main heading (h1)', html: '<h1>Page heading</h1>' },
      { id: 'h2', label: 'Heading', hint: 'A section heading (h2)', html: '<h2>Heading</h2>' },
      { id: 'h3', label: 'Subheading', hint: 'A lower-level heading (h3)', html: '<h3>Subheading</h3>' },
      { id: 'p', label: 'Paragraph', hint: 'Body text', html: '<p>Double-click to edit this paragraph.</p>' },
      { id: 'ul', label: 'Bulleted list', hint: 'An unordered list', html: '<ul>\n  <li>First item</li>\n  <li>Second item</li>\n  <li>Third item</li>\n</ul>' },
      { id: 'ol', label: 'Numbered list', hint: 'An ordered list', html: '<ol>\n  <li>First step</li>\n  <li>Second step</li>\n  <li>Third step</li>\n</ol>' },
      { id: 'quote', label: 'Quote', hint: 'A block quotation', html: '<blockquote>\n  <p>A sentence worth setting apart.</p>\n</blockquote>' },
      { id: 'link', label: 'Link', hint: 'A text link', html: '<a href="#">Link text</a>' },
      { id: 'button', label: 'Button', hint: 'A push button', html: '<button type="button">Button</button>' },
    ],
  },
  {
    title: 'Media',
    items: [
      { id: 'img', label: 'Image', hint: 'Choose the file in the inspector, or drag one from Assets', html: '<img src="" alt="Describe this image" width="320" height="200">' },
      { id: 'figure', label: 'Figure', hint: 'An image with a caption', html: '<figure>\n  <img src="" alt="Describe this image" width="320" height="200">\n  <figcaption>Caption</figcaption>\n</figure>' },
      { id: 'video', label: 'Video', hint: 'A video player', html: '<video src="" controls width="480"></video>' },
      { id: 'audio', label: 'Audio', hint: 'An audio player', html: '<audio src="" controls></audio>' },
      { id: 'embed', label: 'Embedded page', hint: 'An iframe for a map or video embed', html: '<iframe src="about:blank" title="Embedded content" width="560" height="315" loading="lazy"></iframe>' },
    ],
  },
  {
    title: 'Navigation',
    items: [
      { id: 'nav', label: 'Navigation', hint: 'A row of links', html: '<nav style="display: flex; gap: 1.5rem;">\n  <a href="#">Home</a>\n  <a href="#">About</a>\n  <a href="#">Contact</a>\n</nav>' },
      { id: 'header', label: 'Header', hint: 'A page header', html: '<header style="display: flex; align-items: center; justify-content: space-between; padding: 1rem;">\n  <strong>Site name</strong>\n  <nav style="display: flex; gap: 1.5rem;">\n    <a href="#">Home</a>\n    <a href="#">About</a>\n  </nav>\n</header>' },
      { id: 'footer', label: 'Footer', hint: 'A page footer', html: '<footer style="padding: 2rem 1rem; text-align: center;">\n  <p>Site name. All rights reserved.</p>\n</footer>' },
      { id: 'details', label: 'Disclosure', hint: 'A heading that expands to show more', html: '<details>\n  <summary>Question or heading</summary>\n  <p>The answer or the hidden content.</p>\n</details>' },
    ],
  },
  {
    title: 'Forms',
    items: [
      { id: 'form', label: 'Form', hint: 'A form with one field and a button', html: '<form action="#" method="post" style="display: grid; gap: 0.5rem; max-width: 24rem;">\n  <label for="field-name">Name</label>\n  <input id="field-name" name="name" type="text">\n  <button type="submit">Send</button>\n</form>' },
      { id: 'field', label: 'Text field', hint: 'A labelled single-line input', html: '<label>Label\n  <input name="field" type="text">\n</label>' },
      { id: 'textarea', label: 'Text area', hint: 'A labelled multi-line input', html: '<label>Message\n  <textarea name="message" rows="4"></textarea>\n</label>' },
      { id: 'select', label: 'Dropdown', hint: 'A labelled list of choices', html: '<label>Choose one\n  <select name="choice">\n    <option>First choice</option>\n    <option>Second choice</option>\n  </select>\n</label>' },
      { id: 'checkbox', label: 'Checkbox', hint: 'A labelled checkbox', html: '<label><input name="agree" type="checkbox"> I agree</label>' },
    ],
  },
  {
    title: 'Data',
    items: [
      {
        id: 'table',
        label: 'Table',
        hint: 'A table with a header row',
        html: '<table>\n  <thead>\n    <tr>\n      <th>Item</th>\n      <th>Value</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>First</td>\n      <td>1</td>\n    </tr>\n    <tr>\n      <td>Second</td>\n      <td>2</td>\n    </tr>\n  </tbody>\n</table>',
      },
      { id: 'dl', label: 'Term list', hint: 'Terms with descriptions', html: '<dl>\n  <dt>Term</dt>\n  <dd>Its description.</dd>\n</dl>' },
    ],
  },
];
