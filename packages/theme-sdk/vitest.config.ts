import { preset } from "../../vitest.shared";

// `node`, not `jsdom`: nothing in this package touches a DOM. The SDK composes
// plain objects (SEO, settings, translations) — React appears only in its types.
export default preset({
  coverage: { lines: 85, functions: 85, branches: 80, statements: 85 },
});
