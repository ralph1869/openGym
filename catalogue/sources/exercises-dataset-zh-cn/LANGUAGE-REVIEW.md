# Language and plan-reference review — 2026-10-19

This is an assistant language-consistency review against the existing English
catalogue, not an independent professional coaching or medical audit. It changes
catalogue text only. No production plan or training record was edited.

## Plan reference evidence

The mapping below uses the plan readout verified on 2026-10-18. It is not a fresh
production read; no claim is made that the user has not changed a plan since then.
The catalogue IDs remain unchanged, so the same references continue to resolve.

| Routine | ID | Standard references in plan order | Unresolved custom movements |
| --- | --- | --- | --- |
| 推｜练三休一 | `mvand3hglgq0r` | `1030`, `0178` | seated chest press machine; fixed machine shoulder press; low-angle press |
| 拉｜练三休一 | `mvaq27vlw3fhq` | `0198`, `0861`, `0602`, `0294`, `0489` | prone dumbbell row |
| 腿｜练三休一 | `mvaq5au1jd6n1` | `3593`, `0585`, `0598`, `0597`, `0489` | none |

There are 12 standard movement slots and 11 distinct standard IDs because `0489`
is shared by pull and legs. `3593` is the actual known barbell-squat reference;
it is not substituted with `0043` or another squat. The custom movements have
not been assigned guessed IDs, setups, load meanings, angles or instructions.

## Eleven bilingual descriptions

Each Chinese description was compared sentence by sentence with the English
source. Its `English:` paragraph is the verbatim catalogue description, checked
by automated tests. No weight, set, rep, injury-treatment or extra safety claim
is added. Existing translated names are retained exactly as listed here.

| ID | Existing Chinese name | Canonical English name | Meaning checked |
| --- | --- | --- | --- |
| `0178` | 绳索侧平举 | cable lateral raise | standing position, outward arm lift, constant cable tension, side delts, broader-shoulder aim |
| `0198` | 绳索下拉 | cable pulldown | seated wide-bar pulldown toward chest, lats and muscles around shoulder blades |
| `0294` | 哑铃二头弯举 | dumbbell biceps curl | standard standing curl, both weights rise, upper arms remain still |
| `0489` | 山羊挺身 | hyperextension | bench-supported torso lowering/raising, lower back, glutes and hamstrings |
| `0585` | 杠杆腿屈伸 | lever leg extension | seated machine leg extension against pad, quadriceps |
| `0597` | 杠杆坐姿髋外展 | lever seated hip abduction | seated machine, knees pushed apart against pads, outer hips and glutes |
| `0598` | 杠杆坐姿髋内收 | lever seated hip adduction | seated machine, knees squeezed together against pads, inner thighs |
| `0602` | 杠杆坐姿反向飞鸟 | lever seated reverse fly | chest supported on pad, handles move back/out in a wide arc, rear delts and upper back |
| `0861` | 绳索坐姿划船 | cable seated row | seated cable handles pulled toward torso, back and biceps; no invented grip variant |
| `1030` | 杠杆蝴蝶机夹胸 | lever pec deck fly | machine fly, arms sweep together in front, chest isolation |
| `3593` | 杠铃深蹲 | barbell squat | classic barbell squat, thigh and hip strength |

All eleven Chinese/English description pairs retain the source meaning at this
language-review level. The broader-shoulder wording in `0178` translates the
English purpose, not an additional guarantee of a training outcome.

## Two locally supplemented instruction lists

These two IDs are absent from the pinned community dataset. Their steps were
translated from their own current English records; no related exercise was used.

### `1030` — lever pec deck fly / 杠杆蝴蝶机夹胸

| Step | English source meaning | Final Chinese |
| --- | --- | --- |
| 1 | sit, back flat, arms at chest level | 坐在蝴蝶机上，背部保持平直，双臂位于胸部高度。 |
| 2 | forearms or hands on pads, elbows slightly bent | 将前臂或双手放在垫子上，肘部略微弯曲。 |
| 3 | bring arms together in front of chest | 将双臂在胸前合拢。 |
| 4 | squeeze briefly, open slowly until chest stretch | 收紧胸部并短暂停顿，然后缓慢打开双臂，直到感到胸部拉伸。 |
| 5 | shoulders down and back | 保持肩部下沉并向后收。 |

Step 1 was refined during review: the English refers to the person's arms,
so an earlier instruction to adjust the machine arms was removed.

### `3593` — barbell squat / 杠铃深蹲

| Step | English source meaning | Final Chinese |
| --- | --- | --- |
| 1 | bar on upper back, feet shoulder-width | 将杠铃放在上背部，双脚与肩同宽站立。 |
| 2 | brace core, chest up | 收紧核心并保持挺胸。 |
| 3 | hips back/down until thighs about parallel | 臀部向后、向下移动，直到大腿大致与地面平行。 |
| 4 | knees track over toes | 保持膝盖沿脚尖方向移动。 |
| 5 | drive through feet to stand tall | 双脚向下发力，站直身体。 |

Step 4 describes movement direction; it does not introduce a rule forbidding
knees from travelling beyond toes. No bar position beyond the existing English
“upper back”, depth beyond “about parallel”, or weight convention is invented.

## Community review scope and two declared wording edits

For all 1,324 imported exercises / 7,662 steps, the automated checks establish:
exact known IDs, complete nonempty arrays, Han text, source-version/hash integrity,
and exact import fidelity after reversing the two explicitly declared edits.
The community README reports its own two full reviews. That is a source claim;
this task has not independently reviewed all 7,662 steps for professional fitness
accuracy or manually compared every imported step with English.

A focused step-by-step language comparison was performed for the nine imported
exercises used by the known plans: `0178` (5), `0198` (7), `0294` (6), `0489` (5),
`0585` (6), `0597` (6), `0598` (5), `0602` (5), `0861` (5): **50 steps total**.
The wording is consistent with the corresponding English instructions at this
language-review level, with two ambiguities clarified locally:

| ID / step | Community wording | Final wording | English source / reason |
| --- | --- | --- | --- |
| `0198` / 6 | 在动作底部暂停片刻，然后慢慢松开拉杆回到起始位置。 | 在动作底部暂停片刻，然后缓慢将拉杆还原至起始位置。 | “slowly release the bar back to the starting position”; avoid implying release of the grip |
| `0489` / 3 | 将上半身压向地面，同时保持背部挺直。 | 保持背部挺直，向地面方向放低上半身。 | “Lower your upper body towards the ground while keeping your back straight”; avoid implying added pressing force |

`source.json` retains each original/replacement pair and the reason. The test
reverses only those declared replacements before checking the original import
hash, so a silent change elsewhere in the community text still fails the guard.
