/*
 * Smart Flashcards — Obsidian Plugin
 * Spaced repetition flashcards with inline syntax, sidebar panel, and note-level review.
 *
 * Card syntax:
 *   Single-directional : Front :: Back
 *   Bidirectional      : Front ::: Back
 *   Cloze              : Sentence with =-=hidden text=-= inside
 *
 * Data storage:
 *   Cards  → .smart-flashcards/srs-data.json (keyed by file path → card key)
 *            (bidirectional back direction uses key = front + '__back')
 *   Notes  → frontmatter fields srs-due, srs-interval, srs-reps
 *   Config → data.json (excludedFolders, streak, etc.)
 */

'use strict';

const { Plugin, ItemView, Modal, Notice, MarkdownRenderer, Setting, PluginSettingTab, TFile } = require('obsidian');

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const VIEW_TYPE = 'smart-flashcards-panel';

/** Fixed note-review interval progression (days) indexed by reps count */
const NOTE_INTERVALS = [1, 3, 7, 14, 30, 60, 90];

const DEFAULT_SETTINGS = {
  excludedFolders: ['Resources', 'Resources/Templates', 'Readwise', '.obsidian', '.claude'],
  defaultEase: 2.5,
  reviewStreak: { count: 0, lastDate: '' },
};

// ─────────────────────────────────────────────────────────────
// DATE HELPERS  (always work in local time — avoids UTC-shift bug)
// ─────────────────────────────────────────────────────────────

