import { preset } from "../../vitest.shared";

// This package is the validation boundary: every hostile request in the product
// is parsed here before it reaches a service or a database. A branch left
// unexecuted here is a branch an attacker gets to execute first.
export default preset({ coverage: { lines: 90, functions: 90, branches: 85, statements: 90 } });
