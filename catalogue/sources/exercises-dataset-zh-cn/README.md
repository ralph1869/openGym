# Simplified Chinese instruction provenance (personal fork)

This personal fork imports only the `records[id].steps` text from
[muxuezzz/exercises-dataset-zh-cn](https://github.com/muxuezzz/exercises-dataset-zh-cn/blob/a58b790ea0d8c145b85b18dd2ed35ce504dc6699/locales/zh-CN.js)
at commit `a58b790ea0d8c145b85b18dd2ed35ce504dc6699`. The upstream repository declares
these translations MIT-licensed; its full [LICENSE](LICENSE), including the media
exception, is retained unchanged. This is a user-authorized import for the personal
fork, not a contribution proposed to upstream openGym under its original-text rule.

The import updates `catalogue/i18n/zh.json` by exact existing exercise ID. It
copies no community names, descriptions, UI labels, identifiers or media. The
source file was read as text, the `records` object decoded as JSON, and its fixed
SHA-256 checked; no community JavaScript or tooling was executed. [source.json](source.json)
records the pinned file hash, license hash and a canonical hash of the original
imported ID/step pairs. Two reviewed step-level clarifications (`0198` step 6 and
`0489` step 3) are recorded there with their original text, replacement and reason;
reversing only those declared edits reproduces the exact original import hash. The 1,324 IDs match the frozen v1.3 catalogue exactly and provide
7,662 steps. The community README reports two complete reviews against English;
our checks verify IDs, step completeness, Han text and exact import fidelity,
not an independent manual review of every exercise.

## Routine exercise coverage

The standard IDs below come from the previously verified push/pull/legs plan
readout, not a new production read. No routine or workout data is changed by
this catalogue update.

| Plan | Standard exercise IDs |
| --- | --- |
| Push | `1030`, `0178` |
| Pull | `0198`, `0861`, `0602`, `0294`, `0489` |
| Legs | `3593`, `0585`, `0598`, `0597`, `0489` |

All 11 distinct standard exercises have a bilingual description in the Chinese
locale: a Chinese translation followed by the verbatim current English catalogue
description, separated by a blank line and explicit `中文：` / `English:` labels.
The existing `.exnote` style preserves those line breaks. English-locale source
text remains unchanged.

The community data covers nine of these IDs. The missing instructions for `1030`
(lever pec deck fly) and `3593` (barbell squat) are local Chinese translations of
their own existing English catalogue steps, not steps borrowed from a different
exercise. There are now 1,326 Chinese instruction entries; the other 4,306 visible
exercises retain the existing per-exercise English fallback. Descriptions outside
the 11 standard IDs also retain that fallback.

The four unresolved custom movements (seated chest press machine, fixed machine
shoulder press, low-angle press, and prone dumbbell row) are deliberately not mapped
to catalogue exercises. Their exact setup/variant still needs confirmation before
writing movement-specific text. Neither their IDs nor their stored descriptions
or steps are touched. Names, media links, existing routine/history references and
all English exercise sources remain unchanged.

## Rebuild and checks

Edit catalogue sources, then run the existing generator; generated packs must not
be edited directly:

```sh
node scripts/catalogue/validate.mjs
node scripts/catalogue/build.mjs
node scripts/catalogue/build.mjs --check
cd frontend
npx vitest run src/lib/zh-instructions.test.js src/lib/catalogue-continuity.test.js src/lib/i18n-core.test.js src/lib/i18n-details-lang.test.js src/lib/i18n-details-retry.test.js
npm run build
```

The Simplified Chinese regression test checks the original pinned imported-step hash
after reversing only the declared local wording clarifications,
coverage of the standard plan IDs, paired descriptions, English-language switching,
per-exercise fallback and preservation of custom text. To update the community
version, review its text license again, pin the new commit/file hash, import only
known exact IDs and update this provenance together with the catalogue.