/** Parse a YYYY-MM-DD string as local midnight */
function localDateFromStr(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Today at local midnight */
function localToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Format a Date as YYYY-MM-DD in local time */
function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────
// SM-2 ALGORITHM
// ─────────────────────────────────────────────────────────────

const SM2 = {
  /**
   * @param {object} srsData  Current SRS data for this card direction
   * @param {number} quality  0=Again, 2=Hard, 4=Good, 5=Easy
   * @returns {object} Updated SRS data
   */
  review(srsData, quality) {
    const r = srsData ? srsData.r || 0 : 0;
    const e = srsData ? srsData.e || 2.5 : 2.5;
    const i = srsData ? srsData.i || 1 : 1;

    let newInterval, newEase, newReps;

    if (quality >= 3) {
      // Correct recall
      if (r === 0) newInterval = 1;
      else if (r === 1) newInterval = 6;
      else newInterval = Math.round(i * e);

      newEase = Math.max(1.3, e + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
      newReps = r + 1;
    } else {
      // Forgotten
      newInterval = 1;
      newEase = Math.max(1.3, e - 0.2);
      newReps = 0;
    }

    const due = new Date();
    due.setDate(due.getDate() + newInterval);

    return {
      d: localDateStr(due),
      i: newInterval,
      e: Math.round(newEase * 100) / 100,
      r: newReps,
    };
  },

  /** Returns true if this card is due (or has never been reviewed) */
  isDue(srsData) {
    if (!srsData) return true;
    if (!srsData.d) return true;
    return localDateFromStr(srsData.d) <= localToday();
  },

  /** Returns the due date as a Date object, or null for new cards */
  getDueDate(srsData) {
    if (!srsData || !srsData.d) return null;
    return localDateFromStr(srsData.d);
  },

  /** Preview what intervals each rating would give */
  previewIntervals(srsData) {
    return {
      again: 1,
      hard: SM2.review(srsData, 2).i,
      good: SM2.review(srsData, 4).i,
      easy: SM2.review(srsData, 5).i,
    };
  },

  /** Get the fixed note-review interval for a given rep count */
  noteInterval(reps) {
    return NOTE_INTERVALS[Math.min(reps || 0, NOTE_INTERVALS.length - 1)];
  },
};

// ─────────────────────────────────────────────────────────────
// CARD PARSER
// ─────────────────────────────────────────────────────────────

const CardParser = {
  /**
   * Parse all flashcards from markdown content.
   * Returns an array of ParsedCard objects.
   *
   * ParsedCard shape:
   * {
   *   type: 'basic' | 'bidirectional' | 'cloze',
   *   front: string,
   *   back: string,       // for cloze: the full line with =-= markers intact
   *   lineIndex: number,  // 0-based index of the card line
   *   srsData: object | null,  // parsed from <!--SFC:--> comment
   *   // For bidirectional cards:
   *   srsDataForward: object | null,
   *   srsDataBack: object | null,
   * }
   */
  parseCards(content, inlineSrsMap = {}) {
    const lines = content.split('\n');
    const cards = [];

    // Find frontmatter end
    let frontmatterEnd = 0;
    if (lines[0] === '---') {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') { frontmatterEnd = i + 1; break; }
      }
    }

    // Track which line ranges are inside %%...%% comment blocks
    const commentRanges = CardParser._findCommentRanges(lines);

    // Track which line ranges are inside code blocks
    const codeRanges = CardParser._findCodeRanges(lines);

    for (let i = frontmatterEnd; i < lines.length; i++) {
      const line = lines[i];

      // Skip lines inside %% blocks or code blocks
      if (CardParser._inRanges(i, commentRanges)) continue;
      if (CardParser._inRanges(i, codeRanges)) continue;

      // ── Inline cards: (Q :: A) or {Q :: A} embedded within prose ──
      // Check these first so parens/braces don't confuse the standalone matchers.
      const inlineMatches = CardParser._matchInlineCards(line);
      if (inlineMatches.length > 0) {
        for (const ic of inlineMatches) {
          const srs = inlineSrsMap[ic.front] || null;
          const srsBack = inlineSrsMap[ic.front + '__back'] || null;
          cards.push({
            type: ic.type,
            front: ic.front,
            back: ic.back,
            lineIndex: i,
            charIndex: ic.charIndex,
            isInline: true,
            displayMode: ic.displayMode,
            srsData: srs,
            srsDataForward: srs,
            srsDataBack: ic.type === 'bidirectional' ? srsBack : null,
          });
        }
        continue; // don't also try standalone parsing on the same line
      }

      // ── Bidirectional (check before basic so ::: isn't caught by ::) ──
      const biMatch = CardParser._matchBidirectional(line);
      if (biMatch) {
        const biSrsForward = inlineSrsMap[biMatch.front] || null;
        const biSrsBack = inlineSrsMap[biMatch.front + '__back'] || null;
        cards.push({
          type: 'bidirectional',
          front: biMatch.front,
          back: biMatch.back,
          lineIndex: i,
          isInline: false,
          srsData: biSrsForward,
          srsDataForward: biSrsForward,
          srsDataBack: biSrsBack,
        });
        continue;
      }

      // ── Basic (single-directional) ──
      const basicMatch = CardParser._matchBasic(line);
      if (basicMatch) {
        const basicSrs = inlineSrsMap[basicMatch.front] || null;
        cards.push({
          type: 'basic',
          front: basicMatch.front,
          back: basicMatch.back,
          lineIndex: i,
          isInline: false,
          srsData: basicSrs,
          srsDataForward: basicSrs,
          srsDataBack: null,
        });
        continue;
      }

      // ── Cloze ──
      const clozeMatch = CardParser._matchCloze(line);
      if (clozeMatch) {
        const clozeSrs = inlineSrsMap[line] || null;
        cards.push({
          type: 'cloze',
          front: line,   // full line with =-= markers (also used as sfc-cards key)
          back: line,    // same — rendering handles blank/reveal
          lineIndex: i,
          isInline: false,
          srsData: clozeSrs,
          srsDataForward: clozeSrs,
          srsDataBack: null,
          clozeSegments: clozeMatch,
        });
        continue;
      }
    }

    return cards;
  },

  /**
   * Find all inline cards within a single line.
   * Matches: (Q :: A), {Q :: A}, (Q ::: A), {Q ::: A}
   * Returns array of { type, front, back, charIndex, displayMode }
   */
  _matchInlineCards(line) {
    const results = [];
    // Single regex covers all four variants; capture groups:
    //  1 = opening bracket char ( or {
    //  2 = front text
    //  3 = separator (:: or :::)
    //  4 = back text
    const regex = /([({])((?:(?!\s:::?\s).)+?)\s(:::?)\s((?:(?![)}\n]).)+?)([)}])/g;
    let m;
    while ((m = regex.exec(line)) !== null) {
      const [, open, front, sep, back, close] = m;
      // Bracket must match: ( with ), { with }
      if ((open === '(' && close !== ')') || (open === '{' && close !== '}')) continue;
      const type = sep === ':::' ? 'bidirectional' : 'basic';
      // displayMode: parens = hide answer (show Q), braces = hide question (show A)
      const displayMode = open === '(' ? 'hide-back' : 'hide-front';
      results.push({ type, front: front.trim(), back: back.trim(), charIndex: m.index, displayMode });
    }
    return results;
  },

  /** Match  "Front :: Back"  (not :::) */
  _matchBasic(line) {
    // Require spaces around :: to distinguish from metadata (author:: value)
    const idx = line.indexOf(' :: ');
    if (idx === -1) return null;
    // Ensure it's not actually :::
    if (line[idx + 4] === ':') return null;
    return {
      front: line.slice(0, idx).trim(),
      back: line.slice(idx + 4).trim(),
    };
  },

  /** Match  "Front ::: Back" */
  _matchBidirectional(line) {
    const idx = line.indexOf(' ::: ');
    if (idx === -1) return null;
    return {
      front: line.slice(0, idx).trim(),
      back: line.slice(idx + 5).trim(),
    };
  },

  /** Match lines with =-=...=-= cloze markers */
  _matchCloze(line) {
    const regex = /=-=(.+?)=-=/g;
    const segments = [];
    let m;
    while ((m = regex.exec(line)) !== null) {
      segments.push({ text: m[1], start: m.index, end: m.index + m[0].length });
    }
    return segments.length > 0 ? segments : null;
  },

  /** Find ranges of lines inside %%...%% comment blocks */
  _findCommentRanges(lines) {
    const ranges = [];
    let start = null;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '%%' && start === null) { start = i; }
      else if (t === '%%' && start !== null) { ranges.push([start, i]); start = null; }
    }
    return ranges;
  },

  /** Find ranges of lines inside fenced code blocks */
  _findCodeRanges(lines) {
    const ranges = [];
    let start = null;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if ((t.startsWith('```') || t.startsWith('~~~')) && start === null) { start = i; }
      else if ((t.startsWith('```') || t.startsWith('~~~')) && start !== null) { ranges.push([start, i]); start = null; }
    }
    return ranges;
  },

  _inRanges(idx, ranges) {
    return ranges.some(([s, e]) => idx >= s && idx <= e);
  },

};

// ─────────────────────────────────────────────────────────────
// SRS DATABASE  (single JSON file for all card SRS data)
// ─────────────────────────────────────────────────────────────

const SRS_DB_PATH = '.smart-flashcards/srs-data.json';

class SrsDatabase {
  constructor(app) {
    this.app = app;
    this._data = {};  // { [filePath]: { [cardKey]: srsData } }
  }

  async load() {
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(SRS_DB_PATH)) {
        this._data = JSON.parse(await adapter.read(SRS_DB_PATH));
      }
    } catch { this._data = {}; }
  }

  async _save() {
    const adapter = this.app.vault.adapter;
    const json = JSON.stringify(this._data, null, 2);
    try { await adapter.mkdir('.smart-flashcards'); } catch { /* already exists */ }
    await adapter.write(SRS_DB_PATH, json);
  }

  getFileMap(filePath) { return this._data[filePath] || {}; }

  async set(filePath, key, srsData) {
    if (!this._data[filePath]) this._data[filePath] = {};
    this._data[filePath][key] = srsData;
    await this._save();
  }

  async renameFile(oldPath, newPath) {
    if (!this._data[oldPath]) return;
    this._data[newPath] = this._data[oldPath];
    delete this._data[oldPath];
    await this._save();
  }
}

