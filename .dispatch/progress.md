# xsETvyKL — Automatically parse and replace slug URL data entry

## What changed

**`src/slugify.mjs` (new)** — exports `slugify(input)`: lowercase → replace every char
outside `[a-z0-9-]` with `-` → collapse dash runs → trim leading/trailing dashes.
Non-string input (`null`, `undefined`, numbers) is coerced via `String(input ?? '')`,
so degenerate input yields `''`.

**`src/api.mjs`** — `POST /api/admin/campaigns` now calls `slugify()` in place of the
ad-hoc `.trim().toLowerCase().replace(/\s+/g,'-')`. The existing `SLUG`
(`/^[a-z0-9][a-z0-9-]{2,39}$/`) guard still runs *after* slugify, so the only 400s left
are slugs slugify genuinely cannot rescue (empty, `---`, `!!` → under 3 chars). The 400
message now quotes the **raw** input rather than the half-mangled value — more useful
when telling a researcher what they typed was unusable.

**`src/adminui.mjs`** — added a client-side `slugify` mirroring `src/slugify.mjs`, plus
`previewSlug()`. The `#campUrl` line under the form is now a live preview: typing
`My Great Study!` shows `https://host/c/my-great-study` as you type, and shows
"slug needs at least 3 letters, digits or dashes" while the normalized value is too
short. Save posts the normalized value, so what the researcher sees is what is stored.

**`test/slugify.test.mjs` (new)** — the seven unit cases from the card, a
byte-identical-passthrough case for already-valid slugs, non-string tolerance, the
API-level `'My Great Study!'` → 200 / `my-great-study` case (also asserting the campaign
is readable at the normalized slug and `/c/my-great-study` renders), and a case pinning
that unrescuable slugs still return the helpful 400.

## Test output

`node --test` — **19 pass, 0 fail** (14 pre-existing + 5 new). No existing test was
modified or removed.

Note: `node --test test/` fails on this machine's Node v25.8.1 with `MODULE_NOT_FOUND`
(directory args are no longer resolved that way); `node --test` — the repo's
`npm test` script — discovers `test/*.mjs` correctly.

## Decisions

- **POST only, not PUT.** `putCampaign` is an upsert and `POST /api/admin/campaigns` is
  the create *and* update path, so that is where slugify belongs. `PUT
  /api/admin/campaigns/<slug>` takes its slug from the URL segment, which the router
  already gates on `SLUG.test()` — a request that reaches it necessarily has a valid
  slug, and rewriting it there would silently move an existing campaign to a new key.
- **Kept the length guard.** The card asks never to 400 for something slugify can fix;
  it does not ask to accept a 1-character slug. `!!` → `!` → `''`-ish results still 400
  with the original message.
- **Duplicated slugify in the admin UI** rather than serving the module. `adminui.mjs`
  emits a self-contained inline `<script>` with no bundler or module endpoint; adding
  one would be a bigger change than the card warrants. The copy is four lines and
  carries a comment pointing at the source of truth.
- The client copy uses no backslash escapes on purpose — `adminui.mjs` builds the page
  in a template literal, where `\s` would collapse to `s`.

No new dependencies. Auth, recording, and storage paths untouched.
