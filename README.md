# Smart Flashcards

An [Obsidian](https://obsidian.md) plugin for spaced repetition directly inside your notes. Write flashcards in plain Markdown, review them with SM-2 scheduling, and track note-level review cadence — all without leaving Obsidian. Works on iOS and desktop.

---

## Features

- **Four card types**: basic, bidirectional, cloze, and inline
- **SM-2 algorithm** with Again / Hard / Good / Easy ratings
- **Inline cards** rendered in Reading mode (no separate file needed)
- **Note-level review**: schedule whole-note reviews alongside individual cards
- **Sidebar panel**: see all cards for the active note at a glance
- **Dashboard**: cards and notes due today, review streaks
- **Hover previews** for `[[wikilinks]]` inside the review modal
- **No build step** — single vanilla JS file, no Node.js required

---

## Installation

1. Copy `manifest.json`, `main.js`, and `styles.css` into:
   ```
   <vault>/.obsidian/plugins/smart-flashcards/
   ```
2. In Obsidian: **Settings → Community plugins → Installed plugins** → enable **Smart Flashcards**.

---

## Card Syntax

### Basic (single-directional)

```
Capital of France :: Paris
```

Shows "Capital of France" on the front; "Paris" revealed on flip. Spaces around `::` are required.

### Bidirectional

```
mitochondria ::: powerhouse of the cell
```

Creates **two** cards — one in each direction. Use `:::` (three colons).

### Cloze deletion

```
The =-=mitochondria=-= is the powerhouse of the cell.
```

The `=-=` delimiters hide the enclosed text. During review the blank is shown as `[...]`; flipping reveals the answer. The `=-=` delimiter was chosen to avoid conflict with Obsidian's `==highlight==` syntax.

Multiple blanks on the same line are all hidden together:

```
=-=ATP=-= is produced in the =-=mitochondria=-=.
```

### Inline cards (embedded in prose)

Inline cards live inside normal sentences and are rendered interactively in Reading mode.

| Syntax | Reading mode | Tests |
|---|---|---|
| `(Term :: Definition)` | Term underlined | Recall the definition |
| `{Definition :: Term}` | Definition underlined | Recall the term |
| `(Term ::: Definition)` | Term underlined | Both directions |

**Example note:**

```markdown
The (nucleus :: control center of the cell) directs all cellular activity.
A {selectively permeable membrane :: cell membrane} surrounds every cell.
```

In Reading mode this renders as:

> The **nucleus** directs all cellular activity.
> A **selectively permeable membrane** surrounds every cell.

Clicking the underlined text flips to show the hidden side.

---

## Data Storage

SRS data is stored in frontmatter so it travels with the note and syncs via Obsidian Sync:

```yaml
---
sfc-cards:
  "Capital of France": { d: "2026-03-08", i: 6, e: 2.5, r: 2 }
  "mitochondria ::: powerhouse of the cell": { d: "2026-03-10", i: 6, e: 2.6, r: 2 }
  "mitochondria ::: powerhouse of the cell__back": { d: "2026-03-12", i: 6, e: 2.5, r: 2 }
  "The =-=mitochondria=-= is the powerhouse of the cell.": { d: "2026-03-09", i: 3, e: 2.4, r: 1 }
---
```

Note-level review fields also live in frontmatter:

```yaml
---
srs-due: 2026-03-15
srs-interval: 14
srs-reps: 3
---
```

To **opt a note out** of the review queue entirely:

```yaml
---
srs: false
---
```

---

## Reviewing

### Via Dashboard (all due cards & notes)

Open the command palette and run **Smart Flashcards: Open Dashboard**, or click the ⚡ ribbon icon. The dashboard shows:

- Cards due today (grouped by note)
- Notes due for whole-note review
- New notes not yet scheduled
- Current review streak

### Via sidebar panel (current note only)

Run **Smart Flashcards: Toggle panel** to open the right-sidebar panel. It lists every card in the active note with its due date. Click **Review N due** to start a review session scoped to that note.

### Rating buttons

During review, four buttons appear after flipping:

| Button | Meaning | Effect |
|---|---|---|
| Again | Forgot completely | Resets interval to 1 day |
| Hard | Recalled with difficulty | Slight interval increase, ease decreases |
| Good | Recalled correctly | Standard SM-2 interval increase |
| Easy | Recalled effortlessly | Larger interval, ease increases |

The next due date is previewed on each button before you rate.

---

## Note-Level Review

Every note is automatically included in the review queue unless opted out. When you open a note that is due, a banner notice appears with a one-click **Mark as Reviewed** action.

The review interval follows a fixed progression based on rep count:

| Rep | Next interval |
|---|---|
| 1st review | 1 day |
| 2nd | 3 days |
| 3rd | 7 days |
| 4th | 14 days |
| 5th | 30 days |
| 6th | 60 days |
| 7th+ | 90 days |

---

## Settings

**Settings → Smart Flashcards**

| Setting | Default | Description |
|---|---|---|
| Excluded folders | `Resources`, `Resources/Templates`, `Readwise` | Comma-separated paths; notes in these folders are never scheduled |
| Default ease | 2.5 | Starting ease factor for new cards |

---

## Commands

| Command | Description |
|---|---|
| Open Dashboard | Show the review dashboard modal |
| Start review | Begin reviewing all due cards across the vault |
| Toggle panel | Open/close the sidebar card panel |
| Exclude note from spaced repetition | Sets `srs: false` on the active note |
| Mark note as reviewed | Advances the note's SRS interval immediately |

---

## Complete Example Note

````markdown
---
tags: [biology]
---

# Cell Biology

The =-=nucleus=-= is the control center of the cell.

Cells are the basic unit of life :: True

The cell membrane is selectively permeable ::: selectively permeable membrane

Organelles:
- The (mitochondria :: powerhouse of the cell) produces ATP via cellular respiration.
- The {rough ER :: studded with ribosomes, synthesizes proteins} is connected to the nuclear envelope.
- =-=Ribosomes=-= translate mRNA into proteins.
````

This single note produces:
- 1 cloze card (`nucleus`)
- 1 basic card (`Cells are the basic unit of life`)
- 2 cards from the bidirectional (`cell membrane ↔ selectively permeable membrane`)
- 2 inline cards (one `(hide-back)`, one `{hide-front}`)
- 1 cloze card (`Ribosomes`)

---

## File Structure

```
.obsidian/plugins/smart-flashcards/
├── manifest.json
├── main.js         (~1300 lines, vanilla JS, no build step)
└── styles.css
```
