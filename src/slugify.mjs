// URL-safe slug normalization (Trello xsETvyKL): parse-and-replace rather than
// validate-and-reject, so researchers can type "My Great Study!" and get
// "my-great-study" instead of a 400.

export function slugify(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')   // anything not url-safe becomes a dash
    .replace(/-+/g, '-')           // collapse runs of dashes
    .replace(/^-|-$/g, '');        // trim leading/trailing dashes
}
