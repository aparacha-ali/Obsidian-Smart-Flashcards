# Smart Flashcards — Plugin Reference

Custom Obsidian spaced repetition plugin. Single-file vanilla JS, no build step.
Works on iOS (`isDesktopOnly: false`).

## File Structure

```
.obsidian/plugins/smart-flashcards/
├── manifest.json   — plugin metadata
├── main.js         — all plugin code (~1300 lines, vanilla JS)
├── styles.css      — all UI styles
└── CLAUDE.md       — this file
```

Companion note: `📚 Review Dashboard.md` (DataviewJS, vault root)

---

## Card Syntax

### Standalone cards (own line)

| Type | Syntax | Notes |
|------|--------|-------|
| Single-directional | `Front :: Back` | Spaces required around `::` |
| Bidirectional | `Front ::: Back` | Creates two review cards |
| Cloze | `Sentence with =-=hidden=-= text` | `=-=` chosen to avoid `==highlight==` conflict |

### Inline cards (embedded in prose)

| Syntax | Reading mode shows | Use case |
|--------|-------------------|----------|
| `(Q :: A)` | `Q` underlined, A hidden | Term in prose, test the definition |
| `{Q :: A}` | `A` underlined, Q hidden | Definition in prose, test the term |
| `(Q ::: A)` / `{Q ::: A}` | Same but bidirectional | |

**Inline cards also support `:::` for bidirectional.**

---

## Data Storage

### Standalone card SRS data — inline comment, line immediately after card
```
Capital of France :: Paris
<!--SFC:{"d":"2026-03-01","i":3,"e":2.5,"r":2}-->
```
Fields: `d`=due date (ISO), `i`=interval (days), `e`=ease factor, `r`=rep count.

Bidirectional stores both directions in one comment:
```
<!--SFC:{"f":{"d":"...","i":3,"e":2.5,"r":2},"b":{"d":"...","i":1,"e":2.5,"r":0}}-->
```

### Inline card SRS data — frontmatter `sfc-cards` object
```yaml
sfc-cards:
  "Capital of France": { d: "2026-03-01", i: 3, e: 2.5, r: 2 }
  "powerhouse of the cell__back": { d: "2026-03-02", i: 1, e: 2.5, r: 0 }
```
Key = front text. Bidirectional back direction uses `front + '__back'` as key.
`displayMode` (`hide-back`/`hide-front`) is NOT stored — re-derived from syntax (`(` vs `{`) at parse time.

