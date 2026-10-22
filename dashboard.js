/* ═══════════════════════════════════════════════
   claude-peers dashboard — JavaScript
   Plain script, no build step: the broker serves this file as-is.
   One store, per-view renders that skip when their inputs are unchanged, a keyed
   timeline (only new or changed messages are rebuilt), and delegated events
   (no listeners on rendered nodes, so re-rendering cannot leak them).
   DOM is built with createElement/textContent only — never innerHTML.
   ═══════════════════════════════════════════════ */
(function () {
  'use strict';

  const root = document.getElementById('cp-root');
  if (!root) { staleMarkupNotice(); return; }

  /* ═══ Constants ═══ */
  const MAX_MESSAGE = 65536;          // broker MAX_MESSAGE_SIZE
  const WARN_MESSAGE = 50000;
  const MESSAGE_CAP = 500;            // broker sends the newest 500 messages of the session
  const MERGE_GAP_MS = 5 * 60 * 1000; // consecutive messages share one header within this gap
  const DIVIDER_GAP_MS = 15 * 60 * 1000;
  const POLL_MS = 5000;
  const WS_SILENCE_MS = 45000;        // the broker pushes state at least every 15 s; this much silence means a dead socket
  const SEND_TIMEOUT_MS = 30000;
  const SETTLE_MS = 3000;             // a succeeded action stays busy until the next snapshot shows it, at most this long
  const ANNOUNCE_MS = 1500;           // new messages are announced to screen readers at most this often
  const PANEL_MIN = 260, PANEL_MAX = 480, PANEL_DEFAULT = 320;
  const HUES = [80, 110, 145, 175, 200, 230, 260, 290, 320]; // OKLCH hues; skips the red/orange band (danger + accent)

  const SECTIONS = {
    peers: { title: 'Peers' },
    groups: { title: 'Groups' },
    tasks: { title: 'Tasks' },
    files: { title: 'Active files' },
    activity: { title: 'Activity' },
    decisions: { title: 'Decisions' },
    verifications: { title: 'Verifications' },
    proposals: { title: 'Proposals' },
    approvals: { title: 'Approvals' },
  };
  const STATUS_LABEL = { online: 'Online', away: 'Away', busy: 'Busy', idle: 'Idle' };
  const KINDS = {
    question: { label: 'Question', icon: 'question' },
    decision: { label: 'Decision', icon: 'decisions' },
    context_share: { label: 'Context', icon: 'share' },
    review_request: { label: 'Review request', icon: 'eye' },
    handoff: { label: 'Handoff', icon: 'handoff' },
  };
  // Field order and labels for structured messages (their metadata mirrors the send_structured arguments).
  const KIND_FIELDS = {
    question: [['question', 'Question'], ['expected_format', 'Expected format'], ['context', 'Context']],
    decision: [['decision', 'Decision'], ['rationale', 'Rationale'], ['alternatives_rejected', 'Rejected']],
    context_share: [['summary', 'Summary'], ['current_task', 'Task'], ['files_changed', 'Files'], ['constraints', 'Constraints']],
    review_request: [['file_path', 'File'], ['description', 'Request'], ['acceptance_criteria', 'Criteria']],
    handoff: [['work_completed', 'Completed'], ['remaining_work', 'Remaining'], ['files_modified', 'Files'], ['decisions_made', 'Decisions'], ['blockers', 'Blockers']],
  };
  const PATH_FIELDS = new Set(['file_path', 'files_changed', 'files_modified', 'decisions_made']);

  /* ═══ DOM helpers ═══ */
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, props) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'style') { for (const s of Object.keys(v)) el.style.setProperty(s, String(v[s])); }
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { for (const x of c) add(el, x); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function fill(el, children) { el.replaceChildren(); add(el, children); }
  // Live regions announce DOM changes, so rewriting the same text could repeat an announcement: write only changes.
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }
  function attrSel(name, value) { return '[' + name + '="' + String(value).replace(/["\\]/g, '\\$&') + '"]'; }

  /* ═══ Formatting ═══ */
  const fmtHM = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const fmtHMS = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDayName = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const ms = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };
  const time = (iso) => (ms(iso) ? fmtHM.format(ms(iso)) : '—');
  const full = (iso) => (ms(iso) ? fmtFull.format(ms(iso)) : '');
  function dayLabel(t) {
    const d = new Date(t), today = new Date();
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const b = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (a === b) return 'Today';
    if (b - a === 86400000) return 'Yesterday';
    return fmtDayName.format(d);
  }
  function ago(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function uptime(msTotal) {
    const s = Math.max(0, Math.floor(msTotal / 1000));
    const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + hr + 'h';
    return hr > 0 ? hr + 'h ' + m + 'm' : m + 'm ' + (s % 60) + 's';
  }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  function initials(name) {
    const s = String(name || '?');
    const parts = s.split(/[-_\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }
  function hueOf(name) {
    let x = 2166136261;
    const s = String(name);
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return HUES[(x >>> 0) % HUES.length];
  }
  function excerpt(text, max) {
    // Only the start of the text can reach the excerpt; cutting it first also bounds the regexes below, which are
    // quadratic on long runs of brackets or spaces.
    const lines = String(text || '').slice(0, max * 6).split('\n')
      .filter((l) => !/^\s*```/.test(l) && !/^\s*\|?\s*:?-{3,}/.test(l))
      .map((l) => l.trim().replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '').replace(/^\|/, '').replace(/\|$/, ''));
    // Strip markdown markers but keep identifiers such as respond_approval intact.
    const s = lines.join(' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|~~|`/g, '')
      .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
      .replace(/\s*\|\s*/g, ' · ')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  }
  function splitPath(p) {
    const s = String(p);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i < 0 ? { dir: '', base: s } : { dir: s.slice(0, i + 1), base: s.slice(i + 1) };
  }
  function groupLabel(name) { return String(name).replace(/^branch\//, ''); }

  /* ═══ Storage (per-viewer conveniences only; every access may throw) ═══ */
  function load(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, String(value)); } catch (e) { /* private mode */ } }

  /* ═══ Markdown (safe DOM only) ═══ */
  const FENCE = /^\s*```/;
  const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
  const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const HRULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  // code | **strong** | __strong__ | ~~del~~ | *em* | _em_ | [label](http…) | bare http(s) URL
  // Underscore emphasis must not start or end inside a word (snake_case stays text). The boundary character before it is
  // captured instead of using a lookbehind, which older Safari cannot parse. A code span's opening run must be the whole
  // run of backticks ((?!`)): letting it shrink made long backtick runs take cubic time. Link labels are capped for the
  // same reason.
  const INLINE = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|(^|[^\w])__([^_\s][^_]*?)__(?!\w)|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(^|[^\w])_([^_\s][^_]*?)_(?!\w)|\[([^[\]]{1,500})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;

  const MAX_DEPTH = 8;         // nested quotes/lists deeper than this render as text (no unbounded recursion)
  const MAX_INLINE = 2000;     // longer lines skip inline parsing and the whitespace-heavy line patterns, which are
                               // quadratic on long runs of spaces; a worst-case line of this length takes ~10 ms
  function markdown(text, depth) {
    const level = depth || 0;
    const out = h('div', { class: 'md' });
    // U+2028/U+2029 are line breaks too; left inside a line they would stop the list parser from advancing.
    const lines = String(text || '').replace(/\r\n?|\u2028|\u2029/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([\w#+.-]*)/);
      if (fence) {
        const buf = [];
        i++;
        while (i < lines.length && !FENCE.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.appendChild(codeBlock(buf.join('\n'), fence[1]));
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const head = line.match(/^(#{1,6})\s+(.*)$/);
      if (head) {
        // Styled, not <h*>: headings inside chat messages are not page structure for screen-reader navigation.
        const el = h('p', { class: 'md-h md-h' + head[1].length });
        inline(el, head[2].length > MAX_INLINE ? head[2] : head[2].replace(/\s+#+\s*$/, ''));
        out.appendChild(el);
        i++;
        continue;
      }
      if (HRULE.test(line)) { out.appendChild(h('hr')); i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && tableSep(lines[i + 1])) {
        const header = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : null));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i++; }
        out.appendChild(table(header, aligns, rows));
        continue;
      }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.appendChild(h('blockquote', null, level < MAX_DEPTH ? markdown(buf.join('\n'), level + 1) : h('p', { text: buf.join('\n') })));
        continue;
      }
      if (LIST_ITEM.test(line)) {
        const parsed = list(lines, i, 0);
        if (parsed.next > i) { out.appendChild(parsed.el); i = parsed.next; continue; }
      }
      const p = h('p');
      let first = true;
      while (i < lines.length && lines[i].trim() && (first || !blockStart(lines, i))) {
        if (!first) p.appendChild(h('br'));
        inline(p, lines[i].trim());
        first = false;
        i++;
      }
      out.appendChild(p);
    }
    return out;
  }
  function blockStart(lines, i) {
    const l = lines[i];
    return FENCE.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_ITEM.test(l) || HRULE.test(l)
      || (l.includes('|') && i + 1 < lines.length && tableSep(lines[i + 1]));
  }
  // A table separator is short; TABLE_SEP's adjacent \s* make it quadratic on long runs of spaces.
  const tableSep = (l) => l.length <= MAX_INLINE && TABLE_SEP.test(l);
  const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  function list(lines, start, depth) {
    const base = indentOf(lines[start]);
    const ordered = /^\s*\d/.test(lines[start]);
    const el = h(ordered ? 'ol' : 'ul');
    if (ordered) { const n = parseInt(lines[start].trim(), 10); if (n > 1) el.setAttribute('start', String(n)); }
    let i = start, item = null;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && LIST_ITEM.test(lines[j]) && indentOf(lines[j]) >= base) { i = j; continue; }
        break;
      }
      const ind = indentOf(line);
      const m = line.match(/^\s*([-*+]|\d+[.)])\s+([\s\S]*)$/);
      if (m && ind === base) {
        if (/\d/.test(m[1]) !== ordered) break;
        item = h('li');
        let content = m[2];
        const task = content.match(/^\[([ xX])\]\s+([\s\S]*)$/);
        if (task) {
          const done = task[1] !== ' ';
          item.className = 'task' + (done ? ' done' : '');
          item.appendChild(icon(done ? 'square-check' : 'square'));
          content = task[2];
        }
        inline(item, content);
        el.appendChild(item);
        i++;
      } else if (m && ind > base && item && depth < MAX_DEPTH) {
        const sub = list(lines, i, depth + 1);
        if (sub.next <= i) break;
        item.appendChild(sub.el);
        i = sub.next;
      } else if (ind > base && item) {
        item.appendChild(h('br'));
        inline(item, line.trim());
        i++;
      } else break;
    }
    return { el, next: i };
  }
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (c === '|') { cells.push(cur.trim()); cur = ''; } else cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }
  function table(header, aligns, rows) {
    const cell = (tag, text, k) => { const c = h(tag, aligns[k] ? { style: { 'text-align': aligns[k] } } : null); inline(c, text || ''); return c; };
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, header.map((c, k) => cell('th', c, k)))),
      h('tbody', null, rows.map((r) => h('tr', null, header.map((_, k) => cell('td', r[k], k)))))));
  }
  function codeBlock(code, lang) {
    return h('div', { class: 'code' },
      h('div', { class: 'code-head' },
        h('span', { text: lang || 'code' }),
        h('button', { type: 'button', class: 'icon-btn', 'data-action': 'copy-code', 'aria-label': 'Copy code', 'data-tip': 'Copy code' }, icon('copy'))),
      h('pre', null, h('code', { text: code })));
  }
  function inline(parent, text) {
    if (text.length > MAX_INLINE) { parent.appendChild(document.createTextNode(text)); return; }
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      const boundary = m[4] !== undefined ? m[4] : m[8] !== undefined ? m[8] : '';
      const at = m.index + boundary.length; // the captured boundary character stays plain text
      if (at > last) parent.appendChild(document.createTextNode(text.slice(last, at)));
      if (m[1] !== undefined) parent.appendChild(h('code', { text: m[2] }));
      else if (m[3] !== undefined || m[5] !== undefined) { const s = h('strong'); inline(s, m[3] !== undefined ? m[3] : m[5]); parent.appendChild(s); }
      else if (m[6] !== undefined) { const s = h('del'); inline(s, m[6]); parent.appendChild(s); }
      else if (m[7] !== undefined || m[9] !== undefined) { const s = h('em'); inline(s, m[7] !== undefined ? m[7] : m[9]); parent.appendChild(s); }
      else if (m[10] !== undefined) parent.appendChild(link(m[11], m[10]));
      else parent.appendChild(link(m[12], m[12]));
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  // A labelled link also shows where it really goes, so a label cannot pass for a different site.
  function link(href, label) {
    const a = h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, label);
    let host = '';
    try { host = new URL(href).host; } catch (e) { /* matched as http(s), so normally parseable */ }
    if (label === href || !host || label.toLowerCase().includes(host)) return a;
    const frag = document.createDocumentFragment();
    frag.appendChild(a);
    frag.appendChild(h('span', { class: 'link-host', text: ' (' + host + ')' }));
    return frag;
  }
  function highlight(container, query) {
    if (!query) return;
    // Match on the original text so offsets stay right even where lower-casing changes a string's length.
    const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const has = new RegExp(pattern, 'i');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (has.test(n.nodeValue)) hits.push(n);
    for (const node of hits) {
      const text = node.nodeValue, frag = document.createDocumentFragment();
      let pos = 0;
      for (const m of text.matchAll(new RegExp(pattern, 'gi'))) {
        if (m.index > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.index)));
        frag.appendChild(h('mark', { text: m[0] }));
        pos = m.index + m[0].length;
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  /* ═══ Translation to Arabic (unchanged behaviour: prose only, code kept, chunked, cached) ═══ */
  const trCache = Object.create(null);
  const trCacheKeys = [];
  const TR_CACHE_MAX = 500;
  const TR_MAX_FAILS = 5;
  const trActive = new Set();   // message ids currently shown translated
  const trLoading = new Set();
  let trFails = 0, trDead = false;

  function trCacheSet(key, val) {
    if (trCache[key] === undefined) {
      while (trCacheKeys.length >= TR_CACHE_MAX) delete trCache[trCacheKeys.shift()];
      trCacheKeys.push(key);
    }
    trCache[key] = val;
  }
  function trMarkDead() { trDead = true; setTimeout(() => { trDead = false; trFails = 0; }, 60000); }
  function trSegments(text) {
    const segments = [], lines = text.split('\n');
    let prose = [], i = 0;
    const flush = () => { if (prose.length) { segments.push({ type: 'prose', content: prose.join('\n') }); prose = []; } };
    while (i < lines.length) {
      if (FENCE.test(lines[i])) {
        flush();
        const block = [lines[i++]];
        while (i < lines.length && !FENCE.test(lines[i])) block.push(lines[i++]);
        if (i < lines.length) block.push(lines[i++]);
        segments.push({ type: 'code', content: block.join('\n') });
        continue;
      }
      prose.push(lines[i++]);
    }
    flush();
    return segments;
  }
  function trSplitInlineCode(text) {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(/`([^`]+)`/g)) {
      if (m.index > last) parts.push({ type: 'prose', content: text.slice(last, m.index) });
      parts.push({ type: 'code', content: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: 'prose', content: text.slice(last) });
    return parts;
  }
  function trChunks(text) {
    const MAX = 380;
    if (text.length <= MAX) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > 0) {
      if (rest.length <= MAX) { chunks.push(rest); break; }
      let cut = -1;
      for (const end of ['. ', '! ', '? ', '.\n', '!\n', '?\n', ', ']) {
        const at = rest.lastIndexOf(end, MAX);
        if (at > 40 && at > cut) cut = at + end.length;
      }
      if (cut < 40) { cut = rest.lastIndexOf(' ', MAX); if (cut > 0) cut++; }
      if (cut < 40) cut = MAX;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return chunks;
  }
  async function trCall(text) {
    const trimmed = text.trim();
    if (!trimmed) return text;
    if (trCache[trimmed]) return trCache[trimmed];
    if (trDead || trFails >= TR_MAX_FAILS) return text;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=' + encodeURIComponent(trimmed);
        const r = await fetch(url, { signal: timeoutSignal(12000) });
        if (!r.ok) { trFails++; continue; }
        const d = await r.json();
        if (!Array.isArray(d) || !Array.isArray(d[0])) { trFails++; return text; }
        let out = '';
        for (const seg of d[0]) if (seg && seg[0]) out += seg[0];
        if (!out.trim()) { trFails++; return text; }
        if (/MYMEMORY|WARNING|LIMIT|AVAILABLE FREE/i.test(out)) { trMarkDead(); return text; }
        if (out.trim().toUpperCase() === trimmed.toUpperCase()) return text;
        trCacheSet(trimmed, out);
        trFails = 0;
        return out;
      } catch (e) {
        trFails++;
        if (attempt === 0) await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
    return text;
  }
  async function trProse(text) {
    if (!text || !text.trim()) return text;
    if (trCache[text]) return trCache[text];
    if (!/[a-zA-Z]/.test(text)) return text;
    const chunks = trChunks(text), results = [];
    let failed = false;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (!c.trim()) { results.push(c); continue; }
      if (trFails >= TR_MAX_FAILS) { failed = true; results.push(c); continue; }
      const t = await trCall(c);
      if (t === c && /[a-zA-Z]/.test(c)) failed = true;
      results.push(t);
      if (i < chunks.length - 1) await new Promise((ok) => setTimeout(ok, 350));
    }
    if (failed) return text;
    const joined = results.join('');
    trCacheSet(text, joined);
    return joined;
  }
  async function translateText(raw) {
    if (trCache[raw]) return trCache[raw];
    const out = [];
    for (const seg of trSegments(raw)) {
      if (seg.type !== 'prose') { out.push(seg.content); continue; }
      const parts = [];
      for (const part of trSplitInlineCode(seg.content)) parts.push(part.type === 'code' ? part.content : await trProse(part.content));
      out.push(parts.join(''));
    }
    const result = out.join('\n');
    trCacheSet(raw, result);
    return result;
  }

  /* ═══ State ═══ */
  const mqContextDrawer = window.matchMedia('(max-width: 1359px)');
  const mqPanelOverlay = window.matchMedia('(max-width: 1099px)');
  const mqMobile = window.matchMedia('(max-width: 719px)');

  const savedSection = load('cp.section', 'peers');
  const state = {
    data: null,
    D: null,               // derived lookups for the current snapshot
    dataAt: 0,
    loadError: null,
    conn: 'connecting',    // connecting | live | reconnecting | offline
    downSince: 0,
    lastPollOk: null,
    pending: new Set(),    // in-flight actions, keyed e.g. "task:<id>"
    sending: false,
    sendError: '',
    sendStatus: null,      // { text, tone }
    ui: {
      section: SECTIONS[savedSection] ? savedSection : 'peers',
      panelDocked: load('sidebar-state', 'expanded') !== 'collapsed',
      panelOverlayOpen: false,
      panelWidth: clampWidth(Number(load('cp.panel-width', PANEL_DEFAULT))),
      navOpen: false,
      ctxOpen: false,
      selected: null,      // conversation scope: a target (see target())
      recipient: null,     // composer target
      search: '',
      taskFilter: 'open',
      decisionFilter: 'active',
      pinsOpen: false,
      confirmGroup: null,
      groupDraft: null,    // { peer, group } — a group chosen in the details column, not yet moved
    },
  };
  function clampWidth(w) { return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Number.isFinite(w) ? Math.round(w) : PANEL_DEFAULT)); }
  const panelOpen = () => (mqPanelOverlay.matches ? state.ui.panelOverlayOpen : state.ui.panelDocked);
  // A succeeded action keeps its key here until the broker's next snapshot shows its effect, so a second click
  // cannot send it again in between.
  const settling = new Map(); // key -> fallback timer
  const isPending = (key) => state.pending.has(key) || settling.has(key);
  const pendingKeys = () => [...state.pending, ...settling.keys()].join(',');
  function settle(key) {
    clearTimeout(settling.get(key));
    settling.set(key, setTimeout(() => { settling.delete(key); render(); }, SETTLE_MS));
  }
  // The selection and the recipient remember the peer's process as well as its id: a reconnecting session gets a new
  // id but keeps its pid and directory, while its default name (claude-N) can pass to an unrelated session.
  const procKey = (p) => p.pid + '|' + p.cwd;
  const knownProcs = new Map(); // peer id -> process, for every peer seen connected during this page's life
  const knownNames = new Map(); // name -> the processes seen using it during this page's life
  function target(p, prev) {
    return { id: p.id, name: p.name || p.id, pid: p.pid, cwd: p.cwd, ids: prev && prev.ids ? prev.ids.concat(p.id) : [p.id] };
  }
  // The broker expires typing after 5 s but only pushes on changes, so a snapshot's typing list goes stale.
  const TYPING_FRESH_MS = 6000;
  const typingNow = () => (state.D && Date.now() - state.dataAt < TYPING_FRESH_MS ? state.D.typing : new Set());

  function byName(a, b) { return String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { numeric: true, sensitivity: 'base' }); }

  function derive(d) {
    const peers = (d.peers || []).slice().sort(byName);
    const peerById = new Map(peers.map((p) => [p.id, p]));
    const nameCount = new Map();
    for (const p of peers) nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1);
    const groups = (d.groups || []).slice();
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const tasks = d.tasks || [];
    const files = [];
    const owners = new Map();
    for (const a of d.active_files || []) {
      for (const f of a.files || []) {
        const key = String(f).replace(/\\/g, '/').toLowerCase();
        if (!owners.has(key)) owners.set(key, { path: f, owners: [] });
        const entry = owners.get(key);
        // The same file reported twice by one peer (say with / and \) is not a conflict.
        if (entry.owners.some((o) => o.id === a.peer_id)) continue;
        entry.owners.push({ id: a.peer_id, name: a.peer_name });
        files.push({ path: f, key, peer_id: a.peer_id, peer_name: a.peer_name });
      }
    }
    const conflicts = [...owners.values()].filter((o) => o.owners.length > 1);
    const decisions = d.decisions || [];
    const verifications = d.verifications || [];
    const proposals = d.proposals || [];
    const approvals = d.approvals || [];
    const openProposals = proposals.filter((p) => p.status === 'open');
    return {
      peers, peerById, nameCount, groups, groupById,
      typing: new Set(d.typing || []),
      pinnedIds: new Set((d.pinned || []).map((m) => m.id)),
      tasks, openTasks: tasks.filter((t) => t.status !== 'completed'),
      files, owners, conflicts,
      decisions, activeDecisions: decisions.filter((x) => x.status === 'active'),
      verifications, pendingVerifications: verifications.filter((v) => v.status === 'pending'),
      proposals, openProposals,
      awaitingVote: openProposals.filter((p) => !(p.votes || []).some((v) => v.voter_id === 'dashboard')),
      approvals, pendingApprovals: approvals.filter((a) => a.status === 'pending'),
    };
  }

  // A participant as the dashboard should show it. Peer ids change on every reconnect, so a message keeps the names
  // its sender and recipient had (from_name/to_name); live peers win, the stored name is the fallback.
  function ref(id, storedName) {
    if (id === 'dashboard') return { id, name: 'You', kind: 'you', live: true };
    if (id === 'cli') return { id, name: 'CLI', kind: 'cli', live: true };
    const p = state.D && state.D.peerById.get(id);
    if (p) return { id, name: p.name || id, kind: 'peer', live: true, peer: p };
    return { id, name: storedName || id, kind: 'peer', live: false };
  }
  // Whether a message participant is the selected peer: one of the ids it had while the dashboard followed it, or an
  // earlier connection of the same process. For ids this page never saw connected, the name stored with the message
  // decides, but only while no other connected peer has that name: default names repeat across groups and pass to new
  // sessions.
  function isSelf(id, name, sel) { return (sel.ids || [sel.id]).includes(id) || earlierSelf(id, name, sel); }
  function involves(m, sel) { return isSelf(m.from_id, m.from_name, sel) || isSelf(m.to_id, m.to_name, sel); }
  function earlierSelf(id, name, sel) {
    const D = state.D;
    if (!D || D.peerById.has(id) || id === 'dashboard' || id === 'cli') return false;
    const proc = knownProcs.get(id);
    if (proc !== undefined) return !!sel.pid && proc === procKey(sel);
    if (!name || name !== sel.name) return false;
    const users = knownNames.get(name);
    if (users && [...users].some((k) => k !== procKey(sel))) return false; // another process has used this name
    const holders = D.nameCount.get(name) || 0;
    const live = D.peerById.get(sel.id);
    return holders === 0 || (holders === 1 && !!live && live.name === name);
  }

  /* ═══ Identity atoms ═══ */
  function tile(r, cls) {
    const c = 'tile' + (cls ? ' ' + cls : '');
    const small = cls && /\bsm\b/.test(cls);
    if (r.kind === 'you') return h('span', { class: c + ' you', 'aria-hidden': 'true' }, small ? 'Y' : 'YOU');
    if (r.kind === 'cli') return h('span', { class: c + ' cli', 'aria-hidden': 'true' }, icon('terminal'));
    return h('span', { class: c + ' hue', style: { '--h': hueOf(r.name) }, 'aria-hidden': 'true' }, initials(r.name));
  }
  function nameSpan(r, cls) {
    const c = 'name' + (cls ? ' ' + cls : '') + (r.kind === 'you' ? ' you' : r.kind === 'peer' ? ' hue' : '');
    return h('span', { class: c, style: r.kind === 'peer' ? { '--h': hueOf(r.name) } : null, text: r.name });
  }
  function who(r, opts) {
    const o = opts || {};
    const inner = [o.tile === false ? null : tile(r, 'sm'), nameSpan(r)];
    if (o.button !== false && r.kind === 'peer' && r.live) {
      return h('button', { type: 'button', class: 'who who-btn', 'data-action': 'select-peer', 'data-id': r.id, title: 'Show messages with ' + r.name }, inner);
    }
    return h('span', { class: 'who' }, inner);
  }
  function presence(status) { return h('span', { class: 'presence', 'data-status': status || 'online' }); }

  /* ═══ Network ═══ */
  function timeoutSignal(msTimeout) {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(msTimeout) : undefined;
  }
  async function api(path, body, timeoutMs) {
    let res;
    try {
      res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: timeoutSignal(timeoutMs || 10000) });
    } catch (e) {
      const timedOut = !!e && e.name === 'TimeoutError';
      return { ok: false, timedOut, error: timedOut ? 'The broker did not answer in time.' : 'Could not reach the broker.' };
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* empty or non-JSON body */ }
    if (!res.ok) {
      const msg = json && json.error ? json.error : 'Request failed (HTTP ' + res.status + ').';
      return { ok: false, error: res.status === 403 ? 'Refused by the broker: ' + msg : msg };
    }
    if (json && json.ok === false) return { ok: false, error: json.error || 'The broker rejected the request.' };
    return { ok: true, data: json };
  }
  // Runs one action at a time per key (no double submissions), shows its outcome, and refreshes if live updates are down.
  async function run(key, call, messages) {
    if (isPending(key)) return null;
    state.pending.add(key);
    render();
    try {
      const r = await call();
      if (!r.ok) toast((messages && messages.fail ? messages.fail + ' ' : '') + r.error, 'bad');
      else {
        settle(key);
        if (messages && messages.ok) toast(messages.ok, 'ok');
        if (state.conn !== 'live') refresh();
      }
      return r;
    } finally {
      state.pending.delete(key);
      render();
    }
  }

  /* ═══ Toasts, tooltip ═══ */
  const toastsEl = $('toasts');
  function toast(text, tone) {
    const t = tone || 'info';
    const iconName = t === 'ok' ? 'check-circle' : t === 'info' ? 'info' : 'alert';
    const el = h('div', { class: 'toast', 'data-tone': t, role: t === 'bad' ? 'alert' : 'status' },
      icon(iconName), h('div', { class: 'grow', text }),
      h('button', { type: 'button', class: 'icon-btn', 'data-action': 'dismiss-toast', 'aria-label': 'Dismiss' }, icon('x')));
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 4) toastsEl.firstElementChild.remove();
    setTimeout(() => el.remove(), t === 'bad' ? 8000 : 4000);
  }
  const tipEl = $('tip');
  let tipFor = null;
  function showTip(target) {
    tipFor = target;
    tipEl.textContent = target.getAttribute('data-tip');
    tipEl.hidden = false;
    const r = target.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let left, top;
    if (target.closest('.rail')) { left = r.right + 10; top = r.top + r.height / 2 - th / 2; }
    else { left = r.left + r.width / 2 - tw / 2; top = r.bottom + 8; if (top + th > window.innerHeight - 8) top = r.top - th - 8; }
    tipEl.style.left = Math.max(8, Math.min(left, window.innerWidth - tw - 8)) + 'px';
    tipEl.style.top = Math.max(8, top) + 'px';
  }
  function hideTip() { tipFor = null; tipEl.hidden = true; }

  /* ═══ Render scheduling ═══ */
  let renderQueued = false;
  const sigs = new Map();
  const changed = (key, sig) => (sigs.get(key) === sig ? false : (sigs.set(key, sig), true));
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; renderAll(); });
  }
  const REGIONS = ['panel-body', 'panel-actions', 'scope-actions', 'pins', 'timeline-col', 'composer', 'context'];
  function renderAll() {
    const before = document.activeElement;
    const region = before && before !== document.body ? REGIONS.find((id) => $(id) && $(id).contains(before)) : null;
    const spot = focusSpot(before, region ? $(region) : document);
    for (const view of [renderShell, renderTopbar, renderRail, renderPanel, renderScope, renderPins, renderTimeline, renderComposer, renderContext]) {
      try { view(); } catch (e) { console.error('[claude-peers] ' + view.name + ' failed', e); }
    }
    // A view can rebuild the focused control; give focus to its replacement so keyboard users keep their place.
    const now = document.activeElement;
    if (spot && !before.isConnected && (!now || now === document.body || now === before)) {
      if (!(region && refocus($(region), spot))) refocus(document, spot);
    }
  }
  // What identifies a control across re-renders: its action and target (within its message, since names and actions
  // repeat from message to message), or its id; plus its position among controls with that key, because the same peer
  // can appear in several rows of one list.
  function focusKey(a) {
    if (!a || a === document.body || !a.getAttribute) return null;
    const act = a.getAttribute('data-action');
    if (!act) return a.id ? attrSel('id', a.id) : null;
    const key = attrSel('data-action', act) + (a.hasAttribute('data-id') ? attrSel('data-id', a.getAttribute('data-id')) : '') + (a.hasAttribute('data-value') ? attrSel('data-value', a.getAttribute('data-value')) : '');
    const article = a.closest('article[data-msg-id]');
    return article ? attrSel('data-msg-id', article.getAttribute('data-msg-id')) + ' ' + key : key;
  }
  function focusSpot(a, scope) {
    const key = focusKey(a);
    return key ? { key, nth: Math.max(0, Array.prototype.indexOf.call(scope.querySelectorAll(key), a)) } : null;
  }
  function refocus(scope, spot) {
    const all = scope.querySelectorAll(spot.key);
    const el = all[Math.min(spot.nth, all.length - 1)];
    if (!el || el.closest('[inert]')) return false;
    el.focus({ preventScroll: true });
    return true;
  }
  // Re-render a container but keep keyboard focus and scroll where they were. scrollSel names the inner element that
  // scrolls when it is not the container itself.
  function keepFocus(container, build, scrollSel) {
    const a = document.activeElement;
    const spot = a && a !== container && container.contains(a) ? focusSpot(a, container) : null;
    const scroller = () => (scrollSel ? container.querySelector(scrollSel) : container);
    const s0 = scroller();
    const top = s0 ? s0.scrollTop : 0;
    build();
    const s1 = scroller();
    if (s1) s1.scrollTop = top;
    if (spot) refocus(container, spot);
  }
  const bucket = () => Math.floor(Date.now() / 30000); // relative times refresh every 30 s

  /* ═══ View: shell ═══ */
  const scrimEl = $('scrim');
  function renderShell() {
    const ui = state.ui;
    root.dataset.panel = panelOpen() ? 'open' : 'closed';
    root.dataset.ctx = ui.ctxOpen && ui.selected ? 'open' : 'closed';
    root.dataset.nav = ui.navOpen ? 'open' : 'closed';
    root.style.setProperty('--panel-pref', ui.panelWidth + 'px');
    const overlay = mqMobile.matches ? ui.navOpen
      : (mqPanelOverlay.matches && ui.panelOverlayOpen) || (mqContextDrawer.matches && root.dataset.ctx === 'open');
    scrimEl.hidden = !overlay;
    $('nav-toggle').setAttribute('aria-expanded', String(ui.navOpen));
    const toggle = $('panel-toggle');
    toggle.setAttribute('aria-expanded', String(panelOpen()));
    toggle.setAttribute('aria-label', panelOpen() ? 'Collapse panel' : 'Expand panel');
    toggle.setAttribute('data-tip', panelOpen() ? 'Collapse panel' : 'Expand panel');
    $('panel-resizer').setAttribute('aria-valuenow', String(ui.panelWidth));
    // Off-screen drawers must not be reachable by keyboard.
    $('panel').inert = mqMobile.matches ? !ui.navOpen : !panelOpen();
    $('context').inert = root.dataset.ctx !== 'open';
    $('rail').inert = mqMobile.matches && !ui.navOpen;
  }

  /* ═══ View: top bar + connection banner ═══ */
  const CONN_LABEL = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', offline: 'Offline' };
  const CONN_TIP = {
    connecting: 'Connecting to the broker',
    live: 'Receiving live updates from the broker',
    reconnecting: 'Live updates paused; refreshing every 5 seconds',
    offline: 'The broker is unreachable',
  };
  function brokerMeta() {
    const d = state.data;
    if (state.conn === 'offline') return 'Broker unreachable';
    if (!d) return 'Connecting to the broker…';
    return 'Broker up ' + uptime((d.uptime_ms || 0) + (Date.now() - state.dataAt));
  }
  function renderTopbar() {
    const d = state.data;
    setText($('uptime'), brokerMeta());
    const conn = $('conn');
    if (conn.dataset.state !== state.conn) conn.dataset.state = state.conn;
    conn.setAttribute('data-tip', CONN_TIP[state.conn]);
    setText($('conn-label'), CONN_LABEL[state.conn]);

    const banner = $('conn-banner');
    const down = (state.conn === 'reconnecting' || state.conn === 'offline') && !!d && Date.now() - state.downSince > 3000;
    banner.hidden = !down;
    if (down) {
      banner.dataset.state = state.conn;
      const asOf = 'Showing data from ' + fmtHMS.format(state.dataAt) + ' (' + ago(state.dataAt) + ').';
      setText($('conn-banner-text'), state.conn === 'offline'
        ? "Can't reach the broker. " + asOf
        : 'Live updates paused; reconnecting. ' + asOf);
    }
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    const btn = $('theme-btn');
    const label = light ? 'Switch to dark theme' : 'Switch to light theme';
    if (btn.getAttribute('aria-label') !== label) {
      btn.setAttribute('aria-label', label);
      btn.setAttribute('data-tip', label);
      fill(btn, icon(light ? 'moon' : 'sun'));
    }
  }

  /* ═══ View: rail ═══ */
  // A badge marks only what is waiting on someone: open tasks, file conflicts, pending checks, proposals awaiting your
  // vote. Plain totals (peers, groups, decisions) stay in the tab's label and tooltip.
  function railCounts() {
    const D = state.D;
    if (!D) return {};
    const totalFiles = D.owners.size;
    const awaiting = D.awaitingVote.length;
    return {
      peers: { n: 0, label: plural(D.peers.length, 'peer') + ' connected' },
      groups: { n: 0, label: plural(D.groups.length, 'group') },
      tasks: { n: D.openTasks.length, label: D.openTasks.length + ' open' },
      files: { n: D.conflicts.length, tone: 'bad', label: plural(totalFiles, 'file') + (D.conflicts.length ? ', ' + plural(D.conflicts.length, 'conflict') : '') },
      decisions: { n: 0, label: D.activeDecisions.length + ' active' },
      verifications: { n: D.pendingVerifications.length, label: D.pendingVerifications.length + ' pending' },
      proposals: { n: awaiting, tone: 'warn', label: D.openProposals.length + ' open' + (awaiting ? ', ' + awaiting + ' awaiting your vote' : '') },
      approvals: { n: D.pendingApprovals.length, label: D.pendingApprovals.length + ' pending' },
    };
  }
  function renderRail() {
    const counts = railCounts();
    const sig = JSON.stringify([state.ui.section, counts]);
    if (!changed('rail', sig)) return;
    for (const tab of document.querySelectorAll('.rail-tab')) {
      const s = tab.dataset.section;
      const selected = s === state.ui.section;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const c = counts[s];
      const countEl = tab.querySelector('.rail-count');
      if (countEl) {
        countEl.textContent = c && c.n ? (c.n > 99 ? '99+' : String(c.n)) : '';
        if (c && c.tone) countEl.dataset.tone = c.tone; else delete countEl.dataset.tone;
      }
      const label = SECTIONS[s].title + (c && c.label ? ' — ' + c.label : '');
      tab.querySelector('.sr-only').textContent = label;
      tab.setAttribute('data-tip', label);
    }
  }

  /* ═══ View: section panel ═══ */
  const panelBody = $('panel-body');
  let groupFormEl = null;
  let groupListEl = null;

  let scrolledToSel = null;
  function renderPanel() {
    const s = state.ui.section;
    const D = state.D;
    const sig = JSON.stringify([s, sectionSig(s), state.data ? 1 : 0, state.loadError ? 1 : 0]);
    if (!changed('panel', sig)) return;
    $('panel-title').textContent = SECTIONS[s].title;
    panelBody.setAttribute('aria-labelledby', 'tab-' + s);
    $('panel-sub').textContent = D ? sectionSub(s) : '';
    fill($('panel-actions'), D ? sectionActions(s) : null);
    if (s === 'groups' && D) {
      // The create-group form stays mounted so typing and focus survive live updates.
      if (!groupFormEl) groupFormEl = buildGroupForm();
      if (!groupListEl) groupListEl = h('div');
      if (panelBody.firstChild !== groupFormEl || panelBody.childNodes[1] !== groupListEl) fill(panelBody, [groupFormEl, groupListEl]);
      keepFocus(groupListEl, () => fill(groupListEl, groupsBody()));
      return;
    }
    keepFocus(panelBody, () => fill(panelBody, D ? sectionBody(s) : (state.loadError ? panelError() : skeletonRows())));
    // A peer selected elsewhere (a name in the conversation, the palette) is brought into view in the roster once.
    const selId = state.ui.selected ? state.ui.selected.id : null;
    if (s === 'peers' && selId && selId !== scrolledToSel) {
      const row = panelBody.querySelector('.peer.selected');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }
    scrolledToSel = s === 'peers' ? selId : null;
  }
  // Only what a view displays goes into its signature: the broker re-sends the whole state every 15 s with fresh
  // last_seen times, and those alone must not rebuild the roster under the pointer.
  const peerSig = (p) => [p.id, p.name, p.status, p.summary, p.cwd, p.git_root, p.git_branch, p.group_id, p.registered_at];
  function sectionSig(s) {
    const d = state.data, ui = state.ui;
    if (!d) return '';
    const pend = pendingKeys();
    switch (s) {
      case 'peers': return JSON.stringify([d.peers.map(peerSig), d.groups.map((g) => [g.id, g.name]), [...typingNow()], ui.selected, d.active_files.map((a) => [a.peer_id, a.files.length])]);
      case 'groups': return JSON.stringify([d.peers.map((p) => [p.id, p.name, p.group_id]), d.groups, ui.confirmGroup, pend]);
      case 'tasks': return JSON.stringify([d.tasks, ui.taskFilter, pend, peerNamesSig()]);
      case 'files': return JSON.stringify([d.active_files, peerNamesSig()]);
      case 'activity': return JSON.stringify([d.audit, peerNamesSig(), bucket()]);
      case 'decisions': return JSON.stringify([d.decisions, ui.decisionFilter, peerNamesSig()]);
      case 'verifications': return JSON.stringify([d.verifications, peerNamesSig()]);
      case 'proposals': return JSON.stringify([d.proposals, pend, peerNamesSig()]);
      case 'approvals': return JSON.stringify([d.approvals, peerNamesSig()]);
    }
    return '';
  }
  const peerNamesSig = () => (state.D ? state.D.peers.map((p) => p.id + ':' + p.name).join(',') : '');
  function sectionSub(s) {
    const D = state.D;
    switch (s) {
      case 'peers': return D.peers.length ? D.peers.length + ' connected' : 'None connected';
      case 'groups': return plural(D.groups.length, 'group');
      case 'tasks': return D.openTasks.length + ' open · ' + (D.tasks.length - D.openTasks.length) + ' done';
      case 'files': return plural(D.owners.size, 'file') + (D.conflicts.length ? ' · ' + plural(D.conflicts.length, 'conflict') : '');
      case 'activity': return 'Latest broker events';
      case 'decisions': return D.activeDecisions.length + ' active' + (D.decisions.length > D.activeDecisions.length ? ' · ' + (D.decisions.length - D.activeDecisions.length) + ' revoked' : '');
      case 'verifications': return D.pendingVerifications.length + ' pending · ' + (D.verifications.length - D.pendingVerifications.length) + ' resolved';
      case 'proposals': return D.openProposals.length + ' open';
      case 'approvals': return D.pendingApprovals.length + ' pending';
    }
    return '';
  }
  function seg(action, value, options) {
    return h('div', { class: 'seg', role: 'group' }, options.map((o) =>
      h('button', { type: 'button', 'data-action': action, 'data-value': o.value, 'aria-pressed': String(o.value === value) }, o.label, o.n !== undefined ? h('span', { class: 'n', text: String(o.n) }) : null)));
  }
  function sectionActions(s) {
    const D = state.D, ui = state.ui;
    if (s === 'tasks') {
      return seg('task-filter', ui.taskFilter, [
        { value: 'open', label: 'Open', n: D.openTasks.length },
        { value: 'done', label: 'Done', n: D.tasks.length - D.openTasks.length },
        { value: 'all', label: 'All' },
      ]);
    }
    if (s === 'decisions' && D.decisions.length > D.activeDecisions.length) {
      return seg('decision-filter', ui.decisionFilter, [{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]);
    }
    return null;
  }
  function sectionBody(s) {
    switch (s) {
      case 'peers': return peersBody();
      case 'tasks': return tasksBody();
      case 'files': return filesBody();
      case 'activity': return activityBody();
      case 'decisions': return decisionsBody();
      case 'verifications': return verificationsBody();
      case 'proposals': return proposalsBody();
      case 'approvals': return approvalsBody();
    }
    return null;
  }
  function empty(iconName, title, body, extra) {
    return h('div', { class: 'empty' }, icon(iconName), h('div', { class: 'empty-title', text: title }), body ? h('div', { class: 'empty-body' }, body) : null, extra || null);
  }
  const code = (t) => h('code', { text: t });
  function skeletonRows() {
    return [1, 2, 3, 4].map(() => h('div', { class: 'skel-peer', 'aria-hidden': 'true' },
      h('div', { class: 'skel', style: { width: '30px', height: '30px' } }),
      h('div', null, h('div', { class: 'skel', style: { width: '45%', height: '12px' } }), h('div', { class: 'skel', style: { width: '85%', height: '10px', 'margin-top': '8px' } }))));
  }
  function panelError() { return empty('offline', 'Waiting for the broker', ['This panel fills in as soon as the dashboard reaches the broker.']); }

  /* Peers */
  function peersBody() {
    const D = state.D, ui = state.ui;
    const out = [];
    // Rows use a stretched button: its name is just the visible label, and an overlay makes the whole row clickable.
    out.push(h('div', { class: 'peer' + (ui.selected ? '' : ' selected') },
      h('span', { class: 'tile', 'aria-hidden': 'true' }, icon('message')),
      h('div', { class: 'peer-main' },
        h('div', { class: 'peer-top' }, h('button', { type: 'button', class: 'peer-btn peer-name', 'data-action': 'clear-scope', 'aria-pressed': String(!ui.selected), 'aria-describedby': 'peer-sum-all' }, 'All traffic')),
        h('div', { class: 'peer-summary', id: 'peer-sum-all', text: 'Every message of this session, between any peers.' }))));
    if (!D.peers.length) {
      out.push(empty('peers', 'No peers connected', ['Claude Code sessions that run the claude-peers MCP server show up here as soon as they register.']));
      return out;
    }
    const lobby = D.peers.filter((p) => !p.group_id || !D.groupById.has(p.group_id));
    const sections = [];
    if (lobby.length) sections.push({ label: 'Lobby', iconName: 'lobby', peers: lobby });
    for (const g of D.groups) {
      const members = D.peers.filter((p) => p.group_id === g.id);
      if (members.length) sections.push({ label: groupLabel(g.name), iconName: g.name.startsWith('branch/') ? 'branch' : 'groups', peers: members, title: g.name });
    }
    for (const sct of sections) {
      out.push(h('div', { class: 'group-head', title: sct.title || null }, icon(sct.iconName), h('span', { class: 'label', text: sct.label }), h('span', { class: 'count', text: String(sct.peers.length) })));
      out.push(h('div', { role: 'list' }, sct.peers.map((p) => h('div', { role: 'listitem' }, peerRow(p)))));
    }
    return out;
  }
  function peerRow(p) {
    const D = state.D, ui = state.ui;
    const r = ref(p.id);
    const status = p.status || 'online';
    const typing = typingNow().has(p.id);
    const fileCount = (state.data.active_files.find((a) => a.peer_id === p.id) || { files: [] }).files.length;
    const summaryId = 'peer-sum-' + p.id, statusId = 'peer-st-' + p.id;
    const selected = !!ui.selected && ui.selected.id === p.id;
    const cwd = splitPath(String(p.cwd || '').replace(/[\\/]+$/, ''));
    return h('div', { class: 'peer' + (selected ? ' selected' : '') },
      h('span', { class: 'avatar' }, tile(r), presence(status)),
      h('div', { class: 'peer-main' },
        h('div', { class: 'peer-top' },
          h('button', { type: 'button', class: 'peer-btn peer-name', 'data-action': 'select-peer', 'data-id': p.id, 'aria-pressed': String(selected), 'aria-describedby': statusId + ' ' + summaryId }, p.name || p.id),
          h('span', { class: 'peer-status', id: statusId, 'data-status': status, text: typing ? '' : STATUS_LABEL[status] },
            typing ? h('span', { class: 'peer-typing' }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')), ' typing') : null)),
        h('div', { class: 'peer-summary' + (p.summary ? '' : ' none'), id: summaryId, title: p.summary || null, text: p.summary || 'No summary yet' }),
        h('div', { class: 'peer-meta' },
          p.git_branch ? h('span', { title: 'Git branch' }, icon('branch'), h('span', { class: 'mono', text: p.git_branch })) : null,
          h('span', { title: p.cwd }, icon('folder'), h('span', { class: 'mono', text: cwd.base || p.cwd || '—' })),
          fileCount ? h('span', { title: plural(fileCount, 'active file') }, icon('files'), String(fileCount)) : null)));
  }

  /* Groups */
  function buildGroupForm() {
    const input = h('input', { class: 'input', id: 'group-name', name: 'group-name', placeholder: 'e.g. frontend-team', autocomplete: 'off', spellcheck: 'false', maxlength: '32', 'aria-describedby': 'group-name-msg' });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus'), 'Create');
    const msg = h('div', { class: 'field-hint', id: 'group-name-msg', text: 'Letters, numbers, - and _, up to 32 characters.' });
    const form = h('form', { class: 'form', novalidate: true, 'aria-label': 'Create a group' }, h('label', { for: 'group-name', text: 'New group' }), h('div', { class: 'form-row' }, input, btn), msg);
    const setMsg = (text, isError) => { msg.textContent = text; msg.className = isError ? 'field-error' : 'field-hint'; input.setAttribute('aria-invalid', String(!!isError)); };
    input.addEventListener('input', () => { if (input.getAttribute('aria-invalid') === 'true') setMsg('Letters, numbers, - and _, up to 32 characters.', false); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      const problem = !name ? 'Enter a name for the group.'
        : name.length > 32 ? 'Use 32 characters or fewer.'
          : !/^[A-Za-z0-9_-]+$/.test(name) ? 'Use only letters, numbers, hyphens and underscores.' : '';
      if (problem) { setMsg(problem, true); input.focus(); return; }
      if (isPending('group-create')) return;
      // aria-disabled, not disabled: a disabled button would drop keyboard focus while the request runs.
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-busy', 'true');
      state.pending.add('group-create');
      const r = await api('/create-group', { name });
      state.pending.delete('group-create');
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('aria-busy');
      if (r.ok) {
        input.value = '';
        setMsg('Letters, numbers, - and _, up to 32 characters.', false);
        toast('Group “' + name + '” created. Move peers into it from their details.', 'ok');
        if (state.conn !== 'live') refresh();
      } else {
        setMsg(r.error, true);
      }
    });
    return form;
  }
  function groupsBody() {
    const D = state.D, ui = state.ui;
    const out = [];
    const lobby = D.peers.filter((p) => !p.group_id || !D.groupById.has(p.group_id));
    out.push(h('div', { class: 'row' },
      h('div', { class: 'row-top' }, icon('lobby'), h('div', { class: 'row-title', text: 'Lobby' }), h('span', { class: 'badge', style: { 'margin-left': 'auto' }, text: plural(lobby.length, 'member') })),
      h('div', { class: 'row-text', text: 'Peers without a group. They can message each other and the dashboard.' }),
      lobby.length ? h('div', { class: 'group-members' }, lobby.map((p) => who(ref(p.id)))) : null));
    if (!D.groups.length) {
      out.push(h('div', { class: 'panel-note', text: 'No groups yet. Peers on the same git branch are grouped automatically; create a group above to isolate others.' }));
      return out;
    }
    for (const g of D.groups) {
      const members = D.peers.filter((p) => p.group_id === g.id);
      const auto = g.name.startsWith('branch/');
      const confirming = ui.confirmGroup === g.id;
      const busy = isPending('group-delete:' + g.id);
      out.push(h('div', { class: 'row' },
        h('div', { class: 'row-top' },
          icon(auto ? 'branch' : 'groups'),
          h('div', { style: { 'min-width': '0' } },
            h('div', { class: 'row-title', text: groupLabel(g.name) }),
            auto ? h('div', { class: 'row-text', style: { 'margin-top': '0' }, text: 'Created automatically for git branch ' + groupLabel(g.name) }) : null),
          h('span', { class: 'badge', style: { 'margin-left': 'auto' }, text: plural(members.length, 'member') }),
          confirming ? null : h('button', { type: 'button', class: 'icon-btn', 'data-action': 'delete-group', 'data-id': g.id, 'aria-label': 'Delete group ' + g.name, 'data-tip': 'Delete group' }, icon('trash'))),
        members.length ? h('div', { class: 'group-members' }, members.map((p) => who(ref(p.id)))) : h('div', { class: 'row-text', text: 'No members.' }),
        confirming ? h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm deleting ' + g.name },
          h('p', { text: members.length
            ? 'Delete “' + g.name + '”? ' + (members.length === 1 ? 'Its member moves' : 'Its ' + members.length + ' members move') + ' to the Lobby, and default names (claude-N) are renumbered.'
            : 'Delete the empty group “' + g.name + '”?' }),
          h('button', { type: 'button', class: 'btn btn-danger solid', 'data-action': 'confirm-delete-group', 'data-id': g.id, 'aria-disabled': busy ? 'true' : null, 'aria-busy': busy ? 'true' : null }, busy ? icon('loader', 'spin') : icon('trash'), 'Delete group'),
          h('button', { type: 'button', class: 'btn btn-ghost', 'data-action': 'cancel-delete-group', 'data-id': g.id }, 'Cancel')) : null));
    }
    return out;
  }

  /* Tasks */
  function taskRow(t) {
    const done = t.status === 'completed';
    const busy = isPending('task:' + t.id);
    const assignee = t.assignee_id ? ref(t.assignee_id) : null;
    const creator = t.creator_id ? ref(t.creator_id) : null;
    const check = done
      ? h('span', { class: 'check done', role: 'img', 'aria-label': 'Completed' }, icon('check'))
      : h('button', {
        type: 'button', class: 'check', 'data-action': 'complete-task', 'data-id': t.id, 'aria-disabled': busy ? 'true' : null, 'aria-busy': busy ? 'true' : null,
        'aria-label': 'Mark “' + t.title + '” complete', 'data-tip': creator && creator.kind === 'peer' ? 'Mark complete (notifies ' + creator.name + ')' : 'Mark complete',
      }, busy ? icon('loader', 'spin') : icon('check'));
    return h('div', { class: 'row task' + (done ? ' done' : '') },
      check,
      h('div', { style: { 'min-width': '0' } },
        h('div', { class: 'row-title', text: t.title }),
        t.description ? h('div', { class: 'row-text', text: t.description }) : null,
        done && t.result ? h('dl', { class: 'kv' }, h('dt', { text: 'Result' }), h('dd', { text: t.result })) : null,
        h('div', { class: 'row-meta' },
          assignee ? h('span', null, who(assignee)) : h('span', { text: 'Unassigned' }),
          creator && (!assignee || creator.id !== assignee.id) ? h('span', null, 'from ', who(creator, { tile: false })) : null,
          h('span', { title: full(done ? t.completed_at : t.created_at) }, icon('clock'), done && t.completed_at ? 'Done ' + time(t.completed_at) : time(t.created_at)),
          t.status === 'in_progress' ? h('span', { class: 'badge', 'data-tone': 'info', text: 'In progress' }) : null)));
  }
  function tasksBody() {
    const D = state.D, f = state.ui.taskFilter;
    const list = D.tasks.filter((t) => (f === 'all' ? true : f === 'done' ? t.status === 'completed' : t.status !== 'completed'));
    if (!D.tasks.length) return empty('tasks', 'No tasks yet', ['Peers create and assign tasks with ', code('create_task'), '. They appear here with their owner and status.']);
    if (!list.length) return empty('tasks', f === 'open' ? 'Nothing open' : 'Nothing completed yet', f === 'open' ? ['Every task in this session is done.'] : ['Completed tasks appear here with their results.']);
    const out = list.map(taskRow);
    if (D.tasks.length >= 100) out.push(h('div', { class: 'panel-note', text: 'Showing the 100 most recent tasks of this session.' }));
    return out;
  }

  /* Active files */
  // Owners are listed only for conflicts; elsewhere the surrounding section already names the peer.
  function fileRow(path, owners, conflict) {
    const parts = splitPath(path);
    return h('div', { class: 'row file' + (conflict ? ' conflict' : '') },
      icon(conflict ? 'alert' : 'files'),
      h('div', { style: { 'min-width': '0' } },
        h('div', { class: 'file-path', title: path }, h('span', { class: 'file-base', text: parts.base }), h('span', { class: 'file-dir', text: parts.dir })),
        conflict ? h('div', { class: 'row-text', style: { color: 'var(--bad)' }, text: plural(owners.length, 'peer') + ' are editing this file' }) : null,
        conflict ? h('div', { class: 'file-owners' }, owners.map((o) => who(ref(o.id, o.name)))) : null));
  }
  function filesBody() {
    const D = state.D;
    if (!D.files.length) return empty('files', 'No active edits', ['Peers report the files they are editing with ', code('set_active_files'), '. Entries expire after a minute without an update.']);
    const out = [];
    if (D.conflicts.length) {
      out.push(h('div', { class: 'section-label' }, icon('alert'), 'Conflicts', h('span', { class: 'count', text: String(D.conflicts.length) })));
      for (const c of D.conflicts) out.push(fileRow(c.path, c.owners, true));
    }
    const byPeer = new Map();
    for (const f of D.files) {
      if (D.owners.get(f.key).owners.length > 1) continue;
      if (!byPeer.has(f.peer_id)) byPeer.set(f.peer_id, { name: f.peer_name, files: [] });
      byPeer.get(f.peer_id).files.push(f.path);
    }
    for (const [pid, entry] of byPeer) {
      out.push(h('div', { class: 'section-label' }, who(ref(pid, entry.name)), h('span', { class: 'count', text: String(entry.files.length) })));
      for (const path of entry.files) out.push(fileRow(path, [{ id: pid, name: entry.name }], false));
    }
    out.push(h('div', { class: 'panel-note', text: 'File paths as reported by each peer. Only paths are shared, never file contents.' }));
    return out;
  }

  /* Activity */
  function describeEvent(a) {
    const action = String(a.action || '');
    const d = String(a.details || '');
    switch (action) {
      case 'peer.register': return { iconName: 'user-plus', tone: 'ok', verb: 'joined', detail: d.replace(/^.*? joined from /, 'from ') };
      case 'peer.disconnect': return { iconName: 'user-minus', verb: 'disconnected', detail: '' };
      case 'peer.stale_cleanup': return { iconName: 'user-x', tone: 'warn', verb: 'timed out and was removed', detail: 'No heartbeat for 45 seconds.' };
      case 'identity.register_mismatch': return { iconName: 'shield-alert', tone: 'bad', verb: 'Refused a registration', detail: d, noActor: true };
      case 'identity.mismatch': return { iconName: 'shield-alert', tone: 'bad', verb: 'Refused a request made on behalf of', detail: d, actorAfter: true };
      case 'approval.request': return { iconName: 'approvals', verb: 'requested approval', detail: d };
      case 'approval.approved': return { iconName: 'check-circle', tone: 'ok', verb: 'approved a request', detail: d };
      case 'approval.rejected': return { iconName: 'x-circle', tone: 'bad', verb: 'rejected a request', detail: d };
      case 'message.structured': {
        const m = d.match(/^(\w+) \u2192 (.+)$/);
        return { iconName: 'message', verb: 'sent a ' + (m && KINDS[m[1]] ? KINDS[m[1]].label.toLowerCase() : 'structured message'), detail: m ? 'to ' + ref(m[2]).name : d };
      }
      case 'decision.post': return { iconName: 'decisions', tone: 'violet', verb: 'recorded a decision', detail: d };
      case 'decision.revoke': return { iconName: 'decisions', tone: 'warn', verb: 'revoked a decision', detail: d.replace(/^Revoked: /, '') };
      case 'verification.request': return { iconName: 'verifications', tone: 'info', verb: 'asked for verification', detail: d };
      case 'verification.verified': return { iconName: 'verifications', tone: 'ok', verb: 'verified a claim', detail: d };
      case 'verification.failed': return { iconName: 'shield-alert', tone: 'bad', verb: 'marked a claim as failed', detail: d };
      case 'proposal.create': return { iconName: 'proposals', verb: 'opened a proposal', detail: d };
      case 'proposal.vote': {
        const m = d.match(/^(approve|reject) on "(.*)"$/);
        return m ? { iconName: m[1] === 'approve' ? 'check-circle' : 'x-circle', tone: m[1] === 'approve' ? 'ok' : 'bad', verb: m[1] === 'approve' ? 'voted to approve' : 'voted to reject', detail: m[2] } : { iconName: 'proposals', verb: 'voted', detail: d };
      }
      default: return { iconName: 'activity', verb: action, detail: d };
    }
  }
  function eventRow(a) {
    const ev = describeEvent(a);
    const actor = ref(a.actor_id, a.actor_name);
    let text;
    if (ev.noActor) text = [ev.verb];
    else if (ev.actorAfter) text = [ev.verb + ' ', who(actor, { tile: false })];
    else text = [who(actor, { tile: false }), ' ' + ev.verb];
    return h('div', { class: 'event' },
      h('span', { class: 'event-icon', 'data-tone': ev.tone || null }, icon(ev.iconName)),
      h('div', { style: { 'min-width': '0' } },
        h('div', { class: 'event-text' }, text),
        ev.detail ? h('div', { class: 'event-detail', text: ev.detail }) : null,
        h('div', { class: 'event-time', title: full(a.created_at) }, time(a.created_at) + ' · ' + ago(ms(a.created_at)))));
  }
  function activityBody() {
    const audit = state.data.audit || [];
    if (!audit.length) return empty('activity', 'No activity yet', ['Joins, departures, decisions, votes, verifications and refused requests are logged here.']);
    return [audit.map(eventRow), h('div', { class: 'panel-note', text: 'The broker sends its ' + audit.length + ' most recent events. The session report has the longer history.' })];
  }

  /* Decisions */
  function decisionsBody() {
    const D = state.D;
    const items = state.ui.decisionFilter === 'all' ? D.decisions : D.activeDecisions;
    if (!D.decisions.length) return empty('decisions', 'No decisions recorded', ['Peers record shared choices with ', code('post_decision'), ' so every session follows them.']);
    if (!items.length) return empty('decisions', 'No active decisions', ['All recorded decisions have been revoked.']);
    const cats = new Map();
    for (const x of items) { const c = x.category || 'general'; if (!cats.has(c)) cats.set(c, []); cats.get(c).push(x); }
    const out = [];
    for (const [cat, entries] of [...cats].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(h('div', { class: 'section-label' }, h('span', { text: cat.charAt(0).toUpperCase() + cat.slice(1) }), h('span', { class: 'count', text: String(entries.length) })));
      for (const x of entries) {
        const revoked = x.status === 'revoked';
        out.push(h('div', { class: 'row decision' + (revoked ? ' revoked' : '') },
          h('div', { class: 'row-top' }, h('span', { class: 'decision-key', text: x.key }), revoked ? h('span', { class: 'badge', 'data-tone': 'warn', style: { 'margin-left': 'auto' } }, 'Revoked') : null),
          h('div', { class: 'decision-value', text: x.value }),
          x.rationale ? h('div', { class: 'row-text', text: x.rationale }) : null,
          h('div', { class: 'row-meta' }, who(ref(x.author_id, x.author_name)), h('span', { title: full(x.updated_at) }, icon('clock'), (revoked ? 'Revoked ' : 'Updated ') + time(x.updated_at)))));
      }
    }
    return out;
  }

  /* Verifications */
  const VERIFY = { pending: { tone: 'warn', iconName: 'clock', label: 'Pending' }, verified: { tone: 'ok', iconName: 'check-circle', label: 'Verified' }, failed: { tone: 'bad', iconName: 'x-circle', label: 'Failed' } };
  function filesList(raw) {
    let files = [];
    try { files = JSON.parse(raw || '[]'); } catch (e) { files = []; }
    return Array.isArray(files) && files.length ? h('div', { class: 'chips' }, files.map((f) => h('span', { class: 'chip-mono', text: String(f) }))) : null;
  }
  function verificationRow(v) {
    const st = VERIFY[v.status] || VERIFY.pending;
    const files = filesList(v.files_to_check);
    const kv = [];
    if (v.evidence_needed) kv.push(h('dt', { text: 'Evidence needed' }), h('dd', { text: v.evidence_needed }));
    if (files) kv.push(h('dt', { text: 'Files' }), h('dd', null, files));
    if (v.response) kv.push(h('dt', { text: 'Response' }), h('dd', { text: v.response }));
    if (v.evidence) kv.push(h('dt', { text: 'Evidence' }), h('dd', { text: v.evidence }));
    return h('div', { class: 'row' },
      h('div', { class: 'row-top' }, h('div', { class: 'row-title', text: v.claim }), h('span', { class: 'badge', 'data-tone': st.tone, style: { 'margin-left': 'auto' } }, icon(st.iconName), st.label)),
      h('div', { class: 'row-meta' }, who(ref(v.requester_id)), h('span', null, icon('arrow-right'), who(ref(v.verifier_id))),
        h('span', { title: full(v.resolved_at || v.created_at) }, icon('clock'), v.resolved_at ? 'Resolved ' + time(v.resolved_at) : 'Asked ' + time(v.created_at))),
      kv.length ? h('dl', { class: 'kv' }, kv) : null);
  }
  function verificationsBody() {
    const D = state.D;
    if (!D.verifications.length) return empty('verifications', 'No verifications', ['A peer asks another to check a claim with ', code('request_verification'), '; the verifier answers verified or failed.']);
    const resolved = D.verifications.filter((v) => v.status !== 'pending');
    const out = [];
    if (D.pendingVerifications.length) { out.push(h('div', { class: 'section-label' }, 'Pending', h('span', { class: 'count', text: String(D.pendingVerifications.length) }))); out.push(D.pendingVerifications.map(verificationRow)); }
    if (resolved.length) { out.push(h('div', { class: 'section-label' }, 'Resolved', h('span', { class: 'count', text: String(resolved.length) }))); out.push(resolved.map(verificationRow)); }
    return out;
  }

  /* Proposals */
  function ballot(p) {
    const votes = p.votes || [];
    const yes = votes.filter((v) => v.vote === 'approve').length, no = votes.filter((v) => v.vote === 'reject').length;
    const need = Math.max(1, p.required_votes || 1);
    const slots = (n, cls) => h('div', { class: 'slots', 'aria-hidden': 'true' }, Array.from({ length: need }, (_, i) => h('span', { class: 'slot' + (i < n ? ' ' + cls : '') })));
    return h('div', { class: 'ballot', role: 'img', 'aria-label': yes + ' of ' + need + ' approvals needed, ' + no + ' of ' + need + ' rejections' },
      h('div', { class: 'ballot-row' }, h('span', { text: 'Approve' }), slots(yes, 'approve'), h('span', { class: 'num', text: yes + ' / ' + need })),
      h('div', { class: 'ballot-row' }, h('span', { text: 'Reject' }), slots(no, 'reject'), h('span', { class: 'num', text: no + ' / ' + need })));
  }
  const PROPOSAL = { open: { tone: 'accent', label: 'Open' }, approved: { tone: 'ok', label: 'Approved' }, rejected: { tone: 'bad', label: 'Rejected' } };
  function proposalRow(p) {
    const st = PROPOSAL[p.status] || PROPOSAL.open;
    const votes = p.votes || [];
    const mine = votes.find((v) => v.voter_id === 'dashboard');
    const busy = isPending('vote:' + p.id);
    return h('div', { class: 'row' },
      h('div', { class: 'row-top' }, h('div', { class: 'row-title', text: p.title }), h('span', { class: 'badge', 'data-tone': st.tone, style: { 'margin-left': 'auto' }, text: st.label })),
      p.description ? h('div', { class: 'row-text', text: p.description }) : null,
      h('div', { class: 'row-meta' }, who(ref(p.author_id, p.author_name)), h('span', { title: full(p.resolved_at || p.created_at) }, icon('clock'), p.resolved_at ? 'Resolved ' + time(p.resolved_at) : 'Opened ' + time(p.created_at))),
      ballot(p),
      p.status === 'open' ? h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn', 'data-tone': 'ok', 'data-action': 'vote', 'data-id': p.id, 'data-value': 'approve', 'aria-pressed': String(!!mine && mine.vote === 'approve'), 'aria-disabled': busy ? 'true' : null }, busy ? icon('loader', 'spin') : icon('check'), 'Approve'),
        h('button', { type: 'button', class: 'btn', 'data-tone': 'bad', 'data-action': 'vote', 'data-id': p.id, 'data-value': 'reject', 'aria-pressed': String(!!mine && mine.vote === 'reject'), 'aria-disabled': busy ? 'true' : null }, icon('x'), 'Reject'),
        mine ? h('span', { class: 'field-hint', style: { margin: '0' }, text: 'You voted to ' + mine.vote + '. Voting again replaces it.' }) : null) : null,
      votes.length ? h('div', { class: 'voters' }, votes.map((v) => h('div', { class: 'voter' },
        icon(v.vote === 'approve' ? 'check' : 'x', v.vote === 'approve' ? 'ok' : 'bad'),
        who(ref(v.voter_id, v.voter_name)),
        h('span', { class: 'voter-reason', text: v.reason || '' })))) : null);
  }
  function proposalsBody() {
    const D = state.D;
    if (!D.proposals.length) return empty('proposals', 'No proposals', ['Peers open proposals with ', code('create_proposal'), '. You can vote here; a proposal resolves when it reaches its vote threshold.']);
    const closed = D.proposals.filter((p) => p.status !== 'open');
    const out = [];
    if (D.openProposals.length) { out.push(h('div', { class: 'section-label' }, 'Open', h('span', { class: 'count', text: String(D.openProposals.length) }))); out.push(D.openProposals.map(proposalRow)); }
    if (closed.length) { out.push(h('div', { class: 'section-label' }, 'Resolved', h('span', { class: 'count', text: String(closed.length) }))); out.push(closed.map(proposalRow)); }
    return out;
  }

  /* Approvals */
  const APPROVAL = { pending: { tone: 'warn', iconName: 'clock', label: 'Pending' }, approved: { tone: 'ok', iconName: 'check-circle', label: 'Approved' }, rejected: { tone: 'bad', iconName: 'x-circle', label: 'Rejected' } };
  function approvalRow(a) {
    const st = APPROVAL[a.status] || APPROVAL.pending;
    return h('div', { class: 'row' },
      h('div', { class: 'row-top' }, h('div', { class: 'row-title', text: a.action_description }), h('span', { class: 'badge', 'data-tone': st.tone, style: { 'margin-left': 'auto' } }, icon(st.iconName), st.label)),
      h('div', { class: 'row-meta' }, who(ref(a.requester_id)), h('span', null, icon('arrow-right'), who(ref(a.approver_id))),
        h('span', { title: full(a.resolved_at || a.created_at) }, icon('clock'), a.resolved_at ? 'Answered ' + time(a.resolved_at) : 'Asked ' + time(a.created_at))));
  }
  function approvalsBody() {
    const D = state.D;
    const note = h('div', { class: 'panel-note', text: 'Approvals are answered by the designated peer with respond_approval. The broker does not accept approvals from the dashboard.' });
    if (!D.approvals.length) return [empty('approvals', 'No approval requests', ['A peer asks another for sign-off before a risky action with ', code('request_approval'), '.']), note];
    const answered = D.approvals.filter((a) => a.status !== 'pending');
    const out = [];
    if (D.pendingApprovals.length) { out.push(h('div', { class: 'section-label' }, 'Pending', h('span', { class: 'count', text: String(D.pendingApprovals.length) }))); out.push(D.pendingApprovals.map(approvalRow)); }
    if (answered.length) { out.push(h('div', { class: 'section-label' }, 'Answered', h('span', { class: 'count', text: String(answered.length) }))); out.push(answered.map(approvalRow)); }
    out.push(note);
    return out;
  }

  /* ═══ View: conversation scope header ═══ */
  function renderScope() {
    const d = state.data, sel = state.ui.selected;
    const count = d ? visibleMessages(true).length : 0;
    const p = sel && state.D ? state.D.peerById.get(sel.id) : null;
    // With the details column docked beside the conversation, the peer's tile and status are already in view there.
    const docked = !!sel && state.ui.ctxOpen && !mqContextDrawer.matches;
    const sig = JSON.stringify([sel, count, d ? [d.messages.length, d.peers.length] : -1, p ? p.status : null, state.ui.ctxOpen, docked]);
    if (!changed('scope', sig)) return;
    const scope = $('scope');
    if (!sel) {
      const capped = d && d.messages.length >= MESSAGE_CAP;
      fill(scope, [h('span', { class: 'tile', 'aria-hidden': 'true' }, icon('message')),
        h('div', { class: 'scope-text' }, h('h1', { class: 'scope-title', text: 'All traffic' }),
          h('div', { class: 'scope-sub', text: d ? plural(d.messages.length, 'message') + (capped ? ' (latest ' + MESSAGE_CAP + ')' : '') + ' · ' + plural(d.peers.length, 'peer') + ' connected' : 'Loading…' }))]);
      fill($('scope-actions'), null);
      return;
    }
    const r = ref(sel.id, sel.name);
    if (docked) {
      fill(scope, h('div', { class: 'scope-text' }, h('h1', { class: 'scope-title' }, 'Messages with ', nameSpan(r)),
        h('div', { class: 'scope-sub', text: plural(count, 'message') + (p ? '' : ' · disconnected') })));
    } else {
      fill(scope, [h('span', { class: 'avatar', style: { '--ring': 'var(--stage)' } }, tile(r), p ? presence(p.status) : null),
        h('div', { class: 'scope-text' }, h('h1', { class: 'scope-title' }, nameSpan(r)),
          h('div', { class: 'scope-sub', text: (p ? STATUS_LABEL[p.status || 'online'] : 'Disconnected') + ' · ' + plural(count, 'message') + ' to or from ' + r.name }))]);
    }
    fill($('scope-actions'), [
      h('button', { type: 'button', class: 'icon-btn', 'data-action': 'toggle-details', 'aria-expanded': String(state.ui.ctxOpen), 'aria-controls': 'context', 'aria-label': (state.ui.ctxOpen ? 'Hide' : 'Show') + ' details for ' + r.name, 'data-tip': (state.ui.ctxOpen ? 'Hide' : 'Show') + ' details' }, icon('details')),
      h('button', { type: 'button', class: 'icon-btn', 'data-action': 'clear-scope', 'aria-label': 'Show all traffic', 'data-tip': 'Show all traffic' }, icon('x')),
    ]);
  }

  /* ═══ View: pinned strip ═══ */
  function renderPins() {
    const d = state.data;
    const pinned = d ? (d.pinned || []) : [];
    const sig = JSON.stringify([pinned.map((m) => [m.id, m.text.length]), state.ui.pinsOpen, peerNamesSig(), pendingKeys().split(',').filter((k) => k.startsWith('pin:'))]);
    if (!changed('pins', sig)) return;
    const el = $('pins');
    if (!pinned.length) { el.hidden = true; el.replaceChildren(); return; }
    el.hidden = false;
    const latest = pinned[pinned.length - 1];
    const one = pinned.length === 1;
    const open = state.ui.pinsOpen && !one;
    const unpin = (m, label) => h('button', { type: 'button', class: 'icon-btn', 'data-action': 'unpin', 'data-id': m.id, 'aria-label': label, 'data-tip': 'Unpin', 'aria-disabled': isPending('pin:' + m.id) ? 'true' : null }, icon('x'));
    const row = (m) => {
      const r = ref(m.from_id, m.from_name);
      return h('div', { class: 'pin-row' }, who(r, { button: false }),
        h('span', { class: 'pin-text', text: excerpt(m.text, 220) }),
        h('button', { type: 'button', class: 'btn btn-ghost', 'data-action': 'jump-to', 'data-id': m.id }, 'Jump'),
        unpin(m, 'Unpin message from ' + r.name));
    };
    const lr = ref(latest.from_id, latest.from_name);
    fill(el, [
      h('div', { class: 'pins-bar' }, icon('pin'),
        h('span', { class: 'pins-label', text: one ? 'Pinned' : pinned.length + ' pinned' }),
        open ? h('span', { class: 'pins-latest' }) : h('span', { class: 'pins-latest' }, h('b', { text: lr.name + ': ' }), excerpt(latest.text, 200)),
        one ? h('button', { type: 'button', class: 'btn btn-ghost', 'data-action': 'jump-to', 'data-id': latest.id }, 'Jump') : null,
        one ? unpin(latest, 'Unpin message')
          : h('button', { type: 'button', class: 'btn btn-ghost', 'data-action': 'toggle-pins', 'aria-expanded': String(open), 'aria-controls': 'pins-list' }, open ? 'Hide' : 'Show all', icon(open ? 'chevron-down' : 'chevron-right'))),
      open ? h('div', { class: 'pins-list', id: 'pins-list' }, pinned.slice().reverse().map(row)) : null,
    ]);
  }

  /* ═══ View: timeline (keyed) ═══ */
  const timelineEl = $('timeline');
  const colEl = $('timeline-col');
  const nodes = new Map();        // key -> { sig, el }
  const lastDelivery = new Map(); // message id -> delivery state last rendered
  let seenIds = null;             // message ids of the last rendered snapshot (null until the first render)
  const snapshotIds = (d) => new Set(d.messages.map((m) => m.id));
  let stickToBottom = true;
  let unseen = 0;
  let revealedId = null;          // touch: the message whose actions were revealed by a tap

  function visibleMessages(scopeOnly) {
    const d = state.data;
    if (!d) return [];
    let msgs = d.messages;
    const sel = state.ui.selected;
    if (sel) msgs = msgs.filter((m) => involves(m, sel));
    const q = state.ui.search.trim().toLowerCase();
    if (q && !scopeOnly) msgs = msgs.filter((m) => matches(m, q));
    return msgs;
  }
  function matches(m, q) {
    if (String(m.text).toLowerCase().includes(q)) return true;
    if (trActive.has(m.id) && trCache[m.text] && trCache[m.text].toLowerCase().includes(q)) return true;
    return ref(m.from_id, m.from_name).name.toLowerCase().includes(q) || ref(m.to_id, m.to_name).name.toLowerCase().includes(q);
  }
  function delivery(m) {
    if (m.to_id === 'dashboard' || m.to_id === 'cli') return null; // virtual recipients never fetch or acknowledge
    if (m.acknowledged) return 'acknowledged';
    if (m.delivered) return 'delivered';
    if (m.failed_at) return 'failed';
    return 'sent';
  }
  function reactionGroups(m) {
    const entries = (state.data.reactions || {})[m.id] || [];
    const by = new Map();
    for (const r of entries) {
      if (!by.has(r.emoji)) by.set(r.emoji, { emoji: r.emoji, names: [], mine: false });
      const g = by.get(r.emoji);
      g.names.push(r.peer_id === 'dashboard' ? 'You' : (r.peer_name || r.peer_id));
      if (r.peer_id === 'dashboard') g.mine = true;
    }
    return [...by.values()];
  }

  function renderTimeline() {
    const d = state.data;
    if (!d) {
      if (!changed('timeline', state.loadError ? 'error' : 'loading')) return;
      nodes.clear();
      fill(colEl, state.loadError ? brokerUnreachable() : skeletonMessages());
      return;
    }
    const q = state.ui.search.trim();
    const msgs = visibleMessages(false);
    if (!msgs.length) {
      const sig = JSON.stringify(['empty', state.ui.selected, q, d.messages.length, d.peers.length]);
      updateSearchCount(q ? 0 : null);
      seenIds = snapshotIds(d); // a message arriving next is new, even if the view started out empty
      if (!changed('timeline', sig)) return;
      nodes.clear();
      fill(colEl, emptyTimeline(q));
      return;
    }
    sigs.delete('timeline');
    const items = [];
    if (d.messages.length >= MESSAGE_CAP && !state.ui.selected && !q) {
      items.push({ key: 'intro', sig: 'cap', build: () => h('div', { class: 'timeline-intro' }, icon('info'), 'Showing the latest ' + MESSAGE_CAP + ' messages of this session; older ones are not loaded.') });
    }
    let prev = null;
    const pinned = state.D.pinnedIds;
    for (const m of msgs) {
      const t = ms(m.sent_at);
      const gap = prev ? t - ms(prev.sent_at) : Infinity;
      const newDay = !prev || dayLabel(t) !== dayLabel(ms(prev.sent_at));
      if (newDay || gap > DIVIDER_GAP_MS) {
        const label = newDay ? dayLabel(t) : fmtHM.format(t);
        items.push({ key: 'div:' + m.id, sig: label, build: () => h('div', { class: 'divider', text: label }) });
      }
      const cont = !!prev && !newDay && gap <= MERGE_GAP_MS && prev.from_id === m.from_id && prev.to_id === m.to_id;
      const from = ref(m.from_id, m.from_name), to = ref(m.to_id, m.to_name);
      const dv = delivery(m);
      const reacts = reactionGroups(m);
      const tr = trActive.has(m.id) ? 'ar' : trLoading.has(m.id) ? 'loading' : '';
      const busy = pendingKeys().split(',').filter((k) => k === 'pin:' + m.id || k.startsWith('react:' + m.id + ':')).join(',');
      const sig = [m.id, m.text.length, m.msg_type || '', cont, from.name, from.live, to.name, to.live, dv, m.fail_reason || '',
        pinned.has(m.id), JSON.stringify(reacts), tr, q, busy].join('|');
      items.push({ key: 'm:' + m.id, sig, build: () => messageNode(m, { cont, from, to, dv, reacts, tr, q, pinned: pinned.has(m.id) }), msg: m });
      prev = m;
    }

    const nearBottom = timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 80;
    const firstRender = seenIds === null;
    if (firstRender) seenIds = new Set();
    let added = 0;
    const fresh = [];
    const keep = new Set();
    const desired = [];
    for (const it of items) {
      keep.add(it.key);
      let entry = nodes.get(it.key);
      if (!entry || entry.sig !== it.sig) {
        let el;
        try { el = it.build(); } catch (e) {
          // One message the renderer cannot handle must not take the conversation down with it.
          console.error('[claude-peers] could not render ' + it.key, e);
          el = it.msg ? plainMessage(it.msg) : h('div');
        }
        if (it.msg) {
          const before = lastDelivery.get(it.msg.id);
          const now = delivery(it.msg);
          if (entry && before && now && before !== now) markAdvance(el, before, now);
          lastDelivery.set(it.msg.id, now);
          if (!firstRender && !seenIds.has(it.msg.id)) { el.classList.add('enter'); added++; fresh.push(it.msg); }
        }
        if (entry && entry.el.parentNode === colEl) colEl.replaceChild(el, entry.el);
        entry = { sig: it.sig, el };
        nodes.set(it.key, entry);
      }
      desired.push(entry.el);
    }
    for (const key of [...nodes.keys()]) if (!keep.has(key)) nodes.delete(key);
    let cursor = colEl.firstChild;
    for (const el of desired) {
      if (cursor === el) { cursor = cursor.nextSibling; continue; }
      colEl.insertBefore(el, cursor);
    }
    while (cursor) { const next = cursor.nextSibling; colEl.removeChild(cursor); cursor = next; }
    seenIds = snapshotIds(d);

    updateSearchCount(q ? msgs.length : null);
    if (firstRender || stickToBottom || nearBottom) {
      timelineEl.scrollTop = timelineEl.scrollHeight;
      stickToBottom = false;
      unseen = 0;
    } else if (added) {
      unseen += added;
    }
    renderJump();
    announce(fresh.filter((m) => m.from_id !== 'dashboard'));
  }
  // The timeline itself is not a live region (rebuilt messages would be read out again); new messages are announced
  // here instead, batched so a burst becomes one announcement.
  const announcerEl = $('announcer');
  let announceQueue = [];
  let announceTimer = null;
  function announce(list) {
    if (!list.length || !announcerEl) return;
    announceQueue = announceQueue.concat(list);
    if (announceTimer) return;
    announceTimer = setTimeout(() => {
      const batch = announceQueue;
      announceQueue = [];
      announceTimer = null;
      const m = batch[batch.length - 1];
      const line = ref(m.from_id, m.from_name).name + ' to ' + ref(m.to_id, m.to_name).name + ': ' + excerpt(m.text, 140);
      announcerEl.textContent = batch.length === 1 ? 'New message from ' + line : batch.length + ' new messages. Latest from ' + line;
    }, ANNOUNCE_MS);
  }
  function plainMessage(m) {
    const from = ref(m.from_id, m.from_name), to = ref(m.to_id, m.to_name);
    return h('article', { class: 'msg start', 'data-msg-id': m.id, 'aria-label': from.name + ' to ' + to.name + ', ' + time(m.sent_at) },
      h('div', { class: 'msg-gutter' }),
      h('div', { class: 'msg-main' },
        h('div', { class: 'msg-head' }, h('span', { class: 'msg-from', text: from.name }), h('span', { class: 'msg-route' }, icon('arrow-right'), h('span', { class: 'sr-only', text: 'to' }), to.name), h('span', { class: 'msg-time', text: time(m.sent_at) })),
        h('div', { class: 'msg-body plain', text: String(m.text) })));
  }
  function markAdvance(el, from, to) {
    const order = ['sent', 'delivered', 'acknowledged'];
    const a = order.indexOf(from), b = order.indexOf(to);
    if (a < 0 || b <= a) return;
    for (let i = a + 1; i <= b; i++) { const dot = el.querySelector('.track .s' + (i + 1)); if (dot) dot.classList.add('grow'); }
  }
  function updateSearchCount(n) {
    setText($('search-count'), n === null || n === undefined ? '' : n === 0 ? 'No matches' : plural(n, 'match', 'matches'));
    $('search-clear').hidden = !state.ui.search;
  }
  function renderJump() {
    $('jump-new').hidden = unseen === 0;
    if (unseen) setText($('jump-label'), plural(unseen, 'new message'));
  }
  function skeletonMessages() {
    return [70, 45, 85].map((w) => h('div', { class: 'skel-msg', 'aria-hidden': 'true' },
      h('div', { class: 'skel', style: { width: '32px', height: '32px' } }),
      h('div', null, h('div', { class: 'skel', style: { width: '30%', height: '12px' } }), h('div', { class: 'skel', style: { width: w + '%', height: '12px', 'margin-top': '10px' } }), h('div', { class: 'skel', style: { width: (w - 20) + '%', height: '12px', 'margin-top': '8px' } }))));
  }
  function brokerUnreachable() {
    return h('div', { class: 'empty large' }, icon('offline'),
      h('div', { class: 'empty-title', text: "Can't reach the broker" }),
      h('div', { class: 'empty-body' }, 'The dashboard loads from the claude-peers broker at ', code(location.host || '127.0.0.1:7899'), '. It starts with any session that runs the claude-peers MCP server; ', code('bun cli.ts status'), ' shows whether it is up.'),
      h('button', { type: 'button', class: 'btn', 'data-action': 'retry' }, icon('refresh'), 'Try again'));
  }
  function emptyTimeline(q) {
    const sel = state.ui.selected, d = state.data;
    if (q) return h('div', { class: 'empty large' }, icon('search'), h('div', { class: 'empty-title', text: 'No messages match “' + q + '”' }),
      h('div', { class: 'empty-body', text: sel ? 'Only messages with ' + sel.name + ' are searched. Clear the search or show all traffic.' : 'Search covers message text and peer names.' }),
      h('button', { type: 'button', class: 'btn', 'data-action': 'clear-search' }, icon('x'), 'Clear search'));
    if (sel) return h('div', { class: 'empty large' }, icon('message'), h('div', { class: 'empty-title', text: 'No messages with ' + sel.name + ' yet' }),
      h('div', { class: 'empty-body', text: 'Anything sent to or from ' + sel.name + ' this session shows up here. The composer below is addressed to it.' }),
      h('button', { type: 'button', class: 'btn', 'data-action': 'clear-scope' }, 'Show all traffic'));
    return h('div', { class: 'empty large' }, icon('message'), h('div', { class: 'empty-title', text: 'No messages yet this session' }),
      h('div', { class: 'empty-body', text: d.peers.length ? 'Messages between peers, and the ones you send, appear here with their delivery state. Choose a recipient below to start.' : 'Once peers connect, their conversation appears here with its delivery state.' }));
  }

  const TRACK = {
    sent: { label: 'Sent', tip: (to) => 'Queued for ' + to + '; not fetched yet' },
    delivered: { label: 'Delivered', tip: (to) => 'Fetched by ' + to + "'s session; not acknowledged yet" },
    acknowledged: { label: 'Acknowledged', tip: (to) => to + ' acknowledged this message' },
  };
  function track(dv, to, reason) {
    if (dv === 'failed') return h('span', { class: 'track', 'data-state': 'failed', title: reason || 'The recipient went offline before reading it' }, icon('x-circle'), 'Not delivered');
    const t = TRACK[dv];
    return h('span', { class: 'track', 'data-state': dv, title: t.tip(to) },
      h('span', { class: 'track-steps', 'aria-hidden': 'true' }, h('span', { class: 'track-dot s1' }), h('span', { class: 'track-link l1' }), h('span', { class: 'track-dot s2' }), h('span', { class: 'track-link l2' }), h('span', { class: 'track-dot s3' })),
      h('span', { class: 'sr-only', text: 'Delivery: ' }), t.label);
  }
  function structuredBody(m) {
    let meta = null;
    try { meta = m.metadata ? JSON.parse(m.metadata) : null; } catch (e) { meta = null; }
    const fields = KIND_FIELDS[m.msg_type];
    if (!meta || !fields) return null;
    const rows = [];
    for (const [key, label] of fields) {
      const v = meta[key];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      let dd;
      if (Array.isArray(v)) dd = PATH_FIELDS.has(key) ? h('div', { class: 'chips' }, v.map((x) => h('span', { class: 'chip-mono', text: String(x) }))) : h('ul', null, v.map((x) => { const li = h('li'); inline(li, String(x)); return li; }));
      else if (key === 'file_path') dd = h('span', { class: 'chip-mono', text: String(v) });
      else { dd = h('span'); inline(dd, String(v)); }
      rows.push(h('dt', { text: label }), h('dd', null, dd));
    }
    return rows.length ? h('dl', { class: 'struct' }, rows) : null;
  }
  function contextSnapshot(m) {
    if (!m.context_snapshot) return null;
    let ctx;
    try { ctx = JSON.parse(m.context_snapshot); } catch (e) { return null; }
    if (!ctx || typeof ctx !== 'object') return null;
    const files = Array.isArray(ctx.recent_files) ? ctx.recent_files : [];
    const rows = [];
    if (ctx.branch) rows.push(h('dt', { text: 'Branch' }), h('dd', null, h('span', { class: 'chip-mono', text: ctx.branch })));
    if (files.length) rows.push(h('dt', { text: 'Recent files' }), h('dd', null, h('div', { class: 'chips' }, files.map((f) => h('span', { class: 'chip-mono', text: String(f) })))));
    if (ctx.summary) rows.push(h('dt', { text: 'Working on' }), h('dd', { text: ctx.summary }));
    if (ctx.cwd) rows.push(h('dt', { text: 'Directory' }), h('dd', null, h('span', { class: 'mono', style: { 'font-size': '12px' }, text: ctx.cwd })));
    if (!rows.length) return null;
    const hint = [ctx.branch, files.length ? plural(files.length, 'file') : ''].filter(Boolean).join(' · ');
    return h('details', { class: 'ctx' }, h('summary', null, icon('chevron-right', 'chev'), 'Sender context', hint ? h('span', { text: '· ' + hint }) : null), h('dl', { class: 'ctx-body' }, rows));
  }
  function messageNode(m, o) {
    const headId = 'mh-' + m.id;
    let body;
    if (o.tr === 'ar' && trCache[m.text]) {
      body = markdown(trCache[m.text]);
      body.setAttribute('dir', 'rtl');
      body.setAttribute('lang', 'ar');
    } else {
      body = (m.msg_type && structuredBody(m)) || markdown(m.text);
    }
    body.classList.add('msg-body');
    if (o.q) highlight(body, o.q);

    const nameBtn = (r) => (r.kind === 'peer' && r.live
      ? h('button', { type: 'button', class: 'who-btn', 'data-action': 'select-peer', 'data-id': r.id, title: 'Show messages with ' + r.name }, nameSpan(r))
      : nameSpan(r));
    const head = o.cont ? null : h('div', { class: 'msg-head', id: headId },
      h('span', { class: 'msg-from' }, nameBtn(o.from)),
      h('span', { class: 'msg-route' }, icon('arrow-right'), h('span', { class: 'sr-only', text: 'to' }), nameBtn(o.to)),
      h('time', { class: 'msg-time', datetime: m.sent_at, title: full(m.sent_at) }, time(m.sent_at)),
      m.msg_type && KINDS[m.msg_type] ? h('span', { class: 'kind', 'data-kind': m.msg_type }, icon(KINDS[m.msg_type].icon), KINDS[m.msg_type].label) : null,
      o.dv ? h('span', { class: 'msg-state' }, track(o.dv, o.to.name, m.fail_reason)) : null);
    // A continuation still shows its own delivery state.
    const contState = o.cont && o.dv ? h('div', { class: 'msg-head' }, h('span', { class: 'msg-state', style: { 'margin-left': '0' } }, track(o.dv, o.to.name, m.fail_reason))) : null;

    // Toggle buttons keep one name and report their state with aria-pressed.
    const actions = h('div', { class: 'msg-actions', role: 'toolbar', 'aria-label': 'Message actions' },
      h('button', { type: 'button', class: 'icon-btn', 'data-action': 'pin', 'data-id': m.id, 'aria-pressed': String(o.pinned), 'aria-label': 'Pin message', 'data-tip': o.pinned ? 'Unpin' : 'Pin', 'aria-disabled': isPending('pin:' + m.id) ? 'true' : null }, icon('pin')),
      o.from.kind === 'peer' ? h('button', {
        type: 'button', class: 'icon-btn' + (o.tr === 'ar' ? ' on' : ''), 'data-action': 'translate', 'data-id': m.id, 'aria-pressed': String(o.tr === 'ar'),
        'aria-disabled': o.tr === 'loading' ? 'true' : null, 'aria-busy': o.tr === 'loading' ? 'true' : null,
        'aria-label': 'Translate to Arabic', 'data-tip': o.tr === 'ar' ? 'Show original' : o.tr === 'loading' ? 'Translating…' : 'Translate to Arabic (Google)',
      }, o.tr === 'loading' ? icon('loader', 'spin') : icon('translate')) : null,
      h('button', { type: 'button', class: 'icon-btn', 'data-action': 'copy-text', 'data-id': m.id, 'aria-label': 'Copy message text', 'data-tip': 'Copy text' }, icon('copy')));

    const reason = m.fail_reason ? m.fail_reason.charAt(0).toUpperCase() + m.fail_reason.slice(1) : 'The recipient went offline';
    const failed = o.dv === 'failed' ? h('div', { class: 'msg-fail' }, icon('alert'), h('span', null, h('strong', { text: 'Not delivered. ' }), reason + '. Send it again once ' + o.to.name + ' reconnects.')) : null;
    const trNote = o.tr === 'ar' ? h('div', { class: 'msg-note' }, icon('translate'), 'Translated to Arabic · ', h('button', { type: 'button', class: 'linkish', 'data-action': 'show-original', 'data-id': m.id }, 'Show original')) : null;
    const reacts = o.reacts.length ? h('div', { class: 'reactions' }, o.reacts.map((g) => h('button', {
      type: 'button', class: 'reaction', 'data-action': 'react', 'data-id': m.id, 'data-value': g.emoji, 'aria-pressed': String(g.mine),
      'aria-label': g.emoji + ' from ' + g.names.join(', ') + (g.mine ? '. Remove yours' : '. Add yours'),
      title: g.names.join(', '), 'aria-disabled': isPending('react:' + m.id + ':' + g.emoji) ? 'true' : null,
    }, h('span', { 'aria-hidden': 'true', text: g.emoji }), g.names.length > 1 ? h('span', { class: 'n', 'aria-hidden': 'true', text: String(g.names.length) }) : null))) : null;

    return h('article', {
      class: 'msg' + (o.cont ? ' cont' : ' start') + (revealedId === m.id ? ' show-actions' : ''), 'data-msg-id': m.id, 'aria-labelledby': o.cont ? null : headId,
      'aria-label': o.cont ? o.from.name + ' to ' + o.to.name + ', ' + time(m.sent_at) : null,
    },
      h('div', { class: 'msg-gutter' }, o.cont ? h('span', { class: 'msg-gutter-time', 'aria-hidden': 'true', text: time(m.sent_at) }) : tile(o.from)),
      h('div', { class: 'msg-main' }, head, contState, body, failed, contextSnapshot(m), trNote, reacts),
      actions);
  }

  /* ═══ View: composer ═══ */
  const textarea = $('composer-text');
  const recipientSel = $('recipient');

  function recipientState() {
    const r = state.ui.recipient;
    if (!r) return { status: 'none' };
    const live = state.D && state.D.peerById.get(r.id);
    return live ? { status: 'ok', peer: live } : { status: 'offline' };
  }
  function renderComposer() {
    const D = state.D, ui = state.ui;
    const rs = recipientState();
    // Options only rebuild when peers or the target change, so an open dropdown is not disturbed by unrelated updates.
    const optSig = JSON.stringify([D ? D.peers.map((p) => [p.id, p.name, p.group_id]) : null, D ? D.groups.map((g) => [g.id, g.name]) : null, ui.recipient, rs.status]);
    if (changed('recipient-options', optSig)) {
      const opts = [h('option', { value: '', disabled: true, text: D && D.peers.length ? 'Choose a recipient' : 'No peers connected' })];
      if (D) {
        const lobby = D.peers.filter((p) => !p.group_id || !D.groupById.has(p.group_id));
        if (lobby.length) opts.push(h('optgroup', { label: 'Lobby' }, lobby.map((p) => h('option', { value: p.id, text: p.name || p.id }))));
        for (const g of D.groups) {
          const members = D.peers.filter((p) => p.group_id === g.id);
          if (members.length) opts.push(h('optgroup', { label: g.name }, members.map((p) => h('option', { value: p.id, text: p.name || p.id }))));
        }
      }
      if (rs.status === 'offline') opts.push(h('option', { value: ui.recipient.id, disabled: true, text: ui.recipient.name + ' (offline)' }));
      fill(recipientSel, opts);
      recipientSel.value = ui.recipient ? ui.recipient.id : '';
      const wrap = $('recipient-wrap');
      const tileEl = $('recipient-tile');
      if (rs.status === 'ok') {
        const r = ref(rs.peer.id);
        tileEl.className = 'tile sm hue';
        tileEl.style.setProperty('--h', String(hueOf(r.name)));
        tileEl.textContent = initials(r.name);
        wrap.removeAttribute('data-empty');
      } else {
        tileEl.className = 'tile sm';
        tileEl.style.removeProperty('--h');
        tileEl.textContent = '';
        wrap.setAttribute('data-empty', '');
      }
      textarea.placeholder = rs.status === 'ok' ? 'Message ' + rs.peer.name + '…' : D && D.peers.length ? 'Choose a recipient, then write your message…' : 'Waiting for peers to connect…';
    }

    // Typing indicator for the peers in view
    const typingSet = typingNow();
    const typingNames = D ? D.peers.filter((p) => typingSet.has(p.id) && (!ui.selected || ui.selected.id === p.id)).map((p) => p.name) : [];
    if (changed('typing', typingNames.join(','))) {
      const t = $('typing');
      if (!typingNames.length) t.replaceChildren();
      else fill(t, [h('span', { class: 'dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
        typingNames.length === 1 ? typingNames[0] + ' is typing' : typingNames.length === 2 ? typingNames[0] + ' and ' + typingNames[1] + ' are typing' : typingNames.length + ' peers are typing']);
    }

    // Alert: a send failure first, then an unreachable recipient
    const alertEl = $('composer-alert');
    const alert = state.sendError ? { tone: 'bad', text: state.sendError, dismiss: true }
      : state.conn === 'offline' && D ? { tone: 'warn', text: "The broker is unreachable, so sending will fail until it's back. Your draft stays here." }
        : rs.status === 'offline' ? { tone: 'warn', text: ui.recipient.name + ' is offline, so messages to it would be refused. Choose another recipient, or wait for it to reconnect.' }
          : null;
    if (changed('composer-alert', JSON.stringify(alert))) {
      if (!alert) { alertEl.hidden = true; alertEl.replaceChildren(); }
      else {
        alertEl.hidden = false;
        alertEl.dataset.tone = alert.tone;
        alertEl.setAttribute('role', alert.tone === 'bad' ? 'alert' : 'status');
        fill(alertEl, [icon('alert'), h('div', { class: 'grow', text: alert.text }),
          alert.dismiss ? h('button', { type: 'button', class: 'icon-btn', 'data-action': 'dismiss-send-error', 'aria-label': 'Dismiss' }, icon('x')) : null]);
      }
    }

    const text = textarea.value;
    const len = text.length;
    const over = len > MAX_MESSAGE;
    const btn = $('send-btn');
    btn.disabled = state.sending || rs.status !== 'ok' || !text.trim() || over;
    btn.setAttribute('aria-busy', String(state.sending));
    const spinning = !!btn.querySelector('.spin');
    if (state.sending && !spinning) fill(btn, icon('loader', 'spin'));
    else if (!state.sending && spinning) fill(btn, icon('send'));
    btn.setAttribute('aria-label', state.sending ? 'Sending…' : rs.status === 'ok' ? 'Send to ' + rs.peer.name : 'Send message');

    const counter = $('char-count');
    if (len > WARN_MESSAGE) {
      counter.textContent = len.toLocaleString() + ' / ' + MAX_MESSAGE.toLocaleString();
      counter.dataset.tone = over ? 'bad' : 'warn';
    } else { counter.textContent = ''; delete counter.dataset.tone; }

    const status = $('composer-status');
    const st = state.sendStatus;
    setText(status, st ? st.text : '');
    if (st && st.tone) status.dataset.tone = st.tone; else delete status.dataset.tone;
    $('composer-box').toggleAttribute('data-disabled', !D || !D.peers.length);
  }
  function autosize() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
  }
  let statusTimer = null;
  function setSendStatus(text, tone, clearAfter) {
    state.sendStatus = text ? { text, tone } : null;
    clearTimeout(statusTimer);
    if (clearAfter) statusTimer = setTimeout(() => { state.sendStatus = null; render(); }, clearAfter);
    render();
  }
  async function send() {
    if (state.sending) return; // one submission at a time
    const text = textarea.value.trim();
    const rs = recipientState();
    if (rs.status !== 'ok') {
      state.sendError = rs.status === 'offline' ? state.ui.recipient.name + ' is offline. Choose another recipient.' : 'Choose who should receive this message.';
      render();
      recipientSel.focus();
      return;
    }
    if (!text) return;
    if (text.length > MAX_MESSAGE) {
      state.sendError = 'This message is ' + text.length.toLocaleString() + ' characters. The broker accepts up to ' + MAX_MESSAGE.toLocaleString() + '.';
      render();
      return;
    }
    const to = rs.peer;
    state.sending = true;
    state.sendError = '';
    setSendStatus('Sending to ' + to.name + '…', null, 0);
    const r = await api('/send-message', { from_id: 'dashboard', to_id: to.id, text }, SEND_TIMEOUT_MS);
    state.sending = false;
    if (r.ok) {
      // Only clear the draft if it is still the text that was sent.
      if (textarea.value.trim() === text) { textarea.value = ''; autosize(); }
      stickToBottom = true;
      setSendStatus('Sent to ' + to.name + '. Its delivery state shows on the message.', 'ok', 4000);
      if (state.conn !== 'live') refresh();
    } else if (r.timedOut) {
      // The broker may have stored it before going quiet: resending blindly could deliver it twice.
      state.sendError = 'The broker did not answer within ' + SEND_TIMEOUT_MS / 1000 + ' seconds, so the message may have been sent. Check the conversation before sending it again; your draft is still here.';
      setSendStatus('', null, 0);
    } else {
      state.sendError = "Couldn't send to " + to.name + ': ' + r.error + ' Your message is still here.';
      setSendStatus('', null, 0);
    }
    // A clicked Send button disables while sending and drops focus; continue in the draft instead.
    const a = document.activeElement;
    if (!a || a === document.body || a.id === 'send-btn') textarea.focus({ preventScroll: true });
    render();
  }
  function setRecipient(peer) {
    state.ui.recipient = peer ? target(peer) : null;
    state.sendError = '';
    render();
  }

  /* ═══ View: peer details (context column / drawer) ═══ */
  const contextEl = $('context');
  function renderContext() {
    const sel = state.ui.selected, d = state.data, D = state.D;
    const p = sel && D ? D.peerById.get(sel.id) : null;
    const ids = sel ? sel.ids || [sel.id] : [];
    const sig = sel && d ? JSON.stringify([sel, p ? peerSig(p) : null, d.tasks.filter((t) => ids.includes(t.assignee_id) || ids.includes(t.creator_id)), d.active_files, d.verifications, d.approvals, d.proposals, d.audit,
      D.groups.map((g) => [g.id, g.name]), d.messages.length, pendingKeys(), state.ui.groupDraft, peerNamesSig(), bucket()]) : 'none';
    if (!changed('context', sig)) return;
    if (!sel || !d) { contextEl.replaceChildren(); delete contextEl.dataset.for; return; }
    // Live updates keep the reader's place in the details; another peer starts at the top.
    const key = String(sel.ids ? sel.ids[0] : sel.id);
    keepFocus(contextEl, () => fill(contextEl, contextContent(sel, p)), contextEl.dataset.for === key ? '.ctx-scroll' : null);
    contextEl.dataset.for = key;
  }
  function contextContent(sel, p) {
    const d = state.data, D = state.D;
    const r = ref(sel.id, sel.name);
    const group = p && p.group_id ? D.groupById.get(p.group_id) : null;
    const head = h('div', { class: 'ctx-head' },
      h('span', { class: 'avatar' }, tile(r), p ? presence(p.status) : null),
      h('div', { style: { 'min-width': '0' } },
        h('h2', { class: 'ctx-name' }, nameSpan(r)),
        h('div', { class: 'ctx-status' }, p ? STATUS_LABEL[p.status || 'online'] + ' · ' + (group ? groupLabel(group.name) : 'Lobby') : 'Disconnected')),
      h('div', { style: { display: 'flex' } },
        p ? h('button', { type: 'button', class: 'icon-btn', 'data-action': 'copy-id', 'data-id': p.id, 'aria-label': 'Copy peer ID ' + p.id, 'data-tip': 'Copy peer ID' }, icon('copy')) : null,
        h('button', { type: 'button', class: 'icon-btn', 'data-action': 'close-details', 'aria-label': 'Close details', 'data-tip': 'Close details' }, icon('x'))));
    if (!p) {
      return [head, h('div', { class: 'ctx-scroll' }, h('div', { class: 'ctx-section' },
        h('p', { class: 'ctx-summary', text: sel.name + ' is no longer connected. Its messages stay in the conversation; if the same session reconnects, the dashboard follows it.' }),
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn', 'data-action': 'clear-scope' }, 'Show all traffic'))))];
    }
    const sections = [];
    sections.push(h('section', { class: 'ctx-section', 'aria-label': 'Summary' },
      p.summary ? h('p', { class: 'ctx-summary', text: p.summary }) : h('p', { class: 'ctx-summary', style: { color: 'var(--ink-3)' }, text: 'No summary yet. Peers describe their work with set_summary.' })));

    const facts = [h('dt', { text: 'Directory' }), h('dd', { class: 'mono', style: { 'font-size': '12px' }, text: p.cwd || '—' })];
    if (p.git_root && p.git_root !== p.cwd) facts.push(h('dt', { text: 'Repository' }), h('dd', { class: 'mono', style: { 'font-size': '12px' }, text: p.git_root }));
    if (p.git_branch) facts.push(h('dt', { text: 'Branch' }), h('dd', null, h('span', { class: 'chip-mono', text: p.git_branch })));
    facts.push(h('dt', { text: 'Connected' }), h('dd', { title: full(p.registered_at), text: time(p.registered_at) + ' · ' + ago(ms(p.registered_at)) }));
    // Everything below counts the ids this peer had before a reconnect too, like the conversation scope does.
    const ids = sel.ids || [sel.id];
    const mine = (id) => ids.includes(id);
    const sent = d.messages.filter((m) => isSelf(m.from_id, m.from_name, sel)).length;
    const received = d.messages.filter((m) => isSelf(m.to_id, m.to_name, sel)).length;
    facts.push(h('dt', { text: 'Messages' }), h('dd', { text: sent + ' sent · ' + received + ' received' }));
    facts.push(h('dt', { text: 'Peer ID' }), h('dd', { class: 'mono', style: { 'font-size': '12px' }, text: p.id }));
    sections.push(h('section', { class: 'ctx-section', 'aria-label': 'Workspace' }, h('h3', null, icon('folder'), 'Workspace'), h('dl', { class: 'facts' }, facts)));

    // Choosing a group only stages it; Move sends it. (Arrow keys on a closed select fire change on some platforms,
    // which would otherwise move the peer through every group on the way.)
    const busy = isPending('assign:' + p.id);
    const current = group ? group.id : '';
    const draft = state.ui.groupDraft && state.ui.groupDraft.peer === p.id ? state.ui.groupDraft.group : current;
    const select = h('select', { id: 'ctx-group', 'data-id': p.id, 'aria-describedby': 'ctx-group-hint' },
      h('option', { value: '', text: 'Lobby' }), D.groups.map((g) => h('option', { value: g.id, text: g.name })));
    select.value = draft;
    const moveOff = busy || draft === current;
    sections.push(h('section', { class: 'ctx-section', 'aria-label': 'Group' },
      h('h3', null, icon('groups'), h('label', { for: 'ctx-group', text: 'Group' })),
      h('div', { class: 'form-row' },
        h('div', { class: 'select' }, select, icon('chevron-down')),
        h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'assign', 'data-id': p.id, 'aria-disabled': moveOff ? 'true' : null, 'aria-busy': busy ? 'true' : null },
          busy ? icon('loader', 'spin') : null, 'Move')),
      h('div', { class: 'field-hint', id: 'ctx-group-hint', text: 'Peers only message peers in the same group. Moving renumbers default names (claude-N).' })));

    const fileEntry = d.active_files.find((a) => a.peer_id === p.id);
    if (fileEntry && fileEntry.files.length) {
      sections.push(h('section', { class: 'ctx-section', 'aria-label': 'Active files' }, h('h3', null, icon('files'), 'Active files', h('span', { class: 'count', text: String(fileEntry.files.length) })),
        fileEntry.files.map((f) => { const o = D.owners.get(String(f).replace(/\\/g, '/').toLowerCase()); return fileRow(f, o ? o.owners : [{ id: p.id, name: p.name }], !!o && o.owners.length > 1); })));
    }
    const tasks = d.tasks.filter((t) => mine(t.assignee_id) || mine(t.creator_id));
    if (tasks.length) {
      const sorted = tasks.slice().sort((a, b) => (a.status === 'completed') - (b.status === 'completed'));
      sections.push(h('section', { class: 'ctx-section', 'aria-label': 'Tasks' }, h('h3', null, icon('tasks'), 'Tasks', h('span', { class: 'count', text: tasks.filter((t) => t.status !== 'completed').length + ' open' })), sorted.map(taskRow)));
    }
    const reviews = [];
    for (const v of d.verifications) if (mine(v.requester_id) || mine(v.verifier_id)) reviews.push(verificationRow(v));
    for (const a of d.approvals) if (mine(a.requester_id) || mine(a.approver_id)) reviews.push(approvalRow(a));
    if (reviews.length) sections.push(h('section', { class: 'ctx-section', 'aria-label': 'Reviews' }, h('h3', null, icon('verifications'), 'Verifications and approvals', h('span', { class: 'count', text: String(reviews.length) })), reviews));
    const props = d.proposals.filter((x) => mine(x.author_id) || (x.votes || []).some((v) => mine(v.voter_id)));
    if (props.length) sections.push(h('section', { class: 'ctx-section', 'aria-label': 'Proposals' }, h('h3', null, icon('proposals'), 'Proposals', h('span', { class: 'count', text: String(props.length) })), props.map(proposalRow)));
    const events = d.audit.filter((a) => mine(a.actor_id));
    if (events.length) sections.push(h('section', { class: 'ctx-section', 'aria-label': 'Recent events' }, h('h3', null, icon('activity'), 'Recent events'), events.map(eventRow)));
    return [head, h('div', { class: 'ctx-scroll' }, sections)];
  }

  /* ═══ Selection, navigation ═══ */
  function selectPeer(id) {
    const p = state.D && state.D.peerById.get(id);
    if (!p) return;
    const ui = state.ui;
    if (ui.selected && ui.selected.id === id) { clearScope(); return; }
    ui.selected = target(p);
    ui.groupDraft = null;
    setRecipient(p);
    ui.ctxOpen = !mqContextDrawer.matches; // the docked column opens with the selection; the drawer waits for "Details"
    stickToBottom = true;
    unseen = 0;
    if (mqMobile.matches) ui.navOpen = false;
    if (mqPanelOverlay.matches) ui.panelOverlayOpen = false;
    render();
  }
  function clearScope() {
    state.ui.selected = null;
    state.ui.ctxOpen = false;
    stickToBottom = true;
    unseen = 0;
    render();
  }
  function setSection(s, opts) {
    if (!SECTIONS[s]) return;
    const ui = state.ui;
    if (opts && opts.toggle && s === ui.section && panelOpen() && !mqMobile.matches) { setPanelOpen(false); return; }
    ui.section = s;
    save('cp.section', s);
    if (!panelOpen()) setPanelOpen(true);
    if (mqMobile.matches) ui.navOpen = true;
    render();
  }
  function setPanelOpen(open) {
    if (mqPanelOverlay.matches) state.ui.panelOverlayOpen = open;
    else { state.ui.panelDocked = open; save('sidebar-state', open ? 'expanded' : 'collapsed'); }
    render();
  }
  function setPanelWidth(w) {
    state.ui.panelWidth = clampWidth(w);
    root.style.setProperty('--panel-pref', state.ui.panelWidth + 'px');
    $('panel-resizer').setAttribute('aria-valuenow', String(state.ui.panelWidth));
  }
  function jumpTo(id) {
    const msg = state.data && state.data.messages.find((m) => m.id === id);
    if (!msg) { toast('That message is no longer in the loaded history.', 'warn'); return; }
    if (state.ui.search && !matches(msg, state.ui.search.trim().toLowerCase())) { state.ui.search = ''; $('search-input').value = ''; }
    if (state.ui.selected && !involves(msg, state.ui.selected)) { state.ui.selected = null; state.ui.ctxOpen = false; }
    renderAll();
    const el = colEl.querySelector(attrSel('data-msg-id', id));
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
  function closeOverlays() {
    const ui = state.ui;
    if (mqMobile.matches && ui.navOpen) { ui.navOpen = false; render(); $('nav-toggle').focus(); return true; }
    if (mqContextDrawer.matches && ui.ctxOpen && ui.selected) { ui.ctxOpen = false; render(); return true; }
    if (mqPanelOverlay.matches && ui.panelOverlayOpen) {
      ui.panelOverlayOpen = false;
      render();
      const tab = document.querySelector('.rail-tab[aria-selected="true"]');
      if (tab) tab.focus();
      return true;
    }
    return false;
  }

  /* ═══ Actions (one delegated click listener) ═══ */
  async function copyText(text, what) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy failed');
      }
      toast(what + ' copied.', 'ok');
    } catch (e) {
      toast("Couldn't copy to the clipboard; the browser blocked it.", 'bad');
    }
  }
  const messageById = (id) => state.data && state.data.messages.find((m) => m.id === id);
  function setPinned(id, pinned) {
    run('pin:' + id, () => api('/pin-message', { message_id: id, pinned }), { fail: pinned ? "Couldn't pin the message." : "Couldn't unpin the message." });
  }
  async function toggleTranslation(id) {
    const m = messageById(id);
    if (!m) return;
    if (trActive.has(id)) { trActive.delete(id); render(); return; }
    if (trLoading.has(id)) return;
    trLoading.add(id);
    trFails = 0;
    trDead = false;
    render();
    try {
      const out = await translateText(m.text);
      if (out && out !== m.text && /[\u0600-\u06FF]/.test(out)) trActive.add(id);
      else toast("Couldn't translate this message right now; the translation service did not answer.", 'warn');
    } catch (e) {
      toast("Couldn't translate this message right now.", 'warn');
    } finally {
      trLoading.delete(id);
      render();
    }
  }

  const ACTIONS = {
    'select-peer': (el) => selectPeer(el.getAttribute('data-id')),
    'clear-scope': () => clearScope(),
    'toggle-details': () => { state.ui.ctxOpen = !state.ui.ctxOpen; render(); if (state.ui.ctxOpen) queueMicrotask(() => contextEl.focus({ preventScroll: true })); },
    'close-details': () => { state.ui.ctxOpen = false; render(); queueMicrotask(() => { const t = document.querySelector('[data-action="toggle-details"]'); if (t) t.focus(); }); },
    'copy-id': (el) => copyText(el.getAttribute('data-id'), 'Peer ID'),
    'copy-text': (el) => { const m = messageById(Number(el.getAttribute('data-id'))); if (m) copyText(m.text, 'Message'); },
    'copy-code': (el) => { const box = el.closest('.code'); const pre = box && box.querySelector('pre'); if (pre) copyText(pre.textContent, 'Code'); },
    'pin': (el) => setPinned(Number(el.getAttribute('data-id')), el.getAttribute('aria-pressed') !== 'true'),
    'unpin': (el) => setPinned(Number(el.getAttribute('data-id')), false),
    'translate': (el) => toggleTranslation(Number(el.getAttribute('data-id'))),
    'show-original': (el) => {
      const id = Number(el.getAttribute('data-id'));
      toggleTranslation(id);
      // The note (and this button) goes away with the translation; continue on the message's translate toggle.
      queueMicrotask(() => { const b = colEl.querySelector(attrSel('data-msg-id', id) + ' [data-action="translate"]'); if (b) b.focus({ preventScroll: true }); });
    },
    'react': (el) => {
      const id = Number(el.getAttribute('data-id'));
      const emoji = el.getAttribute('data-value');
      const mine = el.getAttribute('aria-pressed') === 'true';
      const body = { message_id: id, peer_id: 'dashboard', emoji };
      if (mine) body.remove = true;
      run('react:' + id + ':' + emoji, () => api('/react', body), { fail: "Couldn't update your reaction." });
    },
    'jump-to': (el) => jumpTo(Number(el.getAttribute('data-id'))),
    'toggle-pins': () => { state.ui.pinsOpen = !state.ui.pinsOpen; render(); },
    'task-filter': (el) => { state.ui.taskFilter = el.getAttribute('data-value'); render(); },
    'decision-filter': (el) => { state.ui.decisionFilter = el.getAttribute('data-value'); render(); },
    'complete-task': (el) => {
      const id = el.getAttribute('data-id');
      const t = state.data.tasks.find((x) => x.id === id);
      run('task:' + id, () => api('/complete-task', { task_id: id, peer_id: 'dashboard', result: '' }), { ok: t ? 'Marked “' + t.title + '” complete.' : 'Task completed.', fail: "Couldn't complete the task." });
    },
    'vote': (el) => {
      const id = el.getAttribute('data-id');
      const vote = el.getAttribute('data-value');
      run('vote:' + id, () => api('/vote-proposal', { proposal_id: id, voter_id: 'dashboard', vote, reason: '' }), { ok: vote === 'approve' ? 'You voted to approve.' : 'You voted to reject.', fail: "Couldn't record your vote." });
    },
    'delete-group': (el) => { state.ui.confirmGroup = el.getAttribute('data-id'); render(); queueMicrotask(() => { const b = document.querySelector('[data-action="cancel-delete-group"]'); if (b) b.focus(); }); },
    'cancel-delete-group': () => {
      const id = state.ui.confirmGroup;
      state.ui.confirmGroup = null;
      render();
      queueMicrotask(() => { const b = document.querySelector(attrSel('data-action', 'delete-group') + attrSel('data-id', id)); if (b) b.focus(); });
    },
    'confirm-delete-group': async (el) => {
      const id = el.getAttribute('data-id');
      const g = state.D.groupById.get(id);
      const r = await run('group-delete:' + id, () => api('/delete-group', { group_id: id }), { ok: 'Group “' + (g ? g.name : id) + '” deleted.', fail: "Couldn't delete the group." });
      if (r && r.ok) { state.ui.confirmGroup = null; render(); }
    },
    'assign': (el) => {
      const peerId = el.getAttribute('data-id');
      const draft = state.ui.groupDraft;
      const p = state.D && state.D.peerById.get(peerId);
      const current = p && p.group_id && state.D.groupById.has(p.group_id) ? p.group_id : '';
      if (!draft || draft.peer !== peerId || !p || draft.group === current) return;
      const groupId = draft.group || null;
      const g = groupId && state.D.groupById.get(groupId);
      // The draft stays until a snapshot shows the move (see ingest), so the select does not jump back meanwhile.
      run('assign:' + peerId, () => api('/assign-group', { peer_id: peerId, group_id: groupId }), { ok: 'Moved ' + p.name + ' to ' + (g ? g.name : 'the Lobby') + '.', fail: "Couldn't move " + p.name + '.' });
    },
    'retry': () => reconnectNow(),
    'dismiss-toast': (el) => { const t = el.closest('.toast'); if (t) t.remove(); },
    'dismiss-send-error': () => { state.sendError = ''; render(); textarea.focus(); },
    'clear-search': () => { setSearch(''); $('search-input').focus(); },
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-action]');
    // Busy controls are aria-disabled rather than disabled, so they keep keyboard focus; they still do nothing.
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.tagName === 'SELECT') return;
    const fn = ACTIONS[el.getAttribute('data-action')];
    if (fn) { e.preventDefault(); fn(el, e); }
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || el.id !== 'ctx-group') return;
    state.ui.groupDraft = { peer: el.getAttribute('data-id'), group: el.value };
    render();
  });
  // Touch has no hover: a tap on a message (not on one of its controls) reveals its actions.
  const mqTouch = window.matchMedia('(hover: none)');
  colEl.addEventListener('click', (e) => {
    if (!mqTouch.matches || !e.target.closest) return;
    if (e.target.closest('a, button, summary, input, select, textarea')) return;
    const article = e.target.closest('article.msg');
    if (!article) return;
    const id = Number(article.getAttribute('data-msg-id'));
    revealedId = revealedId === id ? null : id;
    for (const el of colEl.querySelectorAll('.msg.show-actions')) el.classList.remove('show-actions');
    if (revealedId !== null) article.classList.add('show-actions');
  });

  /* ═══ Static controls ═══ */
  $('rail-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.rail-tab');
    if (tab) setSection(tab.dataset.section, { toggle: true });
  });
  $('rail-tabs').addEventListener('keydown', (e) => {
    const tabs = [...document.querySelectorAll('.rail-tab')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    tabs[next].focus();
    setSection(tabs[next].dataset.section);
  });
  $('panel-toggle').addEventListener('click', () => setPanelOpen(!panelOpen()));
  $('nav-toggle').addEventListener('click', () => {
    state.ui.navOpen = !state.ui.navOpen;
    render();
    if (state.ui.navOpen) queueMicrotask(() => { const t = document.querySelector('.rail-tab[aria-selected="true"]'); if (t) t.focus(); });
  });
  scrimEl.addEventListener('click', () => closeOverlays());
  $('conn-retry').addEventListener('click', () => reconnectNow());
  $('theme-btn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    save('theme', next);
    render();
  });
  $('export-btn').addEventListener('click', exportConversation);
  $('palette-btn').addEventListener('click', openPalette);
  $('jump-new').addEventListener('click', () => { unseen = 0; timelineEl.scrollTo({ top: timelineEl.scrollHeight, behavior: 'smooth' }); renderJump(); });
  timelineEl.addEventListener('scroll', () => {
    if (unseen && timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 80) { unseen = 0; renderJump(); }
    if (tipFor) hideTip();
  }, { passive: true });

  // Search
  const searchInput = $('search-input');
  let searchTimer = null;
  function setSearch(v) {
    clearTimeout(searchTimer);
    state.ui.search = v;
    if (searchInput.value !== v) searchInput.value = v;
    stickToBottom = true;
    render();
  }
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => setSearch(searchInput.value), 120); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape' && searchInput.value) { e.stopPropagation(); setSearch(''); } });
  $('search-clear').addEventListener('click', () => { setSearch(''); searchInput.focus(); });

  // Composer
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  textarea.addEventListener('input', () => { autosize(); if (state.sendError) state.sendError = ''; render(); });
  recipientSel.addEventListener('change', () => {
    const p = state.D && state.D.peerById.get(recipientSel.value);
    setRecipient(p || null);
  });

  // Panel resize (pointer and keyboard)
  const resizer = $('panel-resizer');
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    root.classList.add('resizing');
    const startX = e.clientX, startW = state.ui.panelWidth;
    const move = (ev) => setPanelWidth(startW + ev.clientX - startX);
    const up = () => {
      root.classList.remove('resizing');
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      resizer.removeEventListener('pointercancel', up);
      save('cp.panel-width', state.ui.panelWidth);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
    resizer.addEventListener('pointercancel', up);
  });
  resizer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    let w = null;
    if (e.key === 'ArrowLeft') w = state.ui.panelWidth - step;
    else if (e.key === 'ArrowRight') w = state.ui.panelWidth + step;
    else if (e.key === 'Home') w = PANEL_MIN;
    else if (e.key === 'End') w = PANEL_MAX;
    else if (e.key === 'Enter') w = PANEL_DEFAULT;
    if (w === null) return;
    e.preventDefault();
    setPanelWidth(w);
    save('cp.panel-width', state.ui.panelWidth);
  });
  resizer.addEventListener('dblclick', () => { setPanelWidth(PANEL_DEFAULT); save('cp.panel-width', PANEL_DEFAULT); });

  // Tooltips (pointer hover and keyboard focus; not on touch)
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t === tipFor) return;
    if (t) showTip(t); else hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t === e.target && t.matches(':focus-visible')) showTip(t); else if (tipFor) hideTip();
  });
  document.addEventListener('focusout', () => { if (tipFor) hideTip(); });
  window.addEventListener('blur', () => { if (tipFor) hideTip(); });

  // Responsive mode changes
  const onMedia = () => { if (!mqMobile.matches) state.ui.navOpen = false; render(); };
  for (const mq of [mqContextDrawer, mqPanelOverlay, mqMobile]) {
    if (mq.addEventListener) mq.addEventListener('change', onMedia); else if (mq.addListener) mq.addListener(onMedia);
  }

  /* ═══ Command palette ═══ */
  const paletteEl = $('palette');
  const paletteInput = $('palette-input');
  const paletteList = $('palette-list');
  let paletteItems = [];
  let paletteIndex = 0;
  let paletteOpener = null;
  const SECTION_ICONS = { peers: 'peers', groups: 'groups', tasks: 'tasks', files: 'files', activity: 'activity', decisions: 'decisions', verifications: 'verifications', proposals: 'proposals', approvals: 'approvals' };

  function paletteCommands() {
    const cmds = [];
    const counts = railCounts();
    for (const s of Object.keys(SECTIONS)) cmds.push({ group: 'Go to', label: SECTIONS[s].title, iconName: SECTION_ICONS[s], hint: counts[s] ? counts[s].label : '', run: () => setSection(s) });
    if (state.D) for (const p of state.D.peers) cmds.push({ group: 'Peers', label: p.name, peer: p, hint: STATUS_LABEL[p.status || 'online'], run: () => { if (!state.ui.selected || state.ui.selected.id !== p.id) selectPeer(p.id); } });
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    cmds.push(
      { group: 'Actions', label: 'Show all traffic', iconName: 'message', run: clearScope },
      { group: 'Actions', label: 'Write a message', iconName: 'send', hint: '/', run: () => textarea.focus() },
      { group: 'Actions', label: 'Search messages', iconName: 'search', run: () => searchInput.focus() },
      { group: 'Actions', label: 'Session report', iconName: 'report', run: openReport },
      { group: 'Actions', label: 'Export conversation (.txt)', iconName: 'download', run: exportConversation },
      { group: 'Actions', label: light ? 'Switch to dark theme' : 'Switch to light theme', iconName: light ? 'moon' : 'sun', run: () => $('theme-btn').click() },
      { group: 'Actions', label: panelOpen() ? 'Collapse panel' : 'Expand panel', iconName: 'sidebar', run: () => setPanelOpen(!panelOpen()) });
    return cmds;
  }
  function renderPalette() {
    const terms = paletteInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    paletteItems = paletteCommands().filter((c) => terms.every((t) => (c.label + ' ' + c.group).toLowerCase().includes(t)));
    if (paletteIndex >= paletteItems.length) paletteIndex = Math.max(0, paletteItems.length - 1);
    const out = [];
    let group = null;
    paletteItems.forEach((c, i) => {
      if (c.group !== group) { group = c.group; out.push(h('div', { class: 'palette-group', role: 'presentation', text: group })); }
      out.push(h('div', { class: 'palette-item', role: 'option', id: 'pal-' + i, 'data-index': i, 'aria-selected': String(i === paletteIndex) },
        c.peer ? tile(ref(c.peer.id), 'sm') : icon(c.iconName), h('span', { text: c.label }), c.hint ? h('span', { class: 'hint', text: c.hint }) : null));
    });
    if (!paletteItems.length) out.push(h('div', { class: 'palette-empty', text: 'No commands match “' + paletteInput.value + '”' }));
    fill(paletteList, out);
    if (paletteItems.length) {
      paletteInput.setAttribute('aria-activedescendant', 'pal-' + paletteIndex);
      const active = $('pal-' + paletteIndex);
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    } else paletteInput.removeAttribute('aria-activedescendant');
  }
  function openPalette() {
    if (paletteEl.open) return;
    paletteOpener = document.activeElement;
    paletteInput.value = '';
    paletteIndex = 0;
    renderPalette();
    if (typeof paletteEl.showModal === 'function') paletteEl.showModal(); else paletteEl.setAttribute('open', '');
    paletteInput.focus();
  }
  function closePalette() {
    if (!paletteEl.open) return;
    if (typeof paletteEl.close === 'function') paletteEl.close(); else { paletteEl.removeAttribute('open'); paletteEl.dispatchEvent(new Event('close')); }
  }
  paletteEl.addEventListener('close', () => {
    if (paletteOpener && paletteOpener.isConnected && paletteOpener !== document.body) paletteOpener.focus({ preventScroll: true });
    paletteOpener = null;
  });
  function runPaletteItem(i) {
    const c = paletteItems[i];
    if (!c) return;
    paletteOpener = null; // the command decides where focus goes
    closePalette();
    c.run();
  }
  paletteInput.addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
  paletteInput.addEventListener('keydown', (e) => {
    const n = paletteItems.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = n ? (paletteIndex + 1) % n : 0; renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = n ? (paletteIndex - 1 + n) % n : 0; renderPalette(); }
    else if (e.key === 'Home') { e.preventDefault(); paletteIndex = 0; renderPalette(); }
    else if (e.key === 'End') { e.preventDefault(); paletteIndex = Math.max(0, n - 1); renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(paletteIndex); }
  });
  paletteList.addEventListener('click', (e) => { const item = e.target.closest('.palette-item'); if (item) runPaletteItem(Number(item.dataset.index)); });
  paletteList.addEventListener('pointermove', (e) => {
    const item = e.target.closest('.palette-item');
    if (item && Number(item.dataset.index) !== paletteIndex) { paletteIndex = Number(item.dataset.index); renderPalette(); }
  });
  paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) closePalette(); }); // backdrop

  /* ═══ Session report ═══ */
  const reportEl = $('report');
  const reportBody = $('report-body');
  let reportText = '';
  let reportOpener = null;
  async function openReport() {
    if (!reportEl.open) reportOpener = document.activeElement;
    reportText = '';
    $('report-copy').disabled = true;
    $('report-download').disabled = true;
    fill(reportBody, h('div', { class: 'empty' }, icon('loader', 'spin'), h('div', { class: 'empty-title', text: 'Building the session report…' })));
    if (!reportEl.open) { if (typeof reportEl.showModal === 'function') reportEl.showModal(); else reportEl.setAttribute('open', ''); }
    $('report-close').focus();
    const r = await api('/session-report', {});
    if (!reportEl.open) return;
    if (!r.ok || !r.data || typeof r.data.report !== 'string') {
      const retry = h('button', { type: 'button', class: 'btn' }, icon('refresh'), 'Try again');
      retry.addEventListener('click', openReport);
      fill(reportBody, h('div', { class: 'empty' }, icon('alert'), h('div', { class: 'empty-title', text: "Couldn't build the report" }),
        h('div', { class: 'empty-body', text: r.ok ? 'The broker returned an unexpected response.' : r.error }), retry));
      return;
    }
    reportText = r.data.report;
    fill(reportBody, markdown(reportText));
    $('report-copy').disabled = false;
    $('report-download').disabled = false;
  }
  function closeReport() { if (typeof reportEl.close === 'function') reportEl.close(); else { reportEl.removeAttribute('open'); reportEl.dispatchEvent(new Event('close')); } }
  $('report-close').addEventListener('click', closeReport);
  reportEl.addEventListener('close', () => { if (reportOpener && reportOpener.isConnected && reportOpener !== document.body) reportOpener.focus({ preventScroll: true }); reportOpener = null; });
  reportEl.addEventListener('click', (e) => { if (e.target === reportEl) closeReport(); });
  $('report-copy').addEventListener('click', () => copyText(reportText, 'Report'));
  $('report-download').addEventListener('click', () => download('claude-peers-session-report.md', reportText, 'text/markdown'));

  /* ═══ Export (same format and file name as before) ═══ */
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Some browsers read the blob after click() returns; revoking at once can cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 40000);
  }
  function exportConversation() {
    const d = state.data;
    if (!d || !d.messages.length) { toast('There are no messages to export yet.', 'info'); return; }
    const nm = {};
    for (const p of d.peers) nm[p.id] = p.name || p.id;
    nm.dashboard = 'Dashboard';
    nm.cli = 'CLI';
    const lines = d.messages.map((m) => {
      const t = new Date(m.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return '[' + t + '] ' + (nm[m.from_id] || m.from_name || m.from_id) + ' \u2192 ' + (nm[m.to_id] || m.to_name || m.to_id) + ': ' + m.text;
    });
    download('claude-peers-chat.txt', lines.join('\n'), 'text/plain');
  }

  /* ═══ Keyboard shortcuts ═══ */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (paletteEl.open) closePalette(); else openPalette();
      return;
    }
    if (paletteEl.open || reportEl.open) return; // native <dialog> handles Escape and focus
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    if (e.key === 'Escape') { if (closeOverlays()) e.preventDefault(); return; }
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); textarea.focus(); }
  });

  /* ═══ Notifications (permission asked on the first interaction, not on load) ═══ */
  let lastMessageId = null;
  let unreadWhileHidden = 0;
  function askNotifications() {
    if ('Notification' in window && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* unsupported */ } }
  }
  document.addEventListener('pointerdown', askNotifications, { once: true });
  document.addEventListener('keydown', askNotifications, { once: true });
  function notifyNew(d) {
    const last = d.messages.length ? d.messages[d.messages.length - 1].id : 0;
    if (lastMessageId !== null && last > lastMessageId) {
      const fresh = d.messages.filter((m) => m.id > lastMessageId && m.from_id !== 'dashboard');
      if (fresh.length && document.hidden) {
        unreadWhileHidden += fresh.length;
        document.title = '(' + unreadWhileHidden + ') claude-peers';
        const m = fresh[fresh.length - 1];
        if ('Notification' in window && Notification.permission === 'granted') {
          try { new Notification(ref(m.from_id, m.from_name).name + ' \u2192 ' + ref(m.to_id, m.to_name).name, { body: excerpt(m.text, 140), tag: 'claude-peers-msg' }); }
          catch (e) { /* notifications unavailable */ }
        }
      }
    }
    lastMessageId = Math.max(lastMessageId || 0, last);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    unreadWhileHidden = 0;
    document.title = 'claude-peers';
    if (state.conn !== 'live') reconnectNow();
  });

  /* ═══ Data intake ═══ */
  function ingest(d) {
    if (!d || !Array.isArray(d.peers) || !Array.isArray(d.messages)) { console.warn('[claude-peers] ignored a malformed state update'); return; }
    for (const k of ['groups', 'typing', 'tasks', 'pinned', 'active_files', 'approvals', 'audit', 'decisions', 'verifications', 'proposals']) if (!Array.isArray(d[k])) d[k] = [];
    if (!d.reactions || typeof d.reactions !== 'object') d.reactions = {};
    // A new broker session starts a new message history: drop everything keyed by message or peer id.
    if (state.data && d.session_id !== state.data.session_id) {
      nodes.clear();
      lastDelivery.clear();
      seenIds = null;
      trActive.clear();
      lastMessageId = null;
      sigs.clear();
      knownProcs.clear();
      knownNames.clear();
    }
    state.data = d;
    state.dataAt = Date.now();
    state.loadError = null;
    state.D = derive(d);
    for (const p of d.peers) {
      knownProcs.set(p.id, procKey(p));
      if (!knownNames.has(p.name)) knownNames.set(p.name, new Set());
      knownNames.get(p.name).add(procKey(p));
    }
    // A snapshot after a succeeded action shows its effect, so its control can take input again.
    for (const t of settling.values()) clearTimeout(t);
    settling.clear();
    // A reconnecting session registers again from the same process with a new id. Follow the selection and the
    // recipient to it by pid and directory; never by name alone, which an unrelated session may have taken over.
    const ui = state.ui;
    let followed = null;
    for (const key of ['selected', 'recipient']) {
      const cur = ui[key];
      if (!cur) continue;
      const live = state.D.peerById.get(cur.id);
      if (live) { cur.name = live.name; continue; }
      const next = cur.pid ? state.D.peers.find((p) => p.pid === cur.pid && p.cwd === cur.cwd) : null;
      if (next) { ui[key] = target(next, cur); followed = next; }
    }
    if (followed && ui.recipient && ui.recipient.id === followed.id) {
      state.sendError = ''; // an "is offline" error no longer applies
      setSendStatus(followed.name + ' reconnected; messages now go to its new session.', null, 6000);
    }
    if (ui.groupDraft) {
      const p = state.D.peerById.get(ui.groupDraft.peer);
      const current = p && p.group_id && state.D.groupById.has(p.group_id) ? p.group_id : '';
      if (!p || current === ui.groupDraft.group || (ui.groupDraft.group && !state.D.groupById.has(ui.groupDraft.group))) ui.groupDraft = null;
    }
    if (ui.confirmGroup && !state.D.groupById.has(ui.confirmGroup)) ui.confirmGroup = null;
    if (d.typing.length) setTimeout(render, TYPING_FRESH_MS + 100); // clears the indicator if no newer snapshot arrives
    notifyNew(d);
    render();
  }

  /* ═══ Connection: WebSocket push, polling fallback ═══ */
  let ws = null, wsTimer = null, wsDelay = 1000, wsHeardAt = 0;
  function setConn(c) {
    if (state.conn === c) return;
    const wasUp = state.conn === 'live' || state.conn === 'connecting';
    state.conn = c;
    if (c === 'reconnecting' || c === 'offline') {
      if (wasUp || !state.downSince) state.downSince = Date.now();
      setTimeout(render, 3100); // the banner appears once the outage outlasts a brief blip
    } else state.downSince = 0;
    render();
  }
  function connect() {
    clearTimeout(wsTimer);
    wsTimer = null;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return; // one socket at a time
    let sock;
    try { sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
    catch (e) { scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      wsDelay = 1000;
      wsHeardAt = Date.now();
      state.lastPollOk = true; // the broker answered; an earlier failed poll no longer describes it
      setConn('live');
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      wsHeardAt = Date.now();
      let d;
      try { d = JSON.parse(ev.data); } catch (err) { console.error('[claude-peers] bad state frame', err); return; }
      ingest(d);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setConn(state.lastPollOk === false ? 'offline' : 'reconnecting');
      scheduleReconnect();
    };
    sock.onerror = () => { try { sock.close(); } catch (e) { /* already closed */ } };
  }
  // A socket can stay "open" after the connection silently died (sleep, network change). The broker pushes at least
  // every 15 s, so a long silence means it is gone: drop it and reconnect, polling meanwhile.
  function checkSocket() {
    if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - wsHeardAt < WS_SILENCE_MS) return;
    const dead = ws;
    ws = null;
    try { dead.close(); } catch (e) { /* already closing */ }
    setConn('reconnecting');
    scheduleReconnect();
    refresh();
  }
  function scheduleReconnect() {
    if (wsTimer) return;
    wsTimer = setTimeout(() => { wsTimer = null; connect(); }, wsDelay);
    wsDelay = Math.min(wsDelay * 1.5, 10000);
  }
  function reconnectNow() {
    wsDelay = 1000;
    clearTimeout(wsTimer);
    wsTimer = null;
    connect();
    refresh();
  }
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const r = await fetch('/api/dashboard-state', { cache: 'no-store', signal: timeoutSignal(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      state.lastPollOk = true;
      ingest(d);
      if (state.conn === 'offline' || state.conn === 'connecting') setConn(ws && ws.readyState === WebSocket.OPEN ? 'live' : 'reconnecting');
    } catch (e) {
      state.lastPollOk = false;
      if (!ws || ws.readyState !== WebSocket.OPEN) setConn('offline');
      if (!state.data) { state.loadError = String((e && e.message) || e); render(); }
    } finally {
      refreshing = false;
    }
  }

  /* ═══ Start ═══ */
  setPanelWidth(state.ui.panelWidth);
  render();
  refresh();
  connect();
  setInterval(() => { checkSocket(); if (!ws || ws.readyState !== WebSocket.OPEN) refresh(); }, POLL_MS);
  setInterval(() => setText($('uptime'), brokerMeta()), 5000);
  setInterval(() => render(), 30000); // relative times and the stale-data banner

  /* ═══ Old markup guard ═══ */
  function staleMarkupNotice() {
    // A cached copy of the previous dashboard.html loaded this newer script.
    const note = document.createElement('div');
    note.setAttribute('role', 'alert');
    note.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;padding:12px 16px;border-radius:8px;background:#2b1b14;color:#f3e9e1;font:14px/1.5 system-ui,sans-serif';
    note.textContent = 'The dashboard was updated. Reload the page with Ctrl+Shift+R to load the new version.';
    document.body.appendChild(note);
  }
})();
