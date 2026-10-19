# Local acceptance — 2026-10-19

Branch: `feat/cloudflare-d1`; base HEAD: `4596881ec06ac722fb9094e4398cf0630dabe33d`.
This record covers local validation before the separately authorized publication.
No production training data, D1 schema, MCP switch, callback or authorization scope
is changed by this work.

## Data and preservation checks

- The downloaded JavaScript was treated only as text. Its `records` object was
  decoded as JSON; no community code was run. Only text files were downloaded.
- All 1,324 community IDs exactly match the frozen v1.3 exercise IDs. Every
  imported step array equals `records[id].steps` at the pinned source after reversing
  only the two explicitly recorded step wording clarifications in `source.json`.
- 7,662 community steps plus 10 locally translated steps give 7,672 steps across
  1,326 exercises. The source and license hashes are recorded in `source.json`.
- All 5,632 Chinese names and all locale keys match base HEAD. A field-level diff
  reports zero name changes, 1,303 changed instruction entries (including the two
  new local translations), and 11 new descriptions; some community lists already
  matched the previous translation exactly.
- No English exercise source, ID, alias, media path, media file, generated name
  pack, exercise index, production routine, history, auth or callback code changed.
- Standard plan IDs come from the previous verified plan readout. No fresh live
  plan read was required or claimed. The four unresolved custom movements remain
  outside this catalogue translation change.

## Passing commands

- `node scripts/catalogue/validate.mjs`: 6,554 entries accepted, including hidden
  drawing aliases; 5,632 visible exercises.
- `node scripts/catalogue/build.mjs`: generated only the updated instruction pack
  and new Chinese description pack; coach regeneration produced no diff.
- `node scripts/catalogue/build.mjs --check`: generated files current.
- Final full frontend run: `TZ=UTC npm test -- --maxWorkers=4`: **405 files,
  5,093 tests passed**, matching the existing Cloudflare CI timezone/worker settings.
  A default-parallel diagnostic in the host Asia/Shanghai timezone had two hook
  timeouts and three date failures; limiting workers removed both timeouts, and
  UTC resolved all three date assertions without changing their source code.
- Targeted Vitest run: **5 files, 65 tests passed** (`zh-instructions`,
  `catalogue-continuity`, `i18n-core`, `i18n-details-lang`, `i18n-details-retry`).
  Checks include exact imported-step hash, paired descriptions, English switching,
  untranslated-exercise fallback, and preservation of custom names/steps/descriptions.
- `cd frontend && node scripts/check-locales.mjs`: 18 locales, 2,258 keys each in sync.
- `cd frontend && npm run build`: passed, including the new Chinese description
  lazy chunk. Vite reports dynamic/static import overlap and large-chunk warnings;
  neither fails the build and neither was changed by this data-only work.
- Cloudflare build: passed. The exact community LICENSE, provenance README and
  source metadata are included in the static assets alongside the root notices.
- `cd cloudflare && npm test`: **45 tests passed**, including byte preservation
  for 6,554 stills / 6,554 clips, new license/provenance routes, state protection,
  authentication, and preservation of Dashboard-owned MCP variables.
- `cd cloudflare && npm run check`: deploy dry-run passed.
- `git diff --check`: passed.

## Browser acceptance limit

A local demo server was used with production API and media access disabled.
Before the user's browser preference arrived, cmux reached the language picker;
all cmux interaction stopped immediately after the user requested Ego Lite.
This does not count as completed exercise-detail display acceptance.

Ego Lite 0.6.0.12 is installed and its standard AppleScript interface is readable
while it remains in the background. That dictionary exposes windows/tabs, not
Space objects. Its File menu has “新建空间”; after trying that menu once, the
background accessibility interface could not address `window 1` (error -1719)
or enumerate a window tree. Creation of an isolated Space and visual detail-page
verification therefore remain unconfirmed. No foreground activation or interaction
with existing user tabs was performed. No substitute cmux workflow was resumed.

Automated checks verify the content shown by the existing `instrFor`/`descFor`
readers in Chinese, English and fallback cases. `.exnote` already uses
`white-space: pre-wrap`, so the explicit bilingual labels and blank line need no
UI code change. A final rendered-detail check in the user's requested isolated
Ego Lite Space remains outstanding; production login is not a blocker for this
local code implementation.

## Language review and browser support checks

See [LANGUAGE-REVIEW.md](LANGUAGE-REVIEW.md) for all 11 exact ID/name pairs,
the last-verified plan references, sentence-level description review, all ten
locally translated steps and the focused comparison of 50 imported plan steps.
Two community wording ambiguities were clarified and declared in `source.json`;
the original source hash is still reproducible after reversing only those edits.
The other imported steps received structural/integrity checks, not a full
independent professional audit.

Supported browser routes examined without installation or security changes:

- Installed app metadata: Ego Lite 0.6.0.12, bundle ID
  `com.citrolabs.ego.lite`, official `scripting.sdef`. It exposes application,
  window, tab and bookmark classes and standard JavaScript `execute`, but no
  Space class or Space management command.
- Existing macOS AppleScript app access works in the background. System Events
  menu access works, and the File menu includes “新建空间”. One attempt to use it
  could not be followed by a window tree: `System Events` returned
  `不能获得 window 1 of process ego lite。无效的索引。 (-1719)`. Subsequent
  bundle-ID-targeted System Events reads found the process in the background with
  zero accessible windows, while the app's own scripting interface could list a
  visible window. No foreground activation was attempted.
- The bundled `.manifest` is a Chromium managed-preference schema, not an
  automation/Space API. The app declares an `ego:` launch URL scheme but provides
  no documented Space routes in the inspected metadata; no route was guessed.
- No Ego/IAB/browser-control or plugin-discovery tool is exposed in this session.
  `open_in_codex` opens a Codex panel and does not control an Ego Space.
- No `ego`, `ego-lite`, `egolite` or `iab` CLI is on PATH. A generic Playwright CLI
  exists, but the already-running Ego process exposes no listening TCP control
  endpoint (`lsof -nP -a -p <Ego PID> -iTCP -sTCP:LISTEN` returned no rows).
  Remote debugging was not enabled and no security preference was changed.

These checks do not establish that Ego Lite has no possible automation globally;
they establish that a usable isolated background Space control route was not
available through this session's inspected interfaces. Space creation and
rendered production acceptance remain unconfirmed until a supported route or
normal user-assisted authentication/UI handoff is available.