// ─────────────────────────────────────────────────────────────
// STORAGE MANAGER
// ─────────────────────────────────────────────────────────────

class StorageManager {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.db = plugin.db;
  }

  /** Check if a file path is in an excluded folder */
  isExcluded(filePath) {
    const excluded = this.plugin.settings.excludedFolders || [];
    return excluded.some(folder => {
      const f = folder.endsWith('/') ? folder : folder + '/';
      return filePath.startsWith(f) || filePath === folder;
    });
  }

  /** Check if a note is opted out of SRS */
  isNoteOptedOut(file) {
    if (this.isExcluded(file.path)) return true;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache || !cache.frontmatter) return false;
    return cache.frontmatter.srs === false;
  }

  /** Update SRS data for a card (stored in .smart-flashcards/srs-data.json) */
  async updateCardSRS(file, frontText, newSrsData, direction = 'forward') {
    const key = direction === 'back' ? frontText + '__back' : frontText;
    await this.db.set(file.path, key, newSrsData);
    this.app.workspace.trigger('sfc:srs-updated', file);
  }

  /** Update note-level SRS frontmatter fields */
  async updateNoteSRS(file, interval, reps) {
    const due = new Date();
    due.setDate(due.getDate() + interval);
    const dueStr = localDateStr(due);

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm['srs-due'] = dueStr;
      fm['srs-interval'] = interval;
      fm['srs-reps'] = reps;
    });
  }

  /** Scan all vault files and return cards that are due */
  async getAllDueCards() {
    const files = this.app.vault.getMarkdownFiles();
    const due = [];

    for (const file of files) {
      if (this.isNoteOptedOut(file)) continue;

      let content;
      try { content = await this.app.vault.read(file); } catch { continue; }

      const inlineSrsMap = this.db.getFileMap(file.path);
      const cards = CardParser.parseCards(content, inlineSrsMap);
      for (const card of cards) {
        // Bidirectional: check forward and back independently
        if (card.type === 'bidirectional') {
          if (SM2.isDue(card.srsDataForward)) {
            due.push({ ...card, direction: 'forward', file, srsData: card.srsDataForward });
          }
          if (SM2.isDue(card.srsDataBack)) {
            due.push({ ...card, direction: 'back', file, srsData: card.srsDataBack });
          }
        } else {
          if (SM2.isDue(card.srsDataForward)) {
            due.push({ ...card, direction: 'forward', file, srsData: card.srsDataForward });
          }
        }
      }
    }

    return due;
  }

  /** Get all notes that have a srs-due <= today and are not opted out */
  async getAllDueNotes() {
    const files = this.app.vault.getMarkdownFiles();
    const today = localToday();
    const due = [];

    for (const file of files) {
      if (this.isNoteOptedOut(file)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache || !cache.frontmatter) continue;
      const srsDue = cache.frontmatter['srs-due'];
      if (!srsDue) continue;
      if (localDateFromStr(srsDue) <= today) due.push(file);
    }

    return due;
  }

  /** Count new notes (eligible but never reviewed — no srs-due field) */
  countNewNotes() {
    const files = this.app.vault.getMarkdownFiles();
    let count = 0;
    for (const file of files) {
      if (this.isNoteOptedOut(file)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache && cache.frontmatter && cache.frontmatter['srs-due']) continue;
      count++;
    }
    return count;
  }

  /** Return { cards: N, notes: M } due counts */
  async getDueCounts() {
    const [cards, notes] = await Promise.all([
      this.getAllDueCards(),
      this.getAllDueNotes(),
    ]);
    return { cards: cards.length, notes: notes.length };
  }
}

// ─────────────────────────────────────────────────────────────
// FLASHCARD PANEL VIEW (Sidebar)
// ─────────────────────────────────────────────────────────────

class FlashcardPanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this._currentFile = null;
    this._onActiveLeafChange = this._onActiveLeafChange.bind(this);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Flashcards'; }
  getIcon() { return 'layers'; }

  async onOpen() {
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', this._onActiveLeafChange)
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (file === this._currentFile) this._render(file);
      })
    );
    this.registerEvent(
      this.app.workspace.on('sfc:srs-updated', (file) => {
        if (file === this._currentFile) this._render(file);
      })
    );
    // Render for whichever note is currently open
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) await this._render(activeFile);
    else this._renderEmpty('Open a note to see its flashcards.');
  }

  async onClose() {}

  async _onActiveLeafChange() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file === this._currentFile) return;
    await this._render(file);
  }

  async _render(file) {
    this._currentFile = file;
    const container = this.containerEl.children[1];
    container.empty();

    if (!file || file.extension !== 'md') {
      this._renderEmpty('Open a markdown note to see its flashcards.');
      return;
    }

    let content;
    try { content = await this.app.vault.read(file); } catch {
      this._renderEmpty('Could not read file.');
      return;
    }

    const inlineSrsMap = this.plugin.db.getFileMap(file.path);
    const cards = CardParser.parseCards(content, inlineSrsMap);
    const today = localToday();

    const panel = container.createDiv({ cls: 'sfc-panel' });

    // Header
    const header = panel.createDiv({ cls: 'sfc-panel-header' });
    header.createEl('h4', { text: `Flashcards (${cards.length})` });

    // Count due
    const dueCards = cards.filter(c => {
      if (c.type === 'bidirectional') {
        return SM2.isDue(c.srsDataForward) || SM2.isDue(c.srsDataBack);
      }
      return SM2.isDue(c.srsDataForward);
    });

    if (dueCards.length > 0) {
      const reviewBtn = header.createEl('button', {
        cls: 'sfc-review-btn',
        text: `Review ${dueCards.length} due`,
      });
      reviewBtn.addEventListener('click', () => {
        // Build queue from due cards in this file
        const queue = this._buildQueue(cards, file);
        if (queue.length > 0) new ReviewModal(this.app, this.plugin, queue).open();
      });
    }

    if (cards.length === 0) {
      panel.createDiv({ cls: 'sfc-empty-state', text: 'No flashcards in this note.\n\nAdd cards using:\n  Question :: Answer\n  Concept ::: Definition\n  A =-=cloze=-= sentence' });
      return;
    }

    // Render each card
    for (const card of cards) {
      const row = panel.createDiv({ cls: 'sfc-card-row' });

      // Type icon
      const typeEl = row.createDiv({ cls: 'sfc-card-type' });
      if (card.type === 'basic') typeEl.setText('→');
      else if (card.type === 'bidirectional') typeEl.setText('↔');
      else typeEl.setText('[c]');

      // Front text
      const frontEl = row.createDiv({ cls: 'sfc-card-front' });
      const displayFront = card.type === 'cloze'
        ? card.front.replace(/=-=(.+?)=-=/g, '[...]')
        : card.front;
      frontEl.setText(displayFront.length > 45 ? displayFront.slice(0, 44) + '…' : displayFront);

      // Due pill — use forward data (primary)
      const primarySrs = card.srsDataForward;
      const pill = row.createDiv({ cls: 'sfc-due-pill' });
      if (!primarySrs) {
        pill.addClass('new');
        pill.setText('New');
      } else {
        const dueDate = localDateFromStr(primarySrs.d);
        const diff = Math.round((dueDate - today) / 86400000);
        if (diff < 0) { pill.addClass('overdue'); pill.setText(`${Math.abs(diff)}d late`); }
        else if (diff === 0) { pill.addClass('due-today'); pill.setText('Due today'); }
        else { pill.addClass('upcoming'); pill.setText(`in ${diff}d`); }
      }

      // Click to review this individual card
      row.addEventListener('click', () => {
        const queue = this._buildQueue([card], file);
        if (queue.length > 0) new ReviewModal(this.app, this.plugin, queue).open();
        else new ReviewModal(this.app, this.plugin, [{...card, direction: 'forward', file, srsData: card.srsDataForward}]).open();
      });
    }
  }

  _buildQueue(cards, file) {
    const queue = [];
    for (const card of cards) {
      if (card.type === 'bidirectional') {
        if (SM2.isDue(card.srsDataForward)) queue.push({ ...card, direction: 'forward', file, srsData: card.srsDataForward });
        if (SM2.isDue(card.srsDataBack)) queue.push({ ...card, direction: 'back', file, srsData: card.srsDataBack });
      } else {
        if (SM2.isDue(card.srsDataForward)) queue.push({ ...card, direction: 'forward', file, srsData: card.srsDataForward });
      }
    }
    return queue;
  }

  _renderEmpty(msg) {
    const container = this.containerEl.children[1];
    container.empty();
    const panel = container.createDiv({ cls: 'sfc-panel' });
    panel.createDiv({ cls: 'sfc-empty-state', text: msg });
  }
}

// ─────────────────────────────────────────────────────────────
// REVIEW MODAL
// ─────────────────────────────────────────────────────────────

class ReviewModal extends Modal {
  /**
   * @param {App} app
   * @param {SmartFlashcardsPlugin} plugin
   * @param {Array} queue  Array of {card, direction, file, srsData}
   */
  constructor(app, plugin, queue) {
    super(app);
    this.plugin = plugin;
    this.storage = plugin.storage;
    this.queue = queue;
    this.index = 0;
    this.showingFront = true;
    this.modalEl.addClass('sfc-review-modal');
  }

  onOpen() {
    document.body.classList.add('sfc-review-open');
    this._render();
  }

  onClose() {
    document.body.classList.remove('sfc-review-open');
    this.contentEl.empty();
  }

  _currentCard() { return this.queue[this.index]; }

  async _render() {
    const { contentEl } = this;
    contentEl.empty();

    if (this.index >= this.queue.length) {
      this._renderSummary();
      return;
    }

    const card = this._currentCard();

    // ── Header ──
    const header = contentEl.createDiv({ cls: 'sfc-review-header' });
    header.createDiv({
      cls: 'sfc-review-progress',
      text: `Card ${this.index + 1} of ${this.queue.length}`,
    });
    const typeName = card.type === 'basic' ? 'Basic'
      : card.type === 'bidirectional' ? (card.direction === 'forward' ? 'Forward' : 'Reverse')
      : 'Cloze';
    header.createDiv({ cls: 'sfc-card-type-badge', text: typeName });

    // ── Body ──
    const body = contentEl.createDiv({ cls: 'sfc-review-body' });

    if (this.showingFront) {
      await this._renderFront(body, card);
    } else {
      await this._renderBack(body, card);
    }
  }

  /** Render markdown (including [[wikilinks]]) into an element via Obsidian's renderer */
  async _renderMd(el, text, file) {
    el.empty();
    await MarkdownRenderer.render(this.app, text, el, file ? file.path : '', this.plugin);
    el.querySelectorAll('p').forEach(p => { p.style.margin = '0'; });

    // Enable Cmd/Ctrl+hover previews on internal links
    const sourcePath = file ? file.path : '';
    el.querySelectorAll('a.internal-link').forEach(linkEl => {
      linkEl.addEventListener('mouseover', (event) => {
        this.app.workspace.trigger('hover-link', {
          event,
          source: 'smart-flashcards',
          hoverParent: { hoverPopover: null },
          targetEl: linkEl,
          linktext: linkEl.getAttribute('data-href') || linkEl.getAttribute('href'),
          sourcePath,
        });
      });
    });
  }

