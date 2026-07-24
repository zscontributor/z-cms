import { preset } from "../../vitest.shared";

// The generator writes files and shells out to esbuild, so its tests use a real
// temp directory rather than a mocked fs: the thing worth proving is that the
// emitted theme actually BUILDS, and a mocked filesystem cannot fail the way a
// real one does.
export default preset({
  coverage: { lines: 75, functions: 75, branches: 70, statements: 75 },
});
