// fastmark — an original Markdown-to-HTML renderer.
//
// parse(markdown) returns the HTML for a Markdown string, following the
// CommonMark block/inline structure with GitHub-flavoured extensions
// (tables, strikethrough, task lists, extended autolinks). The parser is a
// line-oriented container parser for blocks and a delimiter-stack parser
// for inline content. It keeps no state between calls: every call builds a
// fresh definition table and node tree.

'use strict';

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text the way a renderer escapes character data: `&` is left alone
// when it already introduces an entity-looking reference (`&word;`,
// `&#123;`, `&#x1F;`), the other specials are always escaped.
export function escapeText(s) {
  return s.replace(/&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);)|[<>"']/g,
    ch => ESCAPES[ch]);
}

// Escape with no exceptions (code spans and code blocks).
export function escapeCode(s) {
  return s.replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

// Escape a value placed inside a double-quoted attribute.
export function escapeAttr(s) {
  return s.replace(/&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);)|[<"]/g,
    ch => ESCAPES[ch]);
}

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
function isPunct(ch) { return ch !== undefined && PUNCT.has(ch); }
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n'; }
// Unicode whitespace (the reference renderer's \s): flanking rules treat
// a non-breaking space and friends as whitespace.
function isUniSpace(ch) { return ch !== undefined && /\s/.test(ch); }

// Decode numeric character references (decimal and hex) to their code
// points; 0 and invalid values become U+FFFD. Named references are left
// exactly as written.
export function decodeNumericRefs(s) {
  if (!s.includes('&#')) return s;
  return s.replace(/&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});/g, (m, dec, hex) => {
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
    return String.fromCodePoint(cp);
  });
}
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', reg: '®',
  nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', trade: '™',
  laquo: '«', raquo: '»', times: '×', divide: '÷', plusmn: '±',
  deg: '°', micro: 'µ', para: '¶', middot: '·', bull: '•',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  alpha: 'α', beta: 'β', gamma: 'γ', pi: 'π', omega: 'ω',
  infin: '∞', ne: '≠', le: '≤', ge: '≥', minus: '−',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  iexcl: '¡', iquest: '¿', szlig: 'ß', agrave: 'à', eacute: 'é',
  ccedil: 'ç', ntilde: 'ñ', ouml: 'ö', uuml: 'ü', auml: 'ä',
};

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = (body[1] === 'x' || body[1] === 'X')
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
      return String.fromCodePoint(cp);
    }
    const v = NAMED_ENTITIES[body];
    return v === undefined ? m : v;
  });
}

// Normalise a link label for definition lookup: decode references, fold
// case, collapse internal whitespace to single spaces.
export function normalizeLabel(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Percent-encode a link destination for output: encodeURI, then undo the
// double-encoding of literal percent signs.
export function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// Block structure
// ---------------------------------------------------------------------------
// Nodes: containers (doc, quote, list, item) hold `children`; leaves hold
// `text` (para, heading, code, html) or table parts. Parsing walks the input
// line by line: match the open containers against the line's prefix, close
// the ones that no longer match, open new blocks, then feed the rest of the
// line to the deepest open leaf.

function blockNode(t, extra) {
  const n = { t, children: null, text: '', parent: null };
  if (extra) Object.assign(n, extra);
  if (t === 'doc' || t === 'quote' || t === 'list' || t === 'item') n.children = [];
  return n;
}

// A mutable cursor over one line: byte offset `i`, visual column `col`.
function makeCursor(s) { return { s, i: 0, col: 0 }; }

function tabWidth(col) { return 4 - (col % 4); }

// Advance over exactly `n` columns of spaces/tabs. Returns false when a
// non-space comes first. A partially consumed tab is replaced by spaces.
function advanceCols(c, n) {
  while (n > 0) {
    const ch = c.s[c.i];
    if (ch === ' ') { c.i++; c.col++; n--; }
    else if (ch === '\t') {
      const w = tabWidth(c.col);
      if (w <= n) { c.i++; c.col += w; n -= w; }
      else {
        c.s = c.s.slice(0, c.i) + ' '.repeat(w) + c.s.slice(c.i + 1);
        c.i += n; c.col += n; n = 0;
      }
    } else return false;
  }
  return true;
}

// Advance over up to `n` columns of indentation; returns how many columns
// were actually consumed (stops at the first non-space).
function advanceUpTo(c, n) {
  let done = 0;
  while (done < n) {
    const ch = c.s[c.i];
    if (ch === ' ') { c.i++; c.col++; done++; }
    else if (ch === '\t') {
      const w = tabWidth(c.col);
      if (w <= n - done) { c.i++; c.col += w; done += w; }
      else {
        c.s = c.s.slice(0, c.i) + ' '.repeat(w) + c.s.slice(c.i + 1);
        c.i += n - done; c.col += n - done; done = n;
      }
    } else break;
  }
  return done;
}

// Columns of indentation at the cursor without moving it.
function indentAt(c) {
  let col = c.col, i = c.i, n = 0;
  while (i < c.s.length) {
    const ch = c.s[i];
    if (ch === ' ') { n++; col++; i++; }
    else if (ch === '\t') { const w = tabWidth(col); n += w; col += w; i++; }
    else break;
  }
  return n;
}

function restBlank(c) { return /^[ \t]*$/.test(c.s.slice(c.i)); }
function rest(c) { return c.s.slice(c.i); }

// --- block start matchers (operate on a cursor positioned at content) ---

// ATX heading at the cursor: returns {level, text} or null.
function matchATX(c) {
  const save = { i: c.i, col: c.col, s: c.s };
  advanceUpTo(c, 3);
  const m = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(rest(c));
  if (!m) { Object.assign(c, save); return null; }
  let text = (m[2] || '').replace(/[ \t]+$/, '');
  // A closing run of #s preceded by a space (or alone) is not content.
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '');
  return { level: m[1].length, text };
}

// Thematic break at the cursor.
function matchHR(c) {
  const save = { i: c.i, col: c.col, s: c.s };
  advanceUpTo(c, 3);
  const ok = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(rest(c));
  if (!ok) Object.assign(c, save);
  return ok;
}

// Setext underline at the cursor: returns level 1/2 or 0.
function matchSetext(c) {
  const save = { i: c.i, col: c.col, s: c.s };
  advanceUpTo(c, 3);
  const m = /^([=-]+)[ \t]*$/.exec(rest(c));
  if (!m) { Object.assign(c, save); return 0; }
  return m[1][0] === '=' ? 1 : 2;
}

// Fenced code start: returns {ch, len, indent, info} or null.
function matchFence(c) {
  const save = { i: c.i, col: c.col, s: c.s };
  const wsChars = /^[ \t]*/.exec(rest(c))[0].length;
  const indent = advanceUpTo(c, 3);
  const m = /^(`{3,}|~{3,})(.*)$/.exec(rest(c));
  if (!m) { Object.assign(c, save); return null; }
  const info = m[2].replace(/^[ \t]+|[ \t]+$/g, '');
  if (m[1][0] === '`' && info.includes('`')) { Object.assign(c, save); return null; }
  // The reference renderer compensates content indentation only for
  // backtick fences, by the fence line's own leading-whitespace count.
  return { ch: m[1][0], len: m[1].length, indent, strip: m[1][0] === '`' ? wsChars : 0, info };
}

// Blockquote start: consume `>` and one optional space column. The
// whitespace run after the marker is rebuilt the reference renderer's
// way: its tabs expand at tab stops counted from the marker's own start
// (the line's leading spaces plus the `>`), then one character of the
// expanded run is dropped. The cursor stays right after the `>`, with
// the rebuilt remainder as the line's rest.
function matchQuoteMark(c) {
  const save = { i: c.i, col: c.col, s: c.s };
  const indent = advanceUpTo(c, 3);
  if (c.s[c.i] !== '>') { Object.assign(c, save); return false; }
  c.i++; c.col++;
  if (c.s[c.i] === ' ' || c.s[c.i] === '\t') {
    let j = c.i;
    while (j < c.s.length && (c.s[j] === ' ' || c.s[j] === '\t')) j++;
    let run = '', col = indent + 1;
    for (let k = c.i; k < j; k++) {
      if (c.s[k] === '\t') { const w = 4 - (col % 4); run += ' '.repeat(w); col += w; }
      else { run += ' '; col++; }
    }
    c.s = c.s.slice(0, c.i) + run.slice(1) + c.s.slice(j);
  }
  return true;
}

// List marker at the cursor. Returns marker data or null. `contentCol` is
// the absolute column where the item's content begins.
function matchListMarker(c) {
  const save = { i: c.i, col: c.col, s: c.s };
  advanceUpTo(c, 3);
  const startCol = c.col;
  let m = /^([-+*])(?=[ \t]|$)/.exec(rest(c));
  let ordered = false, bullet = null, delim = null, num = 0;
  if (m) { bullet = m[1]; c.i += 1; c.col += 1; }
  else {
    m = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest(c));
    if (!m) { Object.assign(c, save); return null; }
    ordered = true; num = parseInt(m[1], 10); delim = m[2];
    c.i += m[1].length + 1; c.col += m[1].length + 1;
  }
  const markerEndCol = c.col;
  // Spaces after the marker: 1-4 make the content start after them; 5+ or
  // end-of-line make it start one column after the marker.
  let spaces = 0, j = c.i, col = c.col;
  while (j < c.s.length && (c.s[j] === ' ' || c.s[j] === '\t')) {
    const w = c.s[j] === ' ' ? 1 : tabWidth(col);
    spaces += w; col += w; j++;
  }
  const empty = j >= c.s.length;
  let contentCol;
  if (empty || spaces > 4) {
    contentCol = markerEndCol + 1;
    // Consume just one column of the padding.
    if (!empty) advanceCols(c, 1); else { c.i = j; c.col = col; }
  } else {
    contentCol = markerEndCol + spaces;
    c.i = j; c.col = col;
  }
  return { ordered, bullet, delim, num, startCol, contentCol, empty };
}

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start conditions, following the reference renderer's model:
// raw blocks (script/pre/style/textarea, comments, processing instructions,
// declarations, CDATA) run to their closing marker; tag blocks run to the
// next blank line. A complete tag that is alone on its line also starts a
// tag block, but may not interrupt a paragraph. Returns {kind:'raw', end}
// or {kind:'tag'} or null.
function matchHTMLBlock(c, inParagraph) {
  const save = { i: c.i, col: c.col, s: c.s };
  advanceUpTo(c, 3);
  const s = rest(c);
  if (s[0] !== '<') { Object.assign(c, save); return null; }
  if (s.startsWith('<!--')) return { kind: 'raw', end: 'comment' };
  if (s.startsWith('<?')) return { kind: 'raw', end: 'pi' };
  if (s.startsWith('<![CDATA[')) return { kind: 'raw', end: 'cdata' };
  if (/^<![A-Z]/.test(s)) return { kind: 'raw', end: 'decl' };
  const raw = /^<(\/?)(script|pre|style|textarea)(?=[\s>]|$)/i.exec(s);
  if (raw && !(inParagraph && raw[1] === '/')) return { kind: 'raw', end: 'rawtag', tag: raw[2].toLowerCase() };
  // A block-level tag name starts a tag block even when the tag itself is
  // not completed on this line.
  if (BLOCK_TAG_START_RE.test(s)) return { kind: 'tag' };
  const tag = matchOpenTag(s) || matchCloseTag(s);
  if (tag) {
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag)[1].toLowerCase();
    if (HTML_BLOCK_TAGS.has(name)) return { kind: 'tag' };
    if (!inParagraph && /^[ \t]*$/.test(s.slice(tag.length))) return { kind: 'tag' };
  }
  Object.assign(c, save);
  return null;
}

