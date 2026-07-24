import { preset } from "../../vitest.shared";

// The scanner is the gate that keeps hostile code out of the marketplace, so its
// suite builds REAL .zcms packages on a REAL filesystem and scans them. Nothing
// here is mocked: a scanner that only rejects a fake package proves nothing.
export default preset({
  testTimeout: 20_000,
  coverage: { lines: 85, functions: 85, branches: 80, statements: 85 },
});
