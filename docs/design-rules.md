# NEURO design rules — Life and canonical cards

Written 13 Oct 2026 because every Life card had been built on its own and they
all came out as the same thing: a sentence, a grey explanation under it, then a
stack of folds. Nick's word for it was "a wall of text". These rules are what a
card must look like; `frontend/src/components/canonical/canonicalUi.jsx` holds
the pieces, and `backend/services/design-rules.test.js` fails a card that skips
them.

The honesty rules do not change: unread is never zero, unknown stays visibly
unknown, every judgement is the server's. These rules are about SHAPE.

## The shape of a card

1. **Title** — `<h3>` with the card's name. Nothing else on that line except a
   single Refresh where the page needs one.
2. **Headline** — `<Headline tone pill>` is the card's ANSWER in one line: a
   status badge and one short sentence. *"Planned — Saturday hike."* *"No walk
   armed."* *"2 things need you."* If the reader stops here they know the
   state. A card with nothing to say still has a headline (*"All quiet"*,
   *"Nothing recorded yet"*).
3. **Numbers in tiles** — `<StatTiles><Stat v l/></StatTiles>`. A count, a
   duration, a temperature is a tile, never buried in a sentence. 2–5 tiles.
   An unknown value is `—`, never 0.
4. **One primary action** — `<PrimaryAction>`. The thing you'd most likely do
   here (*Plan a new walk*, *Add*, *Open People board*). Secondary actions are
   `cn-btn--tiny` and live with the item they act on.
5. **Collections as tiles** — `<TileGrid><Tile/></TileGrid>` for up to about a
   dozen things. A list (`cn-list`) only for long or dense rows (a log, a
   table of readings).
6. **Groups** — `<Group label why>` to split a card. A reason that applies to
   every item in the group is the group's `why`, said **once** — never
   repeated on each tile.
7. **Folds** — only for things you edit, configure or rarely open (forms,
   sources, history, corrections). Never for the answer.
8. **How it works** — `<HowItWorks>` is the ONLY grey paragraph, at the bottom,
   closed.

## Words

- A tile shows **one** short fact under its title. The full reason goes on
  hover (`why`). Never two lines of grey under every item.
- Dates are `Sat 21 Nov` (`dayLabel`), never `2026-11-21`, except in tables.
- Tones mean things: `good` done/healthy, `plan` planned/upcoming, `warn` needs
  a look, `bad` needs you now, neutral otherwise. Never a tone for decoration,
  and never `bad` for something Nick merely hasn't done (no guilt colours).
- No "NEURO can't…/NEURO won't…" explanations in the body. Limits go in How it
  works or a source fold.

## Checklist before shipping a card

- [ ] Opens with `<Headline>`.
- [ ] No number lives only inside a sentence.
- [ ] No repeated "because…/heard on…" line on every item.
- [ ] At most one grey paragraph (How it works).
- [ ] Looks right at 390px wide.