// Whether line `s` closes a raw HTML block (the line is part of the block).
function htmlRawEnds(node, s) {
  switch (node.htmlEnd) {
    case 'comment': return s.includes('-->');
    case 'pi': return s.includes('?>');
    case 'decl': return s.includes('>');
    case 'cdata': return s.includes(']]>');
    case 'rawtag': return new RegExp('</' + node.htmlTag + '(?=[\\s>]|$)', 'i').test(s);
    default: return false;
  }
}

const BLOCK_TAG_START_RE = new RegExp(
  '^</?(?:' + [...HTML_BLOCK_TAGS].sort((a, b) => b.length - a.length).join('|') + ')(?=[\\s/>]|$)', 'i');

const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTR = "(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)";
const OPEN_TAG_RE = new RegExp('^<' + TAG_NAME + ATTR + '*\\s*/?>');
const CLOSE_TAG_RE = new RegExp('^</' + TAG_NAME + '\\s*>');
function matchOpenTag(s) { const m = OPEN_TAG_RE.exec(s); return m && m[0]; }
function matchCloseTag(s) { const m = CLOSE_TAG_RE.exec(s); return m && m[0]; }

// --- tables ---

// Split a table row into cell strings, the reference renderer's way:
// every pipe preceded by an even number of backslashes (zero included)
// is a delimiter — pipes inside code spans are NOT protected — escaped
// pipes become literal pipes in the cell text, whitespace-only edge
// cells from a leading/trailing pipe are dropped, and the row is padded
// or truncated to `count` cells when a count is given.
export function splitCells(line, count) {
  const markedLine = line.replace(/\|/g, (m, off, str) => {
    let esc = false, p = off;
    while (--p >= 0 && str[p] === '\\') esc = !esc;
    return esc ? '|' : ' |';
  });
  const cells = markedLine.split(/ \|/);
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    while (cells.length < count) cells.push('');
  }
  return cells.map(cell => cell.trim().replace(/\\\|/g, '|'));
}

// If `line` is a table delimiter row, return its alignments, else null.
function matchDelimiterRow(line) {
  if (!line.includes('-')) return null;
  const cells = splitCells(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const l = cell.startsWith(':'), r = cell.endsWith(':');
    aligns.push(l && r ? 'center' : r ? 'right' : l ? 'left' : null);
  }
  return aligns;
}

// Whether the line at cursor `c` starts some other block (used to end a
// table's rows). Probes on a copy; the real cursor is untouched. The
// reference renderer's table body also stops at an indented code line:
// four spaces, or up to three spaces and a tab, followed by content.
function startsOtherBlock(c) {
  const probe = { ...c };
  return matchQuoteMark(probe) || !!matchATX({ ...c }) || !!matchFence({ ...c })
    || matchHR({ ...c }) || !!matchHTMLBlock({ ...c }, false) || !!matchListMarker({ ...c })
    || /^(?: {4}| {0,3}\t)\S/.test(rest(c));
}

// --- link reference definitions ---

// Parse one link reference definition at the start of `s` (a paragraph's
// raw text). On success returns {label, href, title, rest}; else null.
function parseOneDef(s) {
  let i = 0;
  const skipWs = (allowNewline) => {
    let nl = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t') i++;
      else if (ch === '\n' && allowNewline && nl < 1) { nl++; i++; }
      else break;
    }
  };
  if (s[i] !== '[') return null;
  // Label: up to the first unescaped ], no unescaped [ inside, <= 999 chars.
  let j = i + 1, label = '';
  while (j < s.length && s[j] !== ']') {
    if (s[j] === '\\' && j + 1 < s.length) { label += s[j] + s[j + 1]; j += 2; continue; }
    if (s[j] === '[') return null;
    label += s[j]; j++;
  }
  if (j >= s.length || label.length > 999 || label.trim() === '') return null;
  if (s[j + 1] !== ':') return null;
  i = j + 2;
  skipWs(true);
  // Destination.
  let href = '';
  if (s[i] === '<') {
    let k = i + 1;
    while (k < s.length && s[k] !== '>' && s[k] !== '\n') {
      if (s[k] === '\\' && k + 1 < s.length) k++;
      k++;
    }
    if (s[k] !== '>') return null;
    href = s.slice(i + 1, k);
    i = k + 1;
  } else {
    let depth = 0, k = i;
    while (k < s.length) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < s.length) { k += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (ch === ' ' || ch === '\t' || ch === '\n') break;
      else if (ch < ' ') break;
      k++;
    }
    if (k === i || depth !== 0) return null;
    href = s.slice(i, k);
    i = k;
  }
  // Optional title: it must be separated from the destination by
  // whitespace, and after it only whitespace may remain on its line. A
  // title that fails either test leaves a definition without a title,
  // ending at the destination's own line.
  const beforeWs = i;
  skipWs(true);
  let title = null;
  const q = s[i];
  if (i > beforeWs && (q === '"' || q === "'" || q === '(')) {
    const close = q === '(' ? ')' : q;
    let k = i + 1;
    while (k < s.length && s[k] !== close) {
      if (s[k] === '\\' && k + 1 < s.length) k++;
      if (q === '(' && s[k] === '(') { k = -1; break; }
      k++;
    }
    if (k > 0 && s[k] === close) {
      let t = k + 1;
      while (t < s.length && (s[t] === ' ' || s[t] === '\t')) t++;
      if (t >= s.length || s[t] === '\n') {
        title = s.slice(i + 1, k);
        i = t;
      } else {
        i = beforeWs;
      }
    } else {
      i = beforeWs;
    }
  } else {
    i = beforeWs;
  }
  // The definition must end the line.
  let t = i;
  while (t < s.length && (s[t] === ' ' || s[t] === '\t')) t++;
  if (t < s.length && s[t] !== '\n') return null;
  if (s[t] === '\n') t++;
  return { label, href, title, rest: s.slice(t) };
}

// Pull every definition off the front of a paragraph's text. Registers them
// (first definition of a label wins) and returns the remaining text.
function extractDefs(text, defs) {
  let s = text;
  for (;;) {
    const t = s.replace(/^[ \t\n]+/, '');
    const d = parseOneDef(t);
    if (!d) break;
    const key = normalizeLabel(d.label);
    if (!defs.has(key)) {
      defs.set(key, { href: decodeEscapes(d.href), title: d.title === null ? null : decodeEscapes(d.title) });
    }
    s = d.rest;
    if (s.trim() === '') { s = ''; break; }
  }
  return s;
}

