import { preset } from "../../vitest.shared";

// `node`, not `jsdom`: the widgets are server components rendered with
// react-dom/server's renderToStaticMarkup, which needs no DOM. They ship no client
// bundle and attach no handlers — exactly like the themes that consume them.
export default preset({
  coverage: { lines: 80, functions: 80, branches: 75, statements: 80 },
});