### Note-level SRS data — frontmatter fields
```yaml
srs: false      # opt-out (all notes included by default unless this is false)
srs-due: 2026-03-01
srs-interval: 7
srs-reps: 3
```
Uses `srs-` prefix (distinct from old SR plugin's `sr-` fields).

### Plugin settings — `data.json`
```json
{
  "excludedFolders": ["Resources", "Resources/Templates", "Readwise"],
  "defaultEase": 2.5,
  "reviewStreak": { "count": 0, "lastDate": "" }
}
```

---

## Architecture (main.js)

### Constants / top-level
- `VIEW_TYPE = 'smart-flashcards-panel'`
- `SFC_PREFIX = '<!--SFC:'`, `SFC_SUFFIX = '-->'`
- `NOTE_INTERVALS = [1,3,7,14,30,60,90]` — fixed note-review progression
- `DEFAULT_SETTINGS` — default plugin settings object

### `SM2` (plain object)
SM-2 spaced repetition algorithm.
- `SM2.review(srsData, quality)` → new srsData. Quality: 0=Again, 2=Hard, 4=Good, 5=Easy
- `SM2.isDue(srsData)` → boolean (true if null/no date, or date ≤ today)
- `SM2.getDueDate(srsData)` → Date | null
- `SM2.previewIntervals(srsData)` → `{ again, hard, good, easy }` days
- `SM2.noteInterval(reps)` → days from `NOTE_INTERVALS`

### `CardParser` (plain object)
- `CardParser.parseCards(content, inlineSrsMap = {})` → `ParsedCard[]`
  - Strips frontmatter, `%%...%%` blocks, fenced code blocks before scanning
  - Checks inline patterns **first** on each line; if found, skips standalone check for that line
  - `ParsedCard` shape: `{ type, front, back, lineIndex, charIndex?, isInline, displayMode?, srsData, srsDataForward, srsDataBack }`
- `CardParser._matchInlineCards(line)` → inline card matches
- `CardParser._matchBasic(line)`, `_matchBidirectional(line)`, `_matchCloze(line)`
- `CardParser.renderClozeFront(text)` → HTML with `<span class="sfc-cloze-blank">`
- `CardParser.renderClozeBack(text)` → HTML with `<span class="sfc-cloze-blank revealed">`
- `CardParser._parseSfcComment(line)` → parsed JSON object or null

### `StorageManager` (class)
- `isExcluded(filePath)` — checks against `settings.excludedFolders`
- `isNoteOptedOut(file)` — excluded folder OR `srs: false` frontmatter
- `updateCardSRS(file, lineIndex, newSrsData)` — writes/replaces `<!--SFC:-->` comment
- `updateInlineCardSRS(file, frontText, newSrsData, direction)` — writes to `sfc-cards` frontmatter
- `updateNoteSRS(file, interval, reps)` — writes `srs-due/interval/reps` frontmatter
- `getAllDueCards()` — scans all vault files; passes `inlineSrsMap` from metadata cache to `parseCards`
- `getAllDueNotes()` — files with `srs !== false` and `srs-due <= today`
- `countNewNotes()` — eligible notes with no `srs-due` yet
- `getDueCounts()` → `{ cards: N, notes: M }`

### `FlashcardPanelView` (extends ItemView)
View type: `'smart-flashcards-panel'`. Sidebar showing cards for the active note.
- Updates on `active-leaf-change` and `vault.modify` events
- Gets `inlineSrsMap` from metadata cache before calling `parseCards`
- Each card row: type icon (→/↔/[c]), truncated front, due-date pill
- "Review N due" button launches `ReviewModal` scoped to this file

### `ReviewModal` (extends Modal)
- `body.classList.add('sfc-review-open')` on open (for z-index fix)
- `async _render()` — main render, calls `_renderFront` or `_renderBack`
- `async _renderMd(el, text, file)` — uses `MarkdownRenderer.render()` + attaches hover-link listeners for `[[wikilink]]` previews
- `_wikilinksToText(text)` — strips `[[links]]` to display text (used for cloze innerHTML)
- `async _rate(quality)` — branches on `card.isInline` to call the right storage method
- Shows Again/Hard/Good/Easy buttons with preview intervals

### `DashboardModal` (extends Modal)
Home page. Shows card due counts grouped by note, notes due, new notes, streak.
Buttons launch `ReviewModal` (cards) or open first due note (notes).

### `SmartFlashcardsSettingTab` (extends PluginSettingTab)
Settings: excluded folders (textarea), default ease, streak info (read-only).

### `SmartFlashcardsPlugin` (extends Plugin, main class)
- `onload()`: registers view, settings tab, ribbon, status bar, commands, events, hover source, post-processor
- `onunload()`: detaches panel leaves, unregisters hover source
- Commands: `open-dashboard`, `start-review`, `toggle-panel`, `toggle-note-srs`, `mark-note-reviewed`
- `_updateStatusBar()` — async, updates `⚡ N due` count
- `_togglePanel()` — open/close right sidebar leaf
- `_checkNoteBanner(file)` — shows `⏰ due` Notice with inline "Mark as Reviewed" link
- `_markNoteReviewed(file)` — increments reps, computes next interval, writes frontmatter
- `onReviewComplete()` — updates review streak in settings
- `SmartFlashcardsPlugin._processInlineCardElements(el)` (static) — the markdown post-processor implementation; walks text nodes and replaces inline card syntax with styled `<span>` elements

---

## Key CSS Classes (styles.css)

| Class | Purpose |
|-------|---------|
| `.sfc-panel` | Sidebar panel container |
| `.sfc-card-row` | Single card row in panel |
| `.sfc-due-pill` | Colored pill: `.new` `.due-today` `.overdue` `.upcoming` |
| `.sfc-review-modal` | Review modal wrapper |
| `.sfc-card-front-display` | Card front in review (add `.dimmed` when showing back) |
| `.sfc-card-back-display` | Card back in review |
| `.sfc-rating-btn` | Rating buttons: `.again` `.hard` `.good` `.easy` |
| `.sfc-dashboard-modal` | Dashboard modal wrapper |
| `.sfc-inline-card` | Inline card span in rendered markdown |
| `.sfc-inline-front` / `.sfc-inline-back` | The two sides of an inline card |
| `.sfc-inline-hidden` | Hidden bracket chars |
| `.sfc-inline-sep` | Hidden ` :: ` separator |
| `body.sfc-review-open .popover` | z-index fix so hover previews appear above the review modal |

`[data-display="hide-back"]` on `.sfc-inline-card` hides `.sfc-inline-back` and underlines `.sfc-inline-front`.
`[data-display="hide-front"]` does the reverse.

---

## Hover Previews in Review Modal

Registered source: `'smart-flashcards'` with `defaultMod: true` (Cmd/Ctrl required by default, configurable in Obsidian's Page Preview settings).

In `_renderMd()`, after `MarkdownRenderer.render()`, all `a.internal-link` elements get a `mouseover` listener that fires `app.workspace.trigger('hover-link', { source: 'smart-flashcards', ... })`.

`body.sfc-review-open` class is added/removed by `ReviewModal.onOpen/onClose` to lift `.popover` z-index above the modal backdrop.

---

## Note-Level SR Behaviour

- **Default**: every note is in the SR queue (no opt-in needed)
- **Opt out**: `srs: false` in frontmatter, or run command "Exclude note from spaced repetition"
- **Excluded folders**: configured in plugin settings, checked by `StorageManager.isExcluded()`
- **New notes** (no `srs-due`): shown in Dashboard "New Notes" section; not in the due queue
- **First review**: sets `srs-reps: 1`, `srs-interval: 1`, `srs-due: tomorrow`
- **Subsequent reviews**: fixed interval progression via `SM2.noteInterval(reps)`
- **Banner**: shown via `Notice` (8 s) when a due note is opened; click "Mark as Reviewed" to advance

---

## Extending / Debugging

- All plugin errors are logged as `console.warn('Smart Flashcards: ...')`
- To reload after editing `main.js`: Settings → Community plugins → toggle off/on
- The developer console (`Cmd+Option+I`) shows any runtime errors
- `CardParser.parseCards()` can be called standalone in the console for testing:
  ```js
  // In Obsidian developer console:
  const file = app.workspace.getActiveFile();
  const content = await app.vault.read(file);
  // Access the plugin instance:
  const plugin = app.plugins.plugins['smart-flashcards'];
  // CardParser is module-scoped, but you can inspect via:
  plugin.storage.getAllDueCards().then(console.log);
  ```