// Resolve backslash escapes of punctuation to the escaped character.
export function decodeEscapes(s) {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

// --- the block parser ---

function lexBlocks(src, defs) {
  const root = blockNode('doc');
  const stack = [root];
  // Paragraphs closed by a whitespace-only line that may yet turn out to
  // be their container's last line (see the blank-line path), and whether
  // the line being processed matched every open container.
  const pendingTrails = new Set();
  const pendingNl = [];
  // Per line, the whitespace-only-ness of the remainder before each
  // stack depth's container matched (this line's and the previous').
  let restBlankAt = [];
  let prevRestBlankAt = [];
  let lineMatchedAll = false;
  const top = () => stack[stack.length - 1];
  const isContainer = n => n.children !== null;

  function finalizeNode(n, depth) {
    // A node ends on a blank line when the previous line was blank at
    // the node's own depth — the remainder after its ancestors matched
    // was whitespace-only (so a quote-only line ">" is blank for the
    // items inside the quote, while a line "  >" is not blank for an
    // item at the top level) — or the last line incorporated into it
    // before that was raw-blank.
    n.endedBlank = !!((depth !== undefined && prevRestBlankAt[depth])
      || (n.lastLineBlank && curRawBlank));
    switch (n.t) {
      case 'para': {
        n.text = extractDefs(n.text, defs);
        if (n.text.trim() === '' && n.parent) {
          const ix = n.parent.children.indexOf(n);
          if (ix >= 0) n.parent.children.splice(ix, 1);
          n.dead = true;
        }
        break;
      }
      case 'code':
        if (!n.fenced) {
          // Trailing blank lines are not content, spaces and all.
          n.text = n.text.replace(/(?:\n[ \t]*)+$/, '');
          if (n.text) n.text += '\n';
        } else if (/^\n+$/.test(n.text)) {
          // A body of nothing but blank lines loses one newline too.
          n.text = n.text.slice(0, -1);
        } else if (n.text.length > 1 && n.text.endsWith('\n\n')) {
          // The closing fence's own line break is not content: a single
          // trailing blank line is dropped.
          n.text = n.text.slice(0, -1);
        }
        break;
      case 'list': {
        // Loose in exactly the reference renderer's two situations: an
        // item before the last ends on a blank line, or a blank line at
        // an item's own level separated two of its block children.
        let tight = true;
        const items = n.children;
        for (let k = 0; k < items.length; k++) {
          const item = items[k];
          if (k < items.length - 1 && item.endedBlank) tight = false;
          if (item.looseBetween) tight = false;
        }
        n.tight = tight;
        break;
      }
    }
  }

  function popOne() { const n = stack.pop(); finalizeNode(n, stack.length); return n; }
  function containerCountOf() { let n = 0; for (const b of stack) if (isContainer(b)) n++; return n; }
  function closeDownTo(depth) { while (stack.length > depth) popOne(); }
  function openNode(n) {
    const p = top();
    n.parent = p;
    p.children.push(n);
    noteItemChild(p);
    stack.push(n);
    return n;
  }
  function addLeaf(n) { // attach without leaving it open
    const p = top();
    n.parent = p;
    p.children.push(n);
    noteItemChild(p);
    finalizeNode(n);
    return n;
  }
  // A child arriving in an item after a blank line that followed an
  // earlier child proves the blank separated two of the item's blocks
  // (a definition-only paragraph still counts: it is a block token for
  // the reference renderer, even though it later vanishes).
  function noteItemChild(p) {
    if (p.t === 'item' && p.blankAts
      && p.blankAts.some(b => b >= 1 && b < p.children.length)) p.looseBetween = true;
  }
  function markBlank(v) {
    for (const n of stack) {
      n.lastLineBlank = v;
      if (v && n.children && n.children.length > 0) n.blankAfterContent = true;
      if (!v && n.t === 'item') n.prevBlank = false;
    }
    if (v && lineMatchedAll) {
      // A blank line inside a container settles every paragraph trail
      // stashed in it: the stashed whitespace line was a separator after
      // all, not the container's last line.
      for (const p of pendingTrails) {
        if (p.parent && stack.includes(p.parent)) { p.trailWs = undefined; pendingTrails.delete(p); }
      }
    }
    if (v) {
      // Remember, for every open list item, which of its children the
      // blank line followed (the child on the open path, or the last
      // child when the item itself is the deepest open container). A
      // blank that later proves to sit strictly inside the item's child
      // list separated two of its blocks.
      for (let k = 1; k < stack.length; k++) {
        const n = stack[k];
        if (n.t !== 'item' || n.children.length === 0) continue;
        const child = k + 1 < stack.length ? stack[k + 1] : n.children[n.children.length - 1];
        const ix = n.children.indexOf(child);
        if (ix >= 0) (n.blankAts ??= []).push(ix + 1);
      }
    }
  }

  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  let prevLineBlank = false;
  let curRawBlank = false;
  for (let ln = 0; ln < lines.length; ln++) {
    // Every block still open incorporated the previous line: remember
    // its raw blankness before this line's processing overwrites it.
    for (const n of stack) n.feedBlank = prevLineBlank;
    prevRestBlankAt = restBlankAt; restBlankAt = [];
    curRawBlank = /^[ \t]*$/.test(lines[ln]);
    const c = makeCursor(lines[ln]);

    // -- match open containers --
    let matched = 1; // the doc always matches
    let ci = 1;
    let itemMarkerSeen = false;
    while (ci < stack.length && isContainer(stack[ci])) {
      const n = stack[ci];
      restBlankAt[ci] = restBlank(c);
      if (n.t === 'quote') {
        // A quote matches only lines carrying its prefix — a blank line
        // without one ends the quote.
        if (!matchQuoteMark(c)) break;
      } else if (restBlank(c)) {
        // A blank remainder matches lists and items freely, but a quote
        // deeper in the stack still needs its prefix on the line, and an
        // item with no content yet does not survive a blank line at all.
        let j = ci;
        while (j < stack.length && isContainer(stack[j]) && stack[j].t !== 'quote'
          && !(stack[j].t === 'item' && stack[j].children.length === 0)) j++;
        // The remainder is blank here, so it is blank at every deeper
        // level the shortcut crosses as well.
        for (let d = ci + 1; d <= j; d++) restBlankAt[d] = true;
        matched = j;
        break;
      } else if (n.t === 'item') {
        // An item that is still empty does not survive a blank line.
        if (n.children.length === 0 && restBlank(c)) break;
        // Item indentation is relative: from where this item's match
        // begins, the line must advance the item's content offset in
        // columns (prefix widths of quotes vary from line to line).
        const need = n.relContent;
        if (need > 0) {
          const sv = { i: c.i, col: c.col, s: c.s };
          if (!advanceCols(c, need)) {
            Object.assign(c, sv);
            // A list marker at this level means a sibling item follows:
            // the item does not match, and the line is no lazy text.
            if (matchListMarker({ ...c })) itemMarkerSeen = true;
            break;
          }
        }
      }
      // lists match without consuming anything
      matched = ++ci;
    }
    const containerCount = containerCountOf();
    const matchedAll = matched === containerCount;
    lineMatchedAll = matchedAll;
    const blank = restBlank(c);
    prevLineBlank = curRawBlank;
    let tip = top();
    // Every block open at the start of this line shares its blankness:
    // a block closed by this line still ends with this line's status.
    for (const n of stack) n.lastLineBlank = blank;

    // A tab that begins exactly where container matching stopped is
    // expanded to the spaces it stands for at its absolute column (the
    // reference renderer rebuilds such lines); tabs elsewhere are kept.
    if (matched > 1 && c.s[c.i] === '\t') {
      let col = c.col, j = c.i, out = '';
      while (c.s[j] === '\t') { const w = tabWidth(col); out += ' '.repeat(w); col += w; j++; }
      c.s = c.s.slice(0, c.i) + out + c.s.slice(j);
    }

    // Resolve the trailing-newline question of any raw HTML block that
    // closed on the previous line: it keeps the newline iff this line,
    // inside the block's own container chain, is not completely empty.
    if (pendingNl.length) {
      for (const node of pendingNl) {
        const chain = node._chain; delete node._chain;
        let ok = chain.length < matched;
        for (let d = 0; ok && d < chain.length; d++)
          if (stack[d + 1] !== chain[d]) ok = false;
        node.nl = ok ? (chain.length < matched - 1 || rest(c) !== '') : false;
      }
      pendingNl.length = 0;
    }

    // A fenced code block inside list items swallows lines that fail to
    // match the items only once it is "armed" by a content line that did
    // match them, and a blank content line disarms it again. A block
    // quote ancestor is stricter: a line without its prefix ends the
    // quote (and the fence with it).
    if (tip.t === 'code' && tip.fenced) {
      let gated = false;
      for (let k = 1; k < stack.length - 1; k++) {
        if (stack[k].t === 'quote' && k >= matched) { gated = true; break; }
      }
      if (!gated && (matchedAll || (tip.armed && !blank))) {
        const probe = { ...c };
        advanceUpTo(probe, 3);
        const m = new RegExp('^' + tip.fenceCh + '{' + tip.fenceLen + ',}[ \\t]*$').exec(rest(probe));
        if (m) { popOne(); closeDownTo(matched); markBlank(false); continue; }
        // Content lines lose up to the fence line's leading-whitespace
        // count in characters (backtick fences only; tilde fences keep
        // their content exactly as it stands).
        for (let n = tip.fenceIndent; n > 0 && (c.s[c.i] === ' ' || c.s[c.i] === '\t'); n--) {
          if (c.s[c.i] === '\t') c.col += tabWidth(c.col); else c.col++;
          c.i++;
        }
        tip.text += rest(c) + '\n';
        if (blank) tip.armed = false;
        else if (matchedAll) tip.armed = true;
        markBlank(false);
        continue;
      }
    }

    // -- lazy paragraph continuation: only when the line starts no block --
    if (!matchedAll && tip.t === 'para' && !blank && !itemMarkerSeen) {
      const sv = { i: c.i, col: c.col, s: c.s };
      const aligns = matchDelimiterRow(rest(c));
      if (aligns && rest(c).includes('|') && convertParaToTable(tip, aligns)) {
        markBlank(false);
        continue;
      }
      let starts = false;
      if (matchATX(c) || matchFence(c) || matchHR(c) || matchQuoteMark(c)) starts = true;
      else {
        const mk = matchListMarker(c);
        if (mk && !mk.empty && (!mk.ordered || mk.num === 1 || insideItem(tip))) starts = true;
        else if (matchHTMLBlock(c, true)) starts = true;
      }
      Object.assign(c, sv);
      if (!starts) {
        const lazyIndent = indentAt(c);
        // Lazy text keeps the line as it stands after the containers
        // that did match: the reference renderer appends under-indented
        // continuation lines to the item text verbatim rather than
        // dedenting them to the item's content column.
        // A setext-looking lazy line after an earlier lazy line is kept as
        // paragraph text with four spaces in front of it (the reference
        // renderer's quirk); it never becomes a heading either way.
        let text = rest(c);
        if (lazyIndent >= 4) text = text.replace(/^[ \t]+/, '');
        if ((tip.lazyLines || 0) > 0 && /^[ \t]*[=-]+[ \t]*$/.test(text)) text = '    ' + text.replace(/^[ \t]+/, '');
        tip.lazyLines = (tip.lazyLines || 0) + 1;
        tip.text += '\n' + text;
        markBlank(false);
        continue;
      }
      closeDownTo(matched);
      tip = top();
    } else if (!matchedAll) {
      closeDownTo(matched);
      tip = top();
    }

    // -- continuing leaf blocks --
    if (matchedAll) {
      if (tip.t === 'code' && !tip.fenced) {
        if (blank) {
          // A blank line inside an indented code block keeps whatever
          // indentation it has beyond the four stripped columns.
          advanceUpTo(c, 4);
          tip.text += rest(c) + '\n';
          continue;
        }
        if (indentAt(c) >= 4) {
          advanceCols(c, 4);
          tip.text += rest(c) + '\n';
          markBlank(false);
          continue;
        }
        popOne(); tip = top();
      } else if (tip.t === 'html') {
        if (tip.htmlKind === 'raw') {
          tip.text += '\n' + rest(c);
          if (htmlRawEnds(tip, lines[ln])) finishHtml(tip, ln);
          markBlank(false);
          continue;
        }
        if (!blank) { tip.text += '\n' + rest(c); markBlank(false); continue; }
        tip.nl = false;
        popOne(); tip = top(); // fall into the blank-line path
      } else if (tip.t === 'table') {
        // A table's rows run until a line of nothing but spaces (a line
        // holding a tab is a row like any other) or a line that starts
        // another block; pipe-less lines are rows too.
        if (!/^ *$/.test(rest(c)) && !startsOtherBlock(c)) {
          const cells = splitCells(rest(c));
          while (cells.length < tip.header.length) cells.push('');
          tip.rows.push(cells.slice(0, tip.header.length));
          markBlank(false);
          continue;
        }
        popOne(); tip = top(); // fall through: blank path or a new block
      }
    }

    // -- blank line --
    if (blank) {
      markBlank(true);
      if (top().t === 'para') {
        const tp = top();
        // A whitespace-only line that leaves actual whitespace behind
        // its containers is a paragraph separator — unless it turns out
        // to be the last line of the paragraph's container, in which
        // case the reference renderer keeps it as paragraph content.
        // Stash it; the render step appends it when the paragraph stays
        // its parent's last child. List items are exempt: their text is
        // trimmed of trailing blank lines instead. At the top level the
        // line only counts when it is the input's last line and the
        // input does not end with a newline after it.
        if (matchedAll && tp.parent && tp.parent.t !== 'item' && rest(c) !== ''
          && (tp.parent.t !== 'doc' || (ln === lines.length - 1 && !src.endsWith('\n')))) {
          tp.trailWs = rest(c);
          pendingTrails.add(tp);
        }
        popOne();
      }
      continue;
    }

    // -- open new blocks --
    let lineDone = false;
    while (!lineDone) {
      const cur = top();
      if (cur.t === 'para') {
        const lineRest = rest(c);
        const lvl = matchSetext(c);
        if (lvl) {
          // Definitions at the paragraph's head are stripped before the
          // conversion; if nothing else remains, the underline line is
          // plain paragraph text instead.
          cur.text = extractDefs(cur.text, defs);
          if (cur.text.trim() !== '') {
            cur.t = 'heading'; cur.level = lvl;
            popOne();
            lineDone = true; break;
          }
          popOne();
          const p = openNode(blockNode('para'));
          p.text = lineRest;
          lineDone = true; break;
        }
        const aligns = matchDelimiterRow(rest(c));
        if (aligns && rest(c).includes('|') && convertParaToTable(cur, aligns)) {
          lineDone = true; break;
        }
        // Blocks that may interrupt a paragraph.
        let atx = matchATX(c);
        if (atx) { popOne(); addLeaf(blockNode('heading', { level: atx.level, text: atx.text })); lineDone = true; break; }
        let fen = matchFence(c);
        if (fen) {
          popOne();
          const code = openNode(blockNode('code', { fenced: true, fenceCh: fen.ch, fenceLen: fen.len, fenceIndent: fen.strip, info: fen.info, text: '' }));
          code.lastLineBlank = false;
          lineDone = true; break;
        }
        if (matchHR(c)) { popOne(); addLeaf(blockNode('hr')); lineDone = true; break; }
        if (matchQuoteMark(c)) { popOne(); openNode(blockNode('quote')); continue; }
        const mkSave = { i: c.i, col: c.col, s: c.s };
        const mk = matchListMarker(c);
        if (mk && !mk.empty && (!mk.ordered || mk.num === 1 || insideItem(cur))) {
          popOne();
          insertListItem(mk, mkSave.col);
          continue;
        }
        Object.assign(c, mkSave);
        const hStart = c.i;
        const hb = matchHTMLBlock(c, true);
        if (hb) {
          popOne();
          startHtml(hb, c.s.slice(hStart), ln);
          lineDone = true; break;
        }
        break; // plain continuation
      }
      // container context
      if (cur.t === 'list') {
        // Only a sibling item may start inside a list; any other block
        // closes the list and is retried at the parent level. A thematic
        // break line is never an item.
        if (matchHR(c)) { popOne(); continue; }
        const base = c.col;
        const mk = matchListMarker(c);
        if (mk) { insertListItem(mk, base); continue; }
        popOne();
        continue;
      }
      if (matchQuoteMark(c)) { openNode(blockNode('quote')); continue; }
      const atx = matchATX(c);
      if (atx) { addLeaf(blockNode('heading', { level: atx.level, text: atx.text })); lineDone = true; break; }
      const fen = matchFence(c);
      if (fen) {
        openNode(blockNode('code', { fenced: true, fenceCh: fen.ch, fenceLen: fen.len, fenceIndent: fen.strip, info: fen.info, text: '' }));
        lineDone = true; break;
      }
      if (matchHR(c)) { addLeaf(blockNode('hr')); lineDone = true; break; }
      const hStart = c.i;
      const hb = matchHTMLBlock(c, false);
      if (hb) {
        startHtml(hb, c.s.slice(hStart), ln);
        lineDone = true; break;
      }
      if (indentAt(c) >= 4) {
        advanceCols(c, 4);
        const code = openNode(blockNode('code', { fenced: false, text: '' }));
        code.text += rest(c) + '\n';
        lineDone = true; break;
      }
      const mkBase = c.col;
      const mk = matchListMarker(c);
      if (mk) { insertListItem(mk, mkBase); continue; }
      break;
    }
    if (lineDone) { markBlank(false); continue; }

    // A line left blank after its containers and block starts (say a
    // lone list marker) creates no paragraph.
    if (restBlank(c)) {
      markBlank(true);
      if (top().t === 'para') popOne();
      continue;
    }

    // -- feed the line to a paragraph (its text is kept exactly as written) --
    if (top().t === 'para') {
      top().text += '\n' + rest(c);
    } else if (top().t !== 'code' && top().t !== 'html' && top().t !== 'table') {
      const p = openNode(blockNode('para'));
      p.text = rest(c);
    }
    markBlank(false);
  }

  // An HTML block still open at end of input keeps the source's final
  // newline; one closed any other way has it decided by then.
  for (const n of stack) if (n.t === 'html' && n.nl === undefined) n.nl = src.endsWith('\n');
  closeDownTo(1);
  return root;

  // Open an HTML block whose first line is `firstText` (indentation kept).
  function startHtml(hb, firstText, ln) {
    const html = openNode(blockNode('html', {
      htmlKind: hb.kind, htmlEnd: hb.end, htmlTag: hb.tag, text: firstText,
    }));
    if (hb.kind === 'raw' && htmlRawEnds(html, firstText)) finishHtml(html, ln);
    return html;
  }

  // Close a raw HTML block on its closing line. Whether the block text
  // keeps a trailing newline depends on the next line inside the same
  // container: it does iff that line is not completely empty (a line of
  // spaces or a tab counts as non-empty). That is only known once the
  // next line's containers are matched, so the decision is deferred.
  function finishHtml(node, ln) {
    if (lines[ln + 1] === undefined) node.nl = src.endsWith('\n');
    else { node._chain = stack.slice(1, stack.indexOf(node)); pendingNl.push(node); }
    popOne();
  }

  // Turn a one-line paragraph into a table whose delimiter row has just
  // been seen. Returns false when the shapes do not fit.
  function convertParaToTable(para, aligns) {
    if (para.text.includes('\n')) return false;
    const header = splitCells(para.text);
    if (header.length !== aligns.length) return false;
    const parent = para.parent;
    const ix = parent.children.indexOf(para);
    const tbl = blockNode('table', { header, aligns, rows: [] });
    tbl.parent = parent;
    parent.children[ix] = tbl;
    const si = stack.indexOf(para);
    if (si >= 0) stack[si] = tbl;
    return true;
  }

  function insideItem(node) {
    let p = node;
    while (p) { if (p.t === 'item') return true; p = p.parent; }
    return false;
  }

  function insertListItem(mk, baseCol) {
    let cur = top();
    if (cur.t === 'list' && !sameListType(cur, mk)) { popOne(); cur = top(); }
    if (cur.t !== 'list') {
      cur = openNode(blockNode('list', {
        ordered: mk.ordered, bullet: mk.bullet, delim: mk.delim,
        start: mk.num, tight: true,
      }));
    }
    openNode(blockNode('item', { relContent: mk.contentCol - baseCol }));
  }

  // Two consecutive blank lines close the open list items and their lists.
  function blankLineLists() {
    for (;;) {
      const t = top();
      if (t.t === 'item' && t.prevBlank) {
        popOne(); // the item
        if (top().t === 'list') popOne(); // its list
        continue;
      }
      break;
    }
    // Remember, for the next line, which open items saw this blank line.
    for (const n of stack) if (n.t === 'item') n.prevBlank = true;
  }
}

// ---------------------------------------------------------------------------
// Inline structure
// ---------------------------------------------------------------------------
// Inline content is scanned into a flat node list. `[` and `![` push bracket
// records; a later `]` may fold the nodes since the opener into a link or
// image. `*`, `_` and `~~` runs become delimiter nodes on a stack and are
// resolved into em/strong/del wrappers after the scan (and once inside each
// link text, so emphasis never crosses a link boundary).

const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^<>\s]*)>/;
const EMAIL_LINK_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const COMMENT_RE = /^<!--[\s\S]*?-->/;
const PI_RE = /^<\?[\s\S]*?\?>/;
const DECL_RE = /^<![A-Z]+[^>]*>/;
const CDATA_RE = /^<!\[CDATA\[[\s\S]*?\]\]>/;
const WWW_RE = /^(?:www\.[^\s<"]+|[hH][tT][tT][pP][sS]?:\/\/[^\s<"]+|[fF][tT][pP]:\/\/[^\s<"]+)/;
const BARE_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/;
const BARE_EMAIL_FULL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const EMAIL_RUN_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9._~-]+/;
// The reference renderer's own address shape: dot-separated domain
// labels that may contain '-' and '_' but must end alphanumeric, with
// a word-boundary lookahead in the unanchored form.
const MARKED_EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/;
const MARKED_EMAIL_FULL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+$/;

function isUniPunct(ch) {
  if (ch === undefined) return false;
  return /[\p{P}\p{S}]/u.test(ch);
}

// Trim a bare extended autolink: trailing sentence punctuation, unmatched
// closing brackets and a trailing entity-looking tail do not belong to it.
// The reference renderer's bare-autolink trim: repeatedly keep the
// longest prefix built from ordinary runs, atomic (...) groups, lone
// ampersands, and punctuation runs that are not at the very end.
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
function trimAutolink(url) {
  let s = url;
  for (;;) {
    const m = BACKPEDAL_RE.exec(s);
    const next = m ? m[0] : '';
    if (next === s) return s;
    s = next;
    if (!s) return s;
  }
}

// Split a text string into text and extended-autolink nodes the way
// the main scan would have, had no bracket been open. `prevCh` is the
// character just before the string.
function splitAutolinks(s, prevCh) {
  const out = [];
  let buf = '', i = 0;
  const flushB = () => { if (buf) { out.push({ t: 'text', s: buf }); buf = ''; } };
  while (i < s.length) {
    if (!docInLink) {
      const rest = s.slice(i);
      const pc = i === 0 ? prevCh : s[i - 1];
      const isScheme = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//.test(rest);
      const isWww = !isScheme && rest.startsWith('www.')
        && (pc === '' || isUniSpace(pc) || '*_~('.includes(pc));
      if (isScheme || isWww) {
        const wm = WWW_RE.exec(rest);
        if (wm) {
          const url = trimAutolink(wm[0]);
          if (url.length >= 4 && (url.startsWith('www.') ? url.slice(4).includes('.') : true)) {
            flushB();
            out.push({ t: 'link', href: url.startsWith('www.') ? 'http://' + url : url, title: null, children: [{ t: 'text', s: url }], barelink: true });
            i += url.length; continue;
          }
        }
      } else if (/[A-Za-z0-9]/.test(s[i])) {
        const mm = MARKED_EMAIL_RE.exec(rest);
        if (mm) {
          flushB();
          out.push({ t: 'link', href: 'mailto:' + mm[0], title: null, children: [{ t: 'text', s: mm[0] }], barelink: true });
          i += mm[0].length; continue;
        }
      }
    }
    buf += s[i]; i++;
  }
  flushB();
  return out;
}

// Re-lex a dead bracket's range: bare autolinks in its text were
// suppressed while the bracket was open, but with the bracket dead the
// text is ordinary text and the autolinks are live after all. Matches
// run over maximal runs of consecutive text nodes, so a URL may span
// the literal `]` and `(` characters the dead structure left behind.
function rescanRange(nodes, from, endNode) {
  let prevCh = '[';
  let k = from;
  while (k < nodes.length) {
    const ei = nodes.indexOf(endNode);
    if (ei === -1 || k > ei) break;
    const n = nodes[k];
    const isTextRun = n.t === 'text' || (n.t === 'link' && n.barelink);
    if (!isTextRun) {
      if (n.t === 'delim') prevCh = n.s[n.s.length - 1];
      else if (n.t === 'code') prevCh = '`';
      else if (n.t === 'link' || n.t === 'image') prevCh = ')';
      k++; continue;
    }
    let end = k + 1;
    let s = n.t === 'text' ? n.s : n.children[0].s;
    while (end < nodes.length) {
      const nx = nodes[end];
      if (nx.t === 'text') s += nx.s;
      else if (nx.t === 'link' && nx.barelink) s += nx.children[0].s;
      else break;
      end++;
    }
    const parts = splitAutolinks(s, prevCh);
    nodes.splice(k, end - k, ...parts);
    k += parts.length;
    const last = parts[parts.length - 1];
    if (last) prevCh = last.t === 'text' ? last.s[last.s.length - 1] : last.children[0].s.slice(-1);
  }
}

// The last character of a text token the way the reference renderer
// tracks it for emphasis decisions: escape sequences are their own
// tokens there, so a trailing escape pair does not supply the
// character — the text before it does (or nothing, when the raw text
// is only escapes). Returns null when there is no such character.
function lastTextChar(raw) {
  let s = raw;
  while (s.length >= 2 && s.charCodeAt(s.length - 2) === 92 && isPunct(s[s.length - 1])) {
    s = s.slice(0, -2);
  }
  return s.length ? s[s.length - 1] : null;
}

function parseInlineNodes(src, defs) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  const deadRanges = [];
  let buf = '';
  let bufR = '';
  const flush = () => {
    if (buf) {
      nodes.push({ t: 'text', s: buf, ltc: lastTextChar(bufR) });
      buf = ''; bufR = '';
    }
  };

  let i = 0;
  const N = src.length;
  while (i < N) {
    const ch = src[i];

    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush(); nodes.push({ t: 'hardbreak' }); i += 2;
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && isPunct(nx)) { buf += nx === '&' ? '\uE001' : nx; bufR += src.slice(i, i + 2); i += 2; continue; }
      buf += ch; bufR += ch; i++; continue;
    }

    if (ch === '\n') {
      if (/ {2,}$/.test(buf)) {
        const trimmed = buf.length - buf.replace(/ +$/, '').length;
        buf = buf.replace(/ +$/, '');
        bufR = bufR.slice(0, bufR.length - trimmed);
        flush(); nodes.push({ t: 'hardbreak' });
        i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
      } else {
        flush(); nodes.push({ t: 'softbreak' });
        i++;
      }
      continue;
    }

    if (ch === '`') {
      let n = 0; while (src[i + n] === '`') n++;
      // Find a later run of exactly n backticks.
      let j = i + n, found = -1;
      while (j < N) {
        if (src[j] === '`') {
          let m = 0; while (src[j + m] === '`') m++;
          if (m === n) { found = j; break; }
          j += m;
        } else j++;
      }
      if (brackets.length > 0) {
        // Inside a bracket, the reference renderer's label grammar —
        // whose code units allow mismatched backtick runs — may end
        // the label at a ']' this span would otherwise swallow. When
        // the label reads cleanly and a destination or reference
        // follows, the run stays literal so the bracket can close.
        let p = i + n;
        while (p < N && src[p] !== ']' && (found < 0 || p < found)) {
          if (src[p] === '\\') { p += 2; continue; }
          p++;
        }
        if (p < N && src[p] === ']' && (found < 0 || p < found)) {
          const open = brackets[brackets.length - 1];
          const labelText = src.slice(open.contentStart, p);
          let viable = false;
          if (labelOkRe(labelText)) {
            if (src[p + 1] === '(') viable = !!parseInlineDest(src, p + 1);
            else if (src[p + 1] === '[') {
              const lab = scanLabel(src, p + 1);
              if (lab) {
                const rl = lab.text === '' ? labelText : lab.text;
                viable = defs.has(normalizeLabel(rl));
              }
            } else viable = defs.has(normalizeLabel(labelText));
          }
          if (viable) { buf += src.slice(i, i + n); bufR += src.slice(i, i + n); i += n; continue; }
        }
      }
      if (found < 0) { buf += src.slice(i, i + n); bufR += src.slice(i, i + n); i += n; continue; }
      flush();
      let content = src.slice(i + n, found).replace(/\n/g, ' ');
      if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      nodes.push({ t: 'code', s: content });
      i = found + n; continue;
    }

    if (ch === '<') {
      const rest = src.slice(i);
      let m = AUTOLINK_RE.exec(rest);
      if (m) {
        flush();
        nodes.push({ t: 'link', href: m[1], title: null, children: [{ t: 'text', s: m[1] }], autolink: true });
        i += m[0].length; continue;
      }
      m = EMAIL_LINK_RE.exec(rest);
      if (m) {
        flush();
        nodes.push({ t: 'link', href: 'mailto:' + m[1], title: null, children: [{ t: 'text', s: m[1] }], autolink: true });
        i += m[0].length; continue;
      }
      if (rest.startsWith('<!--')) {
        // A comment ends at the first --> , which may overlap the
        // opener itself (<!--> is a complete comment).
        const end = rest.indexOf('-->', 2);
        if (end >= 0) { flush(); nodes.push({ t: 'html', s: rest.slice(0, end + 3) }); i += end + 3; continue; }
      }
      m = PI_RE.exec(rest) || DECL_RE.exec(rest) || CDATA_RE.exec(rest);
      if (m) { flush(); nodes.push({ t: 'html', s: m[0] }); i += m[0].length; continue; }
      m = matchOpenTag(rest) || matchCloseTag(rest);
      if (m) {
        if (!docInLink && /^<a /i.test(m)) docInLink = true;
        else if (docInLink && /^<\/a>/i.test(m)) docInLink = false;
        flush(); nodes.push({ t: 'html', s: m }); i += m.length; continue;
      }
      buf += ch; bufR += ch; i++; continue;
    }

    if (ch === '!' && src[i + 1] === '[') {
      flush();
      const node = { t: 'text', s: '![' };
      nodes.push(node);
      brackets.push({ node, isImage: true, active: true, contentStart: i + 2, delimBottom: delims.length, inLinkAtOpen: docInLink });
      i += 2; continue;
    }

    if (ch === '[') {
      flush();
      const node = { t: 'text', s: '[' };
      nodes.push(node);
      brackets.push({ node, isImage: false, active: true, contentStart: i + 1, delimBottom: delims.length, inLinkAtOpen: docInLink });
      i++; continue;
    }

    if (ch === ']') {
      const openBefore = brackets[brackets.length - 1];
      const res = closeBracket(src, i, nodes, brackets, delims, defs, flush);
      if (res === -1) {
        buf += ch; bufR += ch; i++;
        if (openBefore) {
          // The bracket is dead for now; if no enclosing bracket later
          // claims this range as a label, its text gets re-lexed at the
          // end of the scan with bare autolinks live.
          flush();
          deadRanges.push({ open: openBefore.node, end: nodes[nodes.length - 1] });
        }
      }
      else i = res;
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let n = 0; while (src[i + n] === ch) n++;
      if (ch === '~' && n > 2) { buf += src.slice(i, i + n); bufR += src.slice(i, i + n); i += n; continue; }
      const prev = i === 0 ? '\n' : src[i - 1];
      const next = i + n >= N ? '\n' : src[i + n];
      const prevWs = isUniSpace(prev), nextWs = isUniSpace(next);
      const prevP = isUniPunct(prev), nextP = isUniPunct(next);
      const leftFlank = !nextWs && (!nextP || prevWs || prevP);
      const rightFlank = !prevWs && (!prevP || nextWs || nextP);
      let canOpen, canClose;
      if (ch === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || prevP);
        canClose = rightFlank && (!leftFlank || nextP);
      } else { canOpen = leftFlank; canClose = rightFlank; }
      flush();
      const node = { t: 'delim', ch, len: n, s: ch.repeat(n), canOpen, canClose, pos: i };
      nodes.push(node);
      if (canOpen || canClose) delims.push(node);
      i += n; continue;
    }

    // Extended autolinks in plain text (never inside a bracket's label).
    // The reference renderer's text scanner halts before a scheme URL
    // anywhere, before an email run anywhere, before a mailto:/xmpp:
    // scheme only after a non-alphanumeric, and before www. only after
    // whitespace or one of *_~( (or at the very start).
    if (brackets.length === 0 && !docInLink) {
      const rest = src.slice(i);
      const prevCh = i === 0 ? '' : src[i - 1];
      const isScheme = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//.test(rest);
      const isWww = !isScheme && rest.startsWith('www.')
        && (i === 0 || isUniSpace(prevCh) || '*_~('.includes(prevCh));
      const wm = (isScheme || isWww) ? WWW_RE.exec(rest) : null;
      if (wm) {
        const url = trimAutolink(wm[0]);
        if (url.length >= 4 && (url.startsWith('www.') ? url.slice(4).includes('.') : true)) {
          flush();
          const href = url.startsWith('www.') ? 'http://' + url : url;
          nodes.push({ t: 'link', href, title: null, children: [{ t: 'text', s: url }], barelink: true });
          i += url.length; continue;
        }
      } else if (/[A-Za-z0-9]/.test(ch)) {
        // mailto:/xmpp: scheme autolinks, then bare emails. Candidates
        // are matched maximally: trailing dots are trimmed, but a
        // candidate that is malformed as a whole (say it ends in '-' or
        // '_') is no link at all, and is emitted as plain text so no
        // shorter address inside it can match either.
        const sm = /^(mailto|xmpp):/i.exec(rest);
        const smOk = sm && (i === 0 || !/[A-Za-z0-9]/.test(src[i - 1]));
        let linked = false;
        if (smOk) {
          const em = EMAIL_RUN_RE.exec(rest.slice(sm[0].length));
          if (em) {
            let addr = em[0];
            while (addr.endsWith('.')) addr = addr.slice(0, -1);
            if (BARE_EMAIL_FULL_RE.test(addr)) {
              let text = sm[0] + addr;
              if (sm[1].toLowerCase() === 'xmpp' && rest[sm[0].length + em[0].length] === '/') {
                const sg = /^\/[^/\s<>]+/.exec(rest.slice(sm[0].length + em[0].length));
                if (sg) text += sg[0];
              }
              flush();
              nodes.push({ t: 'link', href: text, title: null, children: [{ t: 'text', s: text }], barelink: true });
              i += text.length; linked = true;
            } else {
              buf += rest.slice(0, sm[0].length + em[0].length); bufR += rest.slice(0, sm[0].length + em[0].length);
              i += sm[0].length + em[0].length; linked = true;
            }
          }
        }
        if (!linked && !smOk) {
          const em = EMAIL_RUN_RE.exec(rest);
          if (em) {
            let addr = em[0];
            while (addr.endsWith('.')) addr = addr.slice(0, -1);
            if (!MARKED_EMAIL_FULL_RE.test(addr)) {
              // A trailing run of '_' may be the closing delimiter of
              // an open emphasis rather than part of the address: the
              // reference renderer matches the emphasis on the raw text
              // first, so the address it sees inside ends cleanly.
              const cut = addr.replace(/_+$/, '').replace(/\.+$/, '');
              if (cut !== addr && delims.some(d => d.ch === '_' && d.canOpen)
                && MARKED_EMAIL_FULL_RE.test(cut)) addr = cut;
            }
            if (MARKED_EMAIL_FULL_RE.test(addr)) {
              flush();
              nodes.push({ t: 'link', href: 'mailto:' + addr, title: null, children: [{ t: 'text', s: addr }], barelink: true });
              i += addr.length;
            } else if (MARKED_EMAIL_RE.exec(rest)) {
              // The renderer's own match, with its backtracking: an
              // address may match a proper prefix of the run.
              const mm = MARKED_EMAIL_RE.exec(rest);
              flush();
              nodes.push({ t: 'link', href: 'mailto:' + mm[0], title: null, children: [{ t: 'text', s: mm[0] }], barelink: true });
              i += mm[0].length;
            } else {
              buf += em[0]; bufR += em[0]; i += em[0].length;
            }
            linked = true;
          }
        }
        if (linked) continue;
      }
    }

    buf += ch; bufR += ch; i++;
  }
  flush();
  // Brackets that never saw their `]` leave ordinary text behind too.
  for (const b of brackets) {
    deadRanges.push({ open: b.node, end: nodes[nodes.length - 1] });
  }
  // Re-lex finally-dead ranges, outermost first. A range whose opener
  // was folded into a formed link or image is a live label — skip it.
  deadRanges.sort((a, b) => nodes.indexOf(a.open) - nodes.indexOf(b.open));
  for (const r of deadRanges) {
    const oi = nodes.indexOf(r.open);
    const ei = nodes.indexOf(r.end);
    if (oi < 0 || ei < oi) continue;
    rescanRange(nodes, oi + 1, r.end);
  }
  resolveEmphasis(nodes, 0, src, 0, defs);
  return nodes;
}

