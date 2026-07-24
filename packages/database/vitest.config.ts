import { preset } from "../../vitest.shared";

// The multi-tenant isolation boundary lives in this package. Prisma and pg are
// mocked so no live database is needed, but the behaviour under test — that one
// tenant's context never leaks into another's, and that a query with no context
// is refused — is exercised for real. `generated/` (Prisma output) and the
// verify-rls attack suite are excluded by the shared preset.
export default preset({
  coverage: { lines: 80, functions: 80, branches: 75, statements: 80 },
});
