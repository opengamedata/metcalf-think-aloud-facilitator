// Per-campaign codebook (Trello yWCcMmz2). A code is a FREEFORM label: the
// codebook is built up by use, not pre-declared. Applying a string that is not
// in the campaign's codebook creates the entry (description/examples blank,
// editable later); applying one that is already there reuses it. So "invent a
// code" and "pick an existing code" are the same call.
//
// Uniqueness is per campaign, case-insensitive, on the trimmed string — but the
// stored `code` keeps the casing of its first use, since that is what the
// researcher typed.

const BLANK = { description: '', positive_example: '', negative_example: '' };

// The trimmed label as it will be stored, or null when the input is not a
// usable code (blank, whitespace-only, or not a string at all).
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.trim();
  return code === '' ? null : code;
}

// The case-insensitive uniqueness key for a code, or null when invalid.
export function codeKey(input) {
  const code = normalizeCode(input);
  return code === null ? null : code.toLowerCase();
}

export function invalidCodeError(input) {
  const err = new Error(typeof input === 'string'
    ? 'Code must not be blank or whitespace-only.'
    : 'Code must be a string.');
  err.code = 'INVALID_CODE';
  return err;
}

// Reuse-on-first-use. Returns {entry, created} where created tells the caller
// whether this call minted the entry. Throws INVALID_CODE on a blank code.
export function applyCode(db, slug, rawCode) {
  const code = normalizeCode(rawCode);
  if (code === null) throw invalidCodeError(rawCode);
  const key = code.toLowerCase();

  const existing = db.getCode(slug, key);
  if (existing) return { entry: existing, created: false };

  db.insertCode({ slug, codeKey: key, code, ...BLANK });
  return { entry: db.getCode(slug, key), created: true };
}

// Apply several codes in one go, in order. Blank entries still throw, so a
// caller that wants to be lenient should filter with normalizeCode first.
export function applyCodes(db, slug, rawCodes) {
  return (rawCodes ?? []).map((c) => applyCode(db, slug, c));
}