// The reference renderer's inline-link label grammar: a run of units —
// a nested bracket pair (whose content may itself hold bracket pairs,
// escapes and any other characters except an unescaped backslash-less
// bracket end), an escape, a code span (backtick runs around
// backtick-free content), a run of two or more backticks at the very
// end, or any single character except [ ] \ and `. A label that cannot
// be read this way forms no link.
function labelOkRe(label) {
  const n = label.length;
  // Index just past the bracket unit starting at label[i0] === '[',
  // or -1 when it does not close in the grammar's shape.
  function unit(i0, depth) {
    if (depth > 100) return -1;
    let j = i0 + 1;
    while (j < n) {
      const ch = label[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '[') { const k = unit(j, depth + 1); if (k < 0) return -1; j = k; continue; }
      if (ch === ']') return j + 1;
      j++;
    }
    return -1;
  }
  let i = 0;
  while (i < n) {
    const ch = label[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') { const k = unit(i, 0); if (k < 0) return false; i = k; continue; }
    if (ch === ']') return false;
    if (ch === '`') {
      let j = i;
      while (j < n && label[j] === '`') j++;
      let k = j;
      while (k < n && label[k] !== '`') k++;
      if (k < n) { // a closing run exists: consume through it
        while (k < n && label[k] === '`') k++;
        i = k; continue;
      }
      if (j - i >= 2 && j === n) { i = j; continue; }
      return false;
    }
    i++;
  }
  return true;
}

// The shortcut-reference label grammar: escapes and characters other
// than unescaped brackets, one to 999 of them.
function labelOkBe(label) {
  if (label.length < 1 || label.length > 999) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '[' || label[i] === ']') return false;
  }
  return true;
}

