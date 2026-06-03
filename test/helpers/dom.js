/** Helpers for loading the extension's HTML into the jsdom document. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Inject the <body> contents of an extension HTML file into the current
 * document. Scripts inserted via innerHTML do NOT execute (jsdom behaviour),
 * so this gives us the element tree without running the page's own JS.
 */
function loadHtmlBody(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  document.body.innerHTML = match ? match[1] : html;
}

/** Reset the document to a clean slate between tests. */
function resetDom() {
  document.documentElement.innerHTML = '<head></head><body></body>';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.backgroundColor = '';
}

module.exports = { loadHtmlBody, resetDom, ROOT };
