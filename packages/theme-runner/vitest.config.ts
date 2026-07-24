import { preset } from "../../vitest.shared";

// `node`: this package's whole subject is worker_threads and process boundaries.
// A DOM would be actively misleading — the HTML it produces is a string that never
// meets a browser on this side.
export default preset({
  coverage: { lines: 70, functions: 70, branches: 60, statements: 70 },
});