// Replace extended-autolink nodes in a formed link's label with the
// plain text they display (recursively, through emphasis wrappers).
function flattenAutolinks(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.t === 'link' && n.barelink) nodes[k] = { t: 'text', s: n.children[0].s };
    else if (n.children) flattenAutolinks(n.children);
  }
}

// Try to close the nearest bracket opener at a `]` (src index `i`). Returns
// the index just past what the link consumed, or -1 when the `]` is text.
function closeBracket(src, i, nodes, brackets, delims, defs, flush) {
  const open = brackets[brackets.length - 1];
  if (!open || !open.active) {
    if (open) brackets.pop();
    return -1;
  }
  const after = i + 1;
  let href = null, title = null, end = -1, isRef = false, refLabel = null, pathKind = 'inline';

  if (src[after] === '(') {
    const p = parseInlineDest(src, after);
    if (p) { href = p.href; title = p.title; end = p.end; }
  }
  if (end < 0) {
    // Full, collapsed or shortcut reference.
    if (src[after] === '[') {
      const lab = scanLabel(src, after);
      if (lab) {
        refLabel = lab.text === '' ? src.slice(open.contentStart, i) : lab.text;
        isRef = true;
        end = lab.end;
        pathKind = 'full';
      }
    }
    if (!isRef) { refLabel = src.slice(open.contentStart, i); isRef = true; end = after; pathKind = 'shortcut'; }
    const def = defs.get(normalizeLabel(refLabel));
    if (!def) { brackets.pop(); return -1; }
    href = def.href; title = def.title;
  }

  // The reference renderer's label grammar decides whether a link can
  // form here at all, and a label that already produced a link inside
  // itself produces none outside (its renderer matches the emphasis of
  // nesting that way: the inner link wins, the outer brackets are text).
  const labelText = src.slice(open.contentStart, i);
  if (pathKind === 'shortcut' ? !labelOkBe(labelText) : !labelOkRe(labelText)) {
    // A bracketed region with a parenthesised destination is masked
    // out of the emphasis matching entirely, even when no link forms:
    // delimiter runs inside it stay literal.
    if (pathKind === 'inline') {
      for (let k = open.delimBottom; k < delims.length; k++) delims[k].inert = true;
      delims.length = open.delimBottom;
    }
    brackets.pop(); return -1;
  }
  if (!open.isImage && open.hasLink) { brackets.pop(); return -1; }

  // A link forms: resolve emphasis inside it, then fold the nodes.
  flush();
  const oi = nodes.indexOf(open.node);
  resolveEmphasis(nodes, oi + 1, labelText, open.contentStart, defs);
  const children = nodes.splice(oi + 1);
  flattenAutolinks(children);
  nodes.length = oi;
  const linkNode = { t: open.isImage ? 'image' : 'link', href, title, children };
  nodes.push(linkNode);
  delims.length = open.delimBottom; // emphasis may not cross the link edge
  brackets.pop();
  if (!open.isImage) {
    // No link may contain another link: earlier link openers go inactive,
    // and every still-open bracket is poisoned for its own link attempt.
    for (const b of brackets) { if (!b.isImage) b.active = false; b.hasLink = true; }
  }
  // The label's inline scan does not leak link state into what follows.
  docInLink = open.inLinkAtOpen;
  return end;
}