  async _renderFront(body, card) {
    const frontEl = body.createDiv({ cls: 'sfc-card-front-display' });

    if (card.type === 'cloze') {
      await this._renderMd(frontEl, card.front, card.file);
      SmartFlashcardsPlugin._applyClozeCls(frontEl, 'sfc-cloze-blank');
    } else if (card.direction === 'back') {
      // Reverse direction: show the "back" as the question
      await this._renderMd(frontEl, card.back, card.file);
    } else {
      await this._renderMd(frontEl, card.front, card.file);
    }

    const showBtn = body.createEl('button', {
      cls: 'sfc-show-answer-btn',
      text: 'Show Answer',
    });
    showBtn.addEventListener('click', () => {
      this.showingFront = false;
      this._render();
    });
  }

  async _renderBack(body, card) {
    // Dimmed question
    const frontEl = body.createDiv({ cls: 'sfc-card-front-display dimmed' });
    if (card.direction === 'back') await this._renderMd(frontEl, card.back, card.file);
    else if (card.type === 'cloze') {
      await this._renderMd(frontEl, card.front, card.file);
      SmartFlashcardsPlugin._applyClozeCls(frontEl, 'sfc-cloze-blank');
    } else await this._renderMd(frontEl, card.front, card.file);

    // Answer
    const backEl = body.createDiv({ cls: 'sfc-card-back-display' });
    if (card.type === 'cloze') {
      await this._renderMd(backEl, card.back, card.file);
      SmartFlashcardsPlugin._applyClozeCls(backEl, 'sfc-cloze-blank revealed');
    } else if (card.direction === 'back') {
      await this._renderMd(backEl, card.front, card.file);
    } else {
      await this._renderMd(backEl, card.back, card.file);
    }

    // ── Rating area ──
    const ratingArea = this.contentEl.createDiv({ cls: 'sfc-rating-area' });
    ratingArea.createDiv({ cls: 'sfc-rating-label', text: 'How well did you remember?' });

    const buttons = ratingArea.createDiv({ cls: 'sfc-rating-buttons' });
    const intervals = SM2.previewIntervals(card.srsData);

    const ratings = [
      { label: 'Again', cls: 'again', quality: 0, interval: 1 },
      { label: 'Hard',  cls: 'hard',  quality: 2, interval: intervals.hard },
      { label: 'Good',  cls: 'good',  quality: 4, interval: intervals.good },
      { label: 'Easy',  cls: 'easy',  quality: 5, interval: intervals.easy },
    ];

    for (const r of ratings) {
      const btn = buttons.createEl('button', { cls: `sfc-rating-btn ${r.cls}` });
      btn.createDiv({ cls: 'btn-label', text: r.label });
      btn.createDiv({ cls: 'btn-interval', text: r.interval === 1 ? '1d' : `${r.interval}d` });
      btn.addEventListener('click', () => this._rate(r.quality));
    }
  }

  async _rate(quality) {
    const card = this._currentCard();
    const newSrs = SM2.review(card.srsData, quality);

    // Write updated SRS data back to the note's frontmatter
    try {
      await this.storage.updateCardSRS(card.file, card.front, newSrs, card.direction);
    } catch (e) {
      console.warn('Smart Flashcards: failed to save SRS data', e);
    }

    // Advance queue
    this.index++;
    this.showingFront = true;
    this._render();

    // Update streak and status bar on last card
    if (this.index >= this.queue.length) {
      await this.plugin.onReviewComplete();
    }
  }

  _renderSummary() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('sfc-summary-modal');

    const body = contentEl.createDiv({ cls: 'sfc-summary-body' });
    body.createEl('h2', { text: '🎉 Session complete!' });
    body.createEl('p', { text: `You reviewed ${this.queue.length} card${this.queue.length !== 1 ? 's' : ''}.` });
    body.createEl('p', { text: 'Great work. Come back tomorrow for the next batch.' });

    const closeBtn = body.createEl('button', {
      cls: 'sfc-show-answer-btn',
      text: 'Close',
    });
    closeBtn.addEventListener('click', () => this.close());
  }
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD MODAL
// ─────────────────────────────────────────────────────────────

class DashboardModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.storage = plugin.storage;
    this.modalEl.addClass('sfc-dashboard-modal');
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: 'Loading…', cls: 'sfc-loading' });

    // Gather data
    const [dueCards, dueNotes] = await Promise.all([
      this.storage.getAllDueCards(),
      this.storage.getAllDueNotes(),
    ]);
    const newNoteCount = this.storage.countNewNotes();
    const streak = this.plugin.settings.reviewStreak;

    contentEl.empty();

    // ── Header ──
    const header = contentEl.createDiv({ cls: 'sfc-dashboard-header' });
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    header.createEl('h2', { text: greeting + ' 👋' });
    header.createDiv({
      cls: 'sfc-date',
      text: new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    });

    // ── Stats ──
    const stats = contentEl.createDiv({ cls: 'sfc-dashboard-stats' });
    [
      { number: dueCards.length, label: 'Cards Due' },
      { number: dueNotes.length, label: 'Notes Due' },
      { number: newNoteCount, label: 'New Notes' },
      { number: streak.count, label: 'Day Streak 🔥' },
    ].forEach(s => {
      const block = stats.createDiv({ cls: 'sfc-stat-block' });
      block.createDiv({ cls: 'stat-number', text: String(s.number) });
      block.createDiv({ cls: 'stat-label', text: s.label });
    });

    // ── Due Cards section ──
    if (dueCards.length > 0) {
      const sec = contentEl.createDiv({ cls: 'sfc-dashboard-section' });
      sec.createEl('h3', { text: `Flashcards (${dueCards.length} due)` });

      // Group by file
      const byFile = new Map();
      for (const c of dueCards) {
        const key = c.file.path;
        if (!byFile.has(key)) byFile.set(key, { file: c.file, count: 0 });
        byFile.get(key).count++;
      }

      const list = sec.createDiv({ cls: 'sfc-note-list' });
      for (const [, { file, count }] of byFile) {
        const item = list.createDiv({ cls: 'sfc-note-item' });
        item.createDiv({ cls: 'note-name', text: file.basename });
        item.createDiv({ cls: 'note-count', text: `${count} card${count !== 1 ? 's' : ''}` });
      }
    }

    // ── Due Notes section ──
    if (dueNotes.length > 0) {
      const sec = contentEl.createDiv({ cls: 'sfc-dashboard-section' });
      sec.createEl('h3', { text: `Notes to Review (${dueNotes.length})` });

      const list = sec.createDiv({ cls: 'sfc-note-list' });
      const today = localToday();

      for (const file of dueNotes.slice(0, 10)) {
        const cache = this.app.metadataCache.getFileCache(file);
        const srsDue = cache && cache.frontmatter ? cache.frontmatter['srs-due'] : null;
        const item = list.createDiv({ cls: 'sfc-note-item' });
        item.createDiv({ cls: 'note-name', text: file.basename });
        if (srsDue) {
          const days = Math.round((today - localDateFromStr(srsDue)) / 86400000);
          item.createDiv({ cls: 'note-count', text: days === 0 ? 'today' : `${days}d ago` });
        }
        item.style.cursor = 'pointer';
        item.addEventListener('click', async () => {
          this.close();
          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(file);
        });
      }

      if (dueNotes.length > 10) {
        list.createEl('p', { text: `…and ${dueNotes.length - 10} more`, cls: 'sfc-empty-state' });
      }
    }

    // ── New Notes section ──
    if (newNoteCount > 0) {
      const sec = contentEl.createDiv({ cls: 'sfc-dashboard-section' });
      sec.createEl('h3', { text: `New Notes (${newNoteCount} never reviewed)` });
      sec.createEl('p', {
        text: 'These notes haven\'t been reviewed yet. Open them and click "Mark as Reviewed" when done.',
        attr: { style: 'font-size:12px; color:var(--text-muted); margin:0;' },
      });
    }

    // ── Action buttons ──
    const actions = contentEl.createDiv({ cls: 'sfc-dashboard-actions' });

    const startCardsBtn = actions.createEl('button', {
      cls: 'sfc-start-btn primary',
      text: dueCards.length > 0 ? `Start Flashcard Review (${dueCards.length})` : 'No Cards Due',
    });
    if (dueCards.length > 0) {
      startCardsBtn.addEventListener('click', () => {
        this.close();
        new ReviewModal(this.app, this.plugin, dueCards).open();
      });
    } else {
      startCardsBtn.disabled = true;
      startCardsBtn.style.opacity = '0.5';
    }

    const startNotesBtn = actions.createEl('button', {
      cls: 'sfc-start-btn secondary',
      text: dueNotes.length > 0 ? `Review Notes (${dueNotes.length})` : 'No Notes Due',
    });
    if (dueNotes.length > 0) {
      startNotesBtn.addEventListener('click', async () => {
        this.close();
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(dueNotes[0]);
      });
    } else {
      startNotesBtn.disabled = true;
      startNotesBtn.style.opacity = '0.5';
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─────────────────────────────────────────────────────────────
// SETTINGS TAB
// ─────────────────────────────────────────────────────────────

class SmartFlashcardsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Smart Flashcards' });

    // Excluded Folders
    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('Notes in these folders are skipped for both flashcard and note-level review. One folder path per line (relative to vault root).');

    const textarea = containerEl.createEl('textarea', {
      attr: { rows: 6, style: 'width:100%; font-family:monospace; font-size:12px;' },
    });
    textarea.value = (this.plugin.settings.excludedFolders || []).join('\n');
    textarea.addEventListener('change', async () => {
      this.plugin.settings.excludedFolders = textarea.value
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
      await this.plugin.saveSettings();
    });

    // Default ease factor
    new Setting(containerEl)
      .setName('Default ease factor')
      .setDesc('Starting ease factor for new cards (recommended: 2.5).')
      .addText(text => text
        .setValue(String(this.plugin.settings.defaultEase || 2.5))
        .onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n >= 1.3) {
            this.plugin.settings.defaultEase = n;
            await this.plugin.saveSettings();
          }
        }));

    // Streak info (read-only)
    const streak = this.plugin.settings.reviewStreak || { count: 0, lastDate: '' };
    new Setting(containerEl)
      .setName('Review streak')
      .setDesc(`Current streak: ${streak.count} day${streak.count !== 1 ? 's' : ''}. Last review: ${streak.lastDate || 'never'}.`);
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN PLUGIN CLASS
// ─────────────────────────────────────────────────────────────

class SmartFlashcardsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.db = new SrsDatabase(this.app);
    await this.db.load();
    this.storage = new StorageManager(this.app, this);

    // Keep db in sync when notes are renamed
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.db.renameFile(oldPath, file.path))
    );

    // Register the sidebar panel view
    this.registerView(VIEW_TYPE, (leaf) => new FlashcardPanelView(leaf, this));

    // Settings tab
    this.addSettingTab(new SmartFlashcardsSettingTab(this.app, this));

    // Register hover link source so Obsidian knows about our previews
    // (users can toggle the mod-key requirement in Settings → Core plugins → Page preview)
    this.app.workspace.registerHoverLinkSource('smart-flashcards', {
      display: 'Smart Flashcards',
      defaultMod: true,
    });

    // Ribbon icon → open dashboard
    this.addRibbonIcon('layers', 'Smart Flashcards', () => {
      new DashboardModal(this.app, this).open();
    });

    // Status bar
    this._statusBarItem = this.addStatusBarItem();
    this._statusBarItem.setText('⚡ …');
    this._updateStatusBar();

    // ── Commands ──

    this.addCommand({
      id: 'open-dashboard',
      name: 'Open dashboard',
      callback: () => new DashboardModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'start-review',
      name: 'Start flashcard review',
      callback: async () => {
        const due = await this.storage.getAllDueCards();
        if (due.length === 0) {
          new Notice('No flashcards due — great job! 🎉');
          return;
        }
        new ReviewModal(this.app, this, due).open();
      },
    });

    this.addCommand({
      id: 'toggle-panel',
      name: 'Toggle flashcard panel',
      callback: () => this._togglePanel(),
    });

    this.addCommand({
      id: 'toggle-note-srs',
      name: 'Exclude / re-include current note from spaced repetition',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          if (fm.srs === false) {
            delete fm.srs;
            new Notice('Note re-included in spaced repetition.');
          } else {
            fm.srs = false;
            new Notice('Note excluded from spaced repetition.');
          }
        });
      },
    });

    this.addCommand({
      id: 'mark-note-reviewed',
      name: 'Mark current note as reviewed',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        await this._markNoteReviewed(file);
        new Notice('Note marked as reviewed ✓');
        this._updateStatusBar();
      },
    });

    // ── Event: show banner when due note is opened ──
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!file || file.extension !== 'md') return;
        this._checkNoteBanner(file);
      })
    );

    // Also check the file already open on load
    const currentFile = this.app.workspace.getActiveFile();
    if (currentFile) this._checkNoteBanner(currentFile);

    // ── Markdown post-processor: render inline cards and cloze markers ──
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (ctx.frontmatter?.srs === false) return;
      SmartFlashcardsPlugin._processInlineCardElements(el);
      SmartFlashcardsPlugin._processClozeElements(el);
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.app.workspace.unregisterHoverLinkSource('smart-flashcards');
    SmartFlashcardsPlugin._destroyHoverPopover();
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Update the status bar with due card count */
  async _updateStatusBar() {
    try {
      const counts = await this.storage.getDueCounts();
      const total = counts.cards + counts.notes;
      this._statusBarItem.setText(total > 0 ? `⚡ ${total} due` : '⚡ 0 due');
    } catch {
      this._statusBarItem.setText('⚡ —');
    }
  }

  /** Toggle the sidebar panel */
  async _togglePanel() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      existing[0].detach();
    } else {
      const leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  /** Check if the opened note is due and show a banner */
  async _checkNoteBanner(file) {
    if (this.storage.isNoteOptedOut(file)) return;

    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache || !cache.frontmatter) {
      // New note — show a softer nudge only occasionally (don't spam every open)
      return;
    }

    const srsDue = cache.frontmatter['srs-due'];
    if (!srsDue) return; // Never scheduled yet — no banner (would be too noisy)

    const dueDate = localDateFromStr(srsDue);
    const today = localToday();

    if (dueDate > today) return; // Not due yet

    // Show notice with action
    const frag = createFragment();
    const span = frag.createEl('span');
    span.setText('⏰ This note is due for review ');
    const btn = frag.createEl('a', { text: '[Mark as Reviewed]', href: '#' });
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      await this._markNoteReviewed(file);
      new Notice('Note marked as reviewed ✓');
      this._updateStatusBar();
    });

    new Notice(frag, 8000);
  }

  /** Schedule the next note review using fixed interval progression */
  async _markNoteReviewed(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const currentReps = (cache && cache.frontmatter && cache.frontmatter['srs-reps']) || 0;
    const newReps = currentReps + 1;
    const interval = SM2.noteInterval(newReps);
    await this.storage.updateNoteSRS(file, interval, newReps);
  }

  /** Called after a review session completes — update streak */
  async onReviewComplete() {
    const today = localDateStr(localToday());
    const streak = this.settings.reviewStreak;

    if (streak.lastDate === today) {
      // Already reviewed today, don't increment
    } else {
      const yDate = localToday();
      yDate.setDate(yDate.getDate() - 1);
      const yStr = localDateStr(yDate);
      streak.count = streak.lastDate === yStr ? streak.count + 1 : 1;
      streak.lastDate = today;
    }

    await this.saveSettings();
    this._updateStatusBar();
  }
}

// ── Hover popover (shared singleton) ──

SmartFlashcardsPlugin._hoverPopover = null;

SmartFlashcardsPlugin._getHoverPopover = function() {
  if (!SmartFlashcardsPlugin._hoverPopover) {
    const el = document.createElement('div');
    el.className = 'sfc-hover-popover';
    el.style.display = 'none';
    document.body.appendChild(el);
    SmartFlashcardsPlugin._hoverPopover = el;
  }
  return SmartFlashcardsPlugin._hoverPopover;
};

/**
 * Show the hover popover anchored below anchorEl.
 * content: either a plain string, or { front, arrow, back } for card layout.
 */
SmartFlashcardsPlugin._showHoverPopover = function(anchorEl, label, content) {
  const popover = SmartFlashcardsPlugin._getHoverPopover();
  popover.innerHTML = '';

  if (label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'sfc-hover-label';
    labelEl.textContent = label;
    popover.appendChild(labelEl);
  }

  if (typeof content === 'string') {
    const contentEl = document.createElement('div');
    contentEl.className = 'sfc-hover-content';
    contentEl.textContent = content;
    popover.appendChild(contentEl);
  } else {
    // Card layout: { front, arrow, back }
    const cardEl = document.createElement('div');
    cardEl.className = 'sfc-hover-card';
    const frontEl = document.createElement('span');
    frontEl.className = 'sfc-hover-front';
    frontEl.textContent = content.front;
    const arrowEl = document.createElement('span');
    arrowEl.className = 'sfc-hover-arrow';
    arrowEl.textContent = content.arrow;
    const backEl = document.createElement('span');
    backEl.className = 'sfc-hover-back';
    backEl.textContent = content.back;
    cardEl.appendChild(frontEl);
    cardEl.appendChild(arrowEl);
    cardEl.appendChild(backEl);
    popover.appendChild(cardEl);
  }

  popover.style.display = 'block';
  const rect = anchorEl.getBoundingClientRect();
  popover.style.left = `${rect.left}px`;
  popover.style.top = `${rect.bottom + 6}px`;
};

