/**
 * Vietnamese-aware slugify.
 *
 * NFD + combining-mark strip handles the tone marks (á, ầ, ữ …) but NOT "đ",
 * whose stroke is part of the base letter rather than a combining mark, so it
 * has to be mapped explicitly — otherwise "Đà Nẵng" would slug to "-a-nang".
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

/** The slug regex in @zcmsorg/schemas allows the empty string (the homepage). */
export function isValidSlug(slug: string): boolean {
  return /^$|^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