// Scan a reference label starting at the `[` at index `i`; returns
// {text, end} (end just past `]`) or null.
function scanLabel(src, i) {
  let j = i + 1, text = '';
  while (j < src.length && src[j] !== ']') {
    if (src[j] === '\\' && j + 1 < src.length) { text += src[j] + src[j + 1]; j += 2; continue; }
    if (src[j] === '[') return null;
    text += src[j]; j++;
  }
  if (j >= src.length || text.length > 999) return null;
  return { text, end: j + 1 };
}

// Parse `( destination "title" )` starting at the `(` at index `i`.
// Returns {href, title, end} or null.
function parseInlineDest(src, i) {
  let j = i + 1;
  const skipWs = () => { while (j < src.length && isSpace(src[j])) j++; };
  skipWs();
  let href = '';
  if (src[j] === '<') {
    let k = j + 1, ok = false;
    while (k < src.length) {
      const ch = src[k];
      if (ch === '\\' && k + 1 < src.length) { k += 2; continue; }
      if (ch === '>') { ok = true; break; }
      if (ch === '\n' || ch === '<') break;
      k++;
    }
    if (!ok) return null;
    href = decodeEscapes(src.slice(j + 1, k));
    j = k + 1;
  } else {
    let depth = 0, k = j, out = '';
    while (k < src.length) {
      const ch = src[k];
      if (ch === '\\' && k + 1 < src.length && isPunct(src[k + 1])) { out += src[k + 1]; k += 2; continue; }
      if (ch === '(') { depth++; out += ch; k++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--; out += ch; k++; continue;
      }
      if (isSpace(ch) || ch < ' ') break;
      out += ch; k++;
    }
    if (depth !== 0) return null;
    href = out;
    j = k;
  }
  const afterDest = j;
  skipWs();
  let title = null;
  const q = src[j];
  if (q === '"' || q === "'" || q === '(') {
    const close = q === '(' ? ')' : q;
    let k = j + 1, ok = false;
    while (k < src.length) {
      const ch = src[k];
      if (ch === '\\' && k + 1 < src.length) { k += 2; continue; }
      if (q === '(' && ch === '(') break;
      if (ch === close) { ok = true; break; }
      k++;
    }
    if (!ok) return null;
    title = decodeEscapes(src.slice(j + 1, k));
    j = k + 1;
    skipWs();
  } else {
    j = afterDest;
    skipWs();
  }
  if (src[j] !== ')') return null;
  return { href, title, end: j + 1 };
}