SmartFlashcardsPlugin._hideHoverPopover = function() {
  if (SmartFlashcardsPlugin._hoverPopover) SmartFlashcardsPlugin._hoverPopover.style.display = 'none';
};

SmartFlashcardsPlugin._destroyHoverPopover = function() {
  if (SmartFlashcardsPlugin._hoverPopover) {
    SmartFlashcardsPlugin._hoverPopover.remove();
    SmartFlashcardsPlugin._hoverPopover = null;
  }
};

SmartFlashcardsPlugin._processInlineCardElements = function(el) {
  // Walk text nodes; skip anything inside code, pre, or already-processed spans
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest('code, pre, .sfc-inline-card')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  for (const textNode of textNodes) {
    const text = textNode.textContent;
    if (!/[({].+?\s:::?\s.+?[)}]/.test(text)) continue;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    // Capture: open-bracket, front, sep (:: or :::), back, close-bracket
    const regex = /([({])((?:(?!\s:::?\s).)+?)\s(:::?)\s((?:(?![)}\n]).)+?)([)}])/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const [fullMatch, open, front, sep, back, close] = m;
      if ((open === '(' && close !== ')') || (open === '{' && close !== '}')) continue;

      // Text before this match
      if (m.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      }

      const displayMode = open === '(' ? 'hide-back' : 'hide-front';

      const span = document.createElement('span');
      span.className = 'sfc-inline-card';
      span.dataset.display = displayMode;

      const mkHidden = (t) => { const s = document.createElement('span'); s.className = 'sfc-inline-hidden'; s.textContent = t; return s; };
      const mkFront  = () => { const s = document.createElement('span'); s.className = 'sfc-inline-front'; s.textContent = front.trim(); return s; };
      const mkSep    = () => { const s = document.createElement('span'); s.className = 'sfc-inline-sep'; s.textContent = ` ${sep} `; return s; };
      const mkBack   = () => { const s = document.createElement('span'); s.className = 'sfc-inline-back'; s.textContent = back.trim(); return s; };

      const frontEl = mkFront();
      const backEl = mkBack();

      span.appendChild(mkHidden(open));
      span.appendChild(frontEl);
      span.appendChild(mkSep());
      span.appendChild(backEl);
      span.appendChild(mkHidden(close));

      // Hover preview: show both sides with directional arrow
      const arrow = sep === ':::' ? '↔' : '→';
      span.addEventListener('mouseenter', () => SmartFlashcardsPlugin._showHoverPopover(
        span, null, { front: front.trim(), arrow, back: back.trim() }
      ));
      span.addEventListener('mouseleave', SmartFlashcardsPlugin._hideHoverPopover);

      frag.appendChild(span);
      lastIdx = m.index + fullMatch.length;
    }

    if (lastIdx === 0) continue; // no matches in this text node
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
};

/**
 * DOM Range-based cloze processor.
 *
 * Finds =-= marker text nodes across the rendered DOM (including across
 * HTML elements like <strong>, <a>, etc.), wraps the content between each
 * opening/closing pair in a span with the given class, and strips the markers.
 *
 * Works whether cloze content is plain text or rendered markdown.
 */
/**
 * Apply a cloze class to an element after _renderMd has run.
 *
 * Our post-processor (_processClozeElements) runs during MarkdownRenderer.render()
 * and converts =-= markers into .sfc-cloze-reading spans before we can act on them.
 * This helper reclassifies those spans to the target class (stripping the hover
 * listeners by cloning), then falls back to _applyClozeDOM for any raw markers
 * that weren't yet processed.
 */
SmartFlashcardsPlugin._applyClozeCls = function(el, cls) {
  const existing = el.querySelectorAll('.sfc-cloze-reading');
  if (existing.length > 0) {
    existing.forEach(s => { const c = s.cloneNode(true); c.className = cls; s.replaceWith(c); });
  } else {
    SmartFlashcardsPlugin._applyClozeDOM(el, cls);
  }
};

SmartFlashcardsPlugin._applyClozeDOM = function(el, cls) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest('code, pre')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Collect all =-= marker positions across text nodes
  const markers = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    let idx = 0;
    while ((idx = text.indexOf('=-=', idx)) !== -1) {
      markers.push({ node, offset: idx });
      idx += 3;
    }
  }

  // Pair markers and process in reverse order to preserve earlier positions
  const pairCount = Math.floor(markers.length / 2);
  for (let p = pairCount - 1; p >= 0; p--) {
    const open = markers[p * 2];
    const close = markers[p * 2 + 1];

    // Range spans from end of opening =-= to start of closing =-=
    const range = document.createRange();
    range.setStart(open.node, open.offset + 3);
    range.setEnd(close.node, close.offset);

    const span = document.createElement('span');
    span.className = cls;
    span.appendChild(range.extractContents());
    range.insertNode(span);

    // Strip the =-= marker from the adjacent text nodes
    const prev = span.previousSibling;
    if (prev?.nodeType === Node.TEXT_NODE && prev.textContent.endsWith('=-=')) {
      prev.textContent = prev.textContent.slice(0, -3);
    }
    const next = span.nextSibling;
    if (next?.nodeType === Node.TEXT_NODE && next.textContent.startsWith('=-=')) {
      next.textContent = next.textContent.slice(3);
    }
  }
};

SmartFlashcardsPlugin._processClozeElements = function(el) {
  SmartFlashcardsPlugin._applyClozeDOM(el, 'sfc-cloze-reading');

  // Add hover preview to each newly created cloze span
  el.querySelectorAll('.sfc-cloze-reading').forEach(span => {
    const clozeText = span.textContent;
    span.addEventListener('mouseenter', () => SmartFlashcardsPlugin._showHoverPopover(span, 'Cloze', `_____ → ${clozeText}`));
    span.addEventListener('mouseleave', SmartFlashcardsPlugin._hideHoverPopover);
  });
};

module.exports = SmartFlashcardsPlugin;
