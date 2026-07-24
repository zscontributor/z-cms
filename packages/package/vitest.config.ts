import { preset } from "../../vitest.shared";

// Crypto, tar and the filesystem are real here — never mocked. A signature check
// that passes against a fake verifier proves nothing.
export default preset({
  testTimeout: 20_000,
  coverage: { lines: 85, functions: 85, branches: 80, statements: 85 },
});