// ---------------------------------------------------------------------------
// Emphasis resolution — the reference renderer's model
// ---------------------------------------------------------------------------
// The reference renderer does not run a CommonMark delimiter stack. It
// tokenizes inline content left to right: at each `*`, `_` or `~` run it
// tries to form ONE emphasis token immediately, scanning forward over a
// masked copy of the text with a balance counter — runs that can only
// open add to the balance, runs that can close subtract, and some
// closers are skipped by a rule of three. A formed token's content is
// lexed again on its own, so emphasis never pairs across a token
// boundary. The functions below mirror that behaviour on the node list
// the scanner produced.

const PUNCT_SYM_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function isWsCh(ch) { return ch !== undefined && /\s/.test(ch); }
// The renderer's GFM punctuation class: punctuation/symbols except '~'.
function isPunctGfm(ch) { return ch !== undefined && ch !== '~' && PUNCT_SYM_RE.test(ch); }
function isPunctNorm(ch) { return ch !== undefined && PUNCT_SYM_RE.test(ch); }
// The renderer's own punctuation test: whitespace, punctuation or
// symbol, but not a delimiter character itself.
function isNtPunct(ch) {
  return ch !== undefined && ch !== '' && ch !== '*' && ch !== '_'
    && (isWsCh(ch) || PUNCT_SYM_RE.test(ch));
}

// The code point ending at index `idx` of `s` ('' when idx <= 0).
function prevCp(s, idx) {
  if (idx <= 0) return '';
  const c = s.charCodeAt(idx - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && idx >= 2) {
    const c2 = s.charCodeAt(idx - 2);
    if (c2 >= 0xD800 && c2 <= 0xDBFF) return s.slice(idx - 2, idx);
  }
  return s[idx - 1];
}

// Mask a segment's source the way the reference renderer does before
// its emphasis scans. Reference-link regions whose label resolves are
// blanked; loose code spans keep their fences but their inner
// backticks become '+' and escaped punctuation becomes '++'; then
// link-shaped regions, strict code spans and HTML tags become
// bracketed runs of 'a'. Lengths are preserved throughout, so masked
// indices align with the source.
const MASK_REF_RE = /!?\[((?:\\[\s\S]|[^\[\]\\])*)\]\[((?:\\[\s\S]|[^\[\]\\])*)\]|!?\[((?:\\[\s\S]|[^\[\]\\])+)\](?:\[\])?/g;
const MASK_LOOSE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_SKIP_RE = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^()\\]|\((?:\\[\s\S]|[^\\()])*\))*\)|(?<!`)()(`+)[^`]+\3(?!`)|<(?! )[^<>]*?>/g;

function maskSource(text, defs) {
  let t = text;
  if (defs && defs.size && t.includes('[')) {
    t = t.replace(MASK_REF_RE, (m, g1, g2, g3) => {
      if (m.includes('`')) return m;
      const label = (g2 !== undefined && g2 !== '') ? g2 : (g1 !== undefined ? g1 : g3);
      if (label === undefined || !defs.has(normalizeLabel(label))) return m;
      return '[' + 'a'.repeat(Math.max(0, m.length - 2)) + ']';
    });
  }
  t = t.replace(MASK_LOOSE_CODE_RE, (m, g1, g2) => {
    if (g2 !== undefined) return '+'.repeat(m.length);
    if (g1 !== undefined) {
      return g1 + m.slice(g1.length, m.length - g1.length).replace(/`/g, '+') + g1;
    }
    return m;
  });
  t = t.replace(MASK_SKIP_RE, (m) => {
    if (m.length <= 2) return m;
    return '[' + 'a'.repeat(m.length - 2) + ']';
  });
  return t;
}

// The last index at which a run of each delimiter character could
// still close something: a run whose preceding character is not
// whitespace (the start of the text counts as whitespace). -1 when
// there is none.
function lastPossibleClosers(masked) {
  const last = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    const prev = i === 0 ? '\n' : masked[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      last[ch] = i;
    }
    i = j - 1;
  }
  return last;
}

// Classify a delimiter run in the masked source by the characters
// around it, following the renderer's closing-delimiter patterns:
// 'add' (can only open — raises the balance), 'sub' (a plain closer),
// 'r3' (a closer subject to the rule-of-three skip), or 'skip' (not
// counted at all). P is the masked character before the run, N the
// one after it (undefined at the end of the text).
function classifyRun(ch, P, N) {
  const punct = ch === '*' ? isPunctGfm : isPunctNorm;
  const pP = punct(P), pS = isWsCh(P);
  const pPS = pP || pS, pNPS = !pPS;
  const nP = punct(N), nS = isWsCh(N), nEnd = N === undefined;
  const nPS = nP || nS, nNPS = !nPS && !nEnd;
  if (pP && (nS || nEnd)) return 'sub';
  if (pNPS && (nPS || nEnd)) return 'sub';
  if (pPS && nNPS) return 'add';
  if (pS && nP) return 'add';
  if (pP && nP) return ch === '~' ? 'sub' : 'r3';
  if (pNPS && nNPS) return ch === '*' ? 'r3' : (ch === '~' ? 'sub' : 'skip');
  return 'skip';
}

// The closing-delimiter patterns for `*` and `_` open with an
// alternative that skips a whole span: text, a strong run of the
// other delimiter, text, a lone run of this delimiter, ending just
// before another strong run of the other delimiter. Only the first
// three delimiter runs of the tail can take part (the gaps between
// them hold no `*` or `_`). Returns the index scanning resumes at,
// or -1 when the span does not match.
function skipSpan(masked, start, ch) {
  const other = ch === '*' ? '_' : '*';
  const runs = [];
  let i = start;
  while (runs.length < 3) {
    let j = i;
    while (j < masked.length && masked[j] !== '*' && masked[j] !== '_') j++;
    if (j >= masked.length) return -1;
    let k = j + 1;
    while (k < masked.length && masked[k] === masked[j]) k++;
    runs.push({ ch: masked[j], start: j, len: k - j });
    i = k;
  }
  const [r1, r2, r3] = runs;
  if (r1.ch === other && r1.len === 2 && r2.ch === ch && r2.len === 1
    && r3.ch === other && r3.len >= 2) {
    return r3.start;
  }
  return -1;
}

// Try to form one emphasis token at the delimiter `opener` the way
// the reference renderer would, scanning the masked source forward
// with a balance counter. `prevArg` is the preceding text character
// as the renderer's lexer tracks it (before this call's own
// adjustments). Returns { closerPos, used, use } — the closer run's
// position in segment coordinates, how many of its characters the
// token consumes, and how many delimiter characters form the wrapper
// (1 = em, 2 = strong; for '~', the run length) — or null when no
// token forms.
function scanEmphasis(segText, segBase, masked, lastCloser, opener, prevArg) {
  const ch = opener.ch;
  const k = opener.len;
  const rel = opener.pos - segBase;
  const tailStart = rel + k;
  const nc = segText[tailStart];
  // The opening-delimiter pattern: the run must be followed by a
  // punctuation character or by a non-space character.
  if (nc === undefined || isWsCh(nc) || nc === ch) return null;
  const nextPunct = isPunctGfm(nc) ? nc : '';
  // The renderer counts back over identical delimiters in the masked
  // source: what precedes the whole masked run takes over as the
  // effective preceding character when there is one.
  const onlySame = prevArg === ch;
  let l = rel;
  while (l > 0 && masked[l - 1] === ch) l--;
  const p = prevCp(masked, l);
  const h = p === '*' || p === '_' || isNtPunct(p);
  const prevEff = l < rel ? p : prevArg;
  const prevPunct = l < rel ? h : isNtPunct(prevArg);
  // An opener followed by punctuation needs the preceding character
  // to be empty or punctuation-like itself.
  if (nextPunct && prevEff !== '' && !prevPunct) return null;
  // An underscore opener followed by a word character cannot open
  // right after a word character.
  if (ch === '_' && !nextPunct && ALNUM_RE.test(prevEff)) return null;
  const v = lastCloser[ch];
  if (v < tailStart) return null;
  const ee = v - tailStart;
  const y = (rel - l) + k;
  const R = p.trim() !== '' && (!!nextPunct || (ch === '*' && !h));
  let scanStart = tailStart;
  if (ch !== '~') {
    const span = skipSpan(masked, tailStart, ch);
    if (span > 0) scanStart = span;
  }
  let m = k, f = 0;
  const n = masked.length;
  let i = scanStart;
  while (i < n) {
    if (masked[i] !== ch) { i++; continue; }
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    const rs = i, runLen = j - i;
    i = j;
    if ((rs - 1) - tailStart > ee) break;
    const cat = classifyRun(ch, prevCp(masked, rs), masked[j]);
    if (cat === 'skip') continue;
    if (ch === '~') {
      // Strikethrough closers must match the opener's run length.
      if (runLen !== k) continue;
      if (cat === 'add') { m += runLen; continue; }
      m -= runLen;
      if (m > 0) continue;
      return { closerPos: rs, used: Math.min(runLen, runLen + m), use: k };
    }
    if (cat === 'add') { m += runLen; continue; }
    if (cat === 'r3' || R) {
      if (cat === 'r3' && onlySame) return null;
      if (y % 3 !== 0 && (y + runLen) % 3 === 0) { f += runLen; continue; }
    }
    m -= runLen;
    if (m > 0) continue;
    const used = Math.min(runLen, runLen + m + f);
    return { closerPos: rs, used, use: Math.min(k, used) % 2 === 1 ? 1 : 2 };
  }
  return null;
}

// Resolve the emphasis of one segment (a whole inline string, a link
// label, or the content of a formed emphasis token) over the node
// list `nodes` starting at index `fromIdx`. `segText` is the
// segment's raw source; delimiter positions are offset by `segBase`.
function resolveEmphasis(nodes, fromIdx, segText, segBase, defs) {
  const masked = maskSource(segText, defs);
  simSegment(nodes, fromIdx, segText, segBase, masked, lastPossibleClosers(masked), defs);
}

function simSegment(nodes, fromIdx, segText, segBase, masked, lastCloser, defs) {
  let lastTxt = '';
  let w = fromIdx;
  while (w < nodes.length) {
    const node = nodes[w];
    if (node.t === 'text') {
      if (node.ltc !== undefined) { if (node.ltc !== null) lastTxt = node.ltc; }
      else if (node.s) lastTxt = node.s[node.s.length - 1];
      w++; continue;
    }
    if (node.t === 'softbreak') { lastTxt = '\n'; w++; continue; }
    // Every other token kind clears the tracked preceding character:
    // in the reference lexer only text tokens set it.
    if (node.t !== 'delim') { lastTxt = ''; w++; continue; }
    if (node.inert) { lastTxt = node.ch; w++; continue; }
    const ch = node.ch;
    // The renderer retries a failed run at its suffixes: each
    // failure consumes one delimiter as text (a consumed '_' does
    // not become the tracked preceding character; '*' and '~' do).
    let res = null, effLen = 0;
    for (let k2 = node.len; k2 >= 1; k2--) {
      const cand = { ch, len: k2, pos: node.pos + (node.len - k2) };
      const prevArg = (k2 === node.len || ch === '_') ? lastTxt : ch;
      res = scanEmphasis(segText, segBase, masked, lastCloser, cand, prevArg);
      if (res) { effLen = k2; break; }
    }
    if (!res) { if (ch !== '_') lastTxt = ch; w++; continue; }
    // Find the closer's node in this segment.
    let ci = -1;
    for (let x = w + 1; x < nodes.length; x++) {
      const cn = nodes[x];
      if (cn.t === 'delim' && cn.ch === ch && cn.pos - segBase === res.closerPos) { ci = x; break; }
    }
    if (ci < 0) { w++; continue; }
    const closer = nodes[ci];
    const use = res.use;
    const consumed = node.len - effLen;
    let openerIdx = w;
    if (consumed > 0) {
      // The consumed prefix stays behind as a literal run; the
      // token's opener is what remains of the run.
      const effNode = { t: 'delim', ch, len: effLen, s: ch.repeat(effLen), pos: node.pos + consumed };
      node.len = consumed;
      node.s = ch.repeat(consumed);
      nodes.splice(w + 1, 0, effNode);
      openerIdx = w + 1;
      ci++;
    }
    const openerNode = nodes[openerIdx];
    const inner = nodes.splice(openerIdx + 1, ci - openerIdx - 1);
    // The closer now sits at openerIdx + 1. Surplus opener characters
    // and the consumed-but-unused closer characters become the
    // content's first and last delimiter runs, as in the reference
    // renderer, whose token text keeps them inside.
    const children = [];
    if (effLen > use) {
      children.push({ t: 'delim', ch, len: effLen - use, s: ch.repeat(effLen - use), pos: openerNode.pos + use });
    }
    children.push(...inner);
    if (res.used > use) {
      children.push({ t: 'delim', ch, len: res.used - use, s: ch.repeat(res.used - use), pos: closer.pos });
    }
    const wrap = { t: ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em'), children };
    nodes[openerIdx] = wrap;
    const leftover = closer.len - res.used;
    if (leftover > 0) {
      closer.len = leftover;
      closer.s = ch.repeat(leftover);
      closer.pos += res.used;
    } else {
      nodes.splice(openerIdx + 1, 1);
    }
    // The token's content is a fresh segment of its own.
    const cStart = (openerNode.pos - segBase) + use;
    const cEnd = res.closerPos + res.used - use;
    const cText = segText.slice(cStart, cEnd);
    const cMasked = maskSource(cText, defs);
    simSegment(children, 0, cText, segBase + cStart, cMasked, lastPossibleClosers(cMasked), defs);
    w = openerIdx + 1;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderInlineNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += escapeText(decodeNumericRefs(n.s)).replace(/\uE001/g, '&amp;'); break;
      case 'delim': out += n.s; break;
      case 'code': out += '<code>' + escapeCode(n.s) + '</code>'; break;
      case 'html': out += n.s; break;
      case 'softbreak': out += '\n'; break;
      case 'hardbreak': out += '<br>'; break;
      case 'em': out += '<em>' + renderInlineNodes(n.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlineNodes(n.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlineNodes(n.children) + '</del>'; break;
      case 'link': {
        out += '<a href="' + escapeText(cleanUrl(n.href)) + '"';
        if (n.title !== null && n.title !== undefined) out += ' title="' + escapeText(n.title) + '"';
        out += '>' + renderInlineNodes(n.children) + '</a>';
        break;
      }
      case 'image': {
        out += '<img src="' + escapeText(cleanUrl(n.href)) + '" alt="' + escapeText(plainText(n.children)) + '"';
        if (n.title !== null && n.title !== undefined) out += ' title="' + escapeText(n.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

// The plain-text content of inline nodes (used for image alt text).
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': case 'delim': case 'code': out += n.s.replace(/\uE001/g, '&'); break;
      case 'html': break;
      case 'softbreak': case 'hardbreak': out += '\n'; break;
      case 'em': case 'strong': case 'del': case 'link': case 'image':
        out += plainText(n.children); break;
    }
  }
  return out;
}

function renderInline(text, defs, trim) {
  const s = trim ? text.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '') : text;
  if (!s) return '';
  return renderInlineNodes(parseInlineNodes(s, defs));
}

function renderBlocks(node, defs) {
  let out = '';
  for (const child of node.children) out += renderBlock(child, defs);
  return out;
}

function renderBlock(n, defs) {
  switch (n.t) {
    case 'heading':
      return '<h' + n.level + '>' + renderInline(n.text, defs, true) + '</h' + n.level + '>\n';
    case 'para': {
      let text = n.text;
      if (n.trailWs !== undefined && n.parent
        && n.parent.children[n.parent.children.length - 1] === n) {
        text += '\n' + n.trailWs;
      }
      return '<p>' + renderInline(text, defs) + '</p>\n';
    }
    case 'hr':
      return '<hr>\n';
    case 'code': {
      const lang = n.fenced && n.info ? decodeEscapes(n.info.split(/\s+/)[0]) : '';
      const cls = lang ? ' class="language-' + escapeText(lang) + '"' : '';
      return '<pre><code' + cls + '>' + escapeCode(n.text) + '</code></pre>\n';
    }
    case 'html':
      return n.text + (n.nl ? '\n' : '');
    case 'quote':
      return '<blockquote>\n' + renderBlocks(n, defs) + '</blockquote>\n';
    case 'list': {
      let open;
      if (n.ordered) open = n.start !== 1 ? '<ol start="' + n.start + '">\n' : '<ol>\n';
      else open = '<ul>\n';
      let out = open;
      for (const item of n.children) out += renderItem(item, n, defs);
      return out + (n.ordered ? '</ol>\n' : '</ul>\n');
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      n.header.forEach((cell, k) => {
        const a = n.aligns[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell, defs) + '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (n.rows.length) {
        out += '<tbody>';
        for (const row of n.rows) {
          out += '<tr>\n';
          row.forEach((cell, k) => {
            const a = n.aligns[k];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell, defs) + '</td>\n';
          });
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

const TASK_RE = /^\[([ xX])\][ \t]+/;

function renderItem(item, list, defs) {
  // A task list item carries a checkbox in place of its `[ ]` / `[x]`.
  let checkbox = '';
  const first = item.children[0];
  if (first && first.t === 'para') {
    const m = TASK_RE.exec(first.text.replace(/^[ \t]+/, ''));
    if (m) {
      checkbox = m[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      first.text = first.text.replace(/^[ \t]+/, '').slice(m[0].length);
      first.taskStripped = true;
    }
  }
  if (list.tight) {
    let out = '<li>' + checkbox;
    for (const child of item.children) {
      out += child.t === 'para' ? renderInline(child.text, defs) : renderBlock(child, defs);
    }
    return out + '</li>\n';
  }
  let inner = '';
  for (const child of item.children) inner += renderBlock(child, defs);
  if (checkbox && first && first.t === 'para') {
    inner = inner.replace('<p>', '<p>' + checkbox);
  } else if (checkbox) {
    inner = checkbox + inner;
  }
  return '<li>' + inner + '</li>\n';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  docInLink = false;
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const defs = new Map();
  const root = lexBlocks(src, defs);
  return renderBlocks(root, defs);
}

// Document-wide link state for inline lexing: an `<a ` start tag turns
// bare-autolink suppression on until a `</a>` appears, across blocks —
// the reference renderer carries this state through the whole document.
let docInLink = false;
