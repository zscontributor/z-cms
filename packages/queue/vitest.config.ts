import { preset } from "../../vitest.shared";

// Redis and BullMQ are mocked: a unit test of the job vocabulary must not need a
// running Redis. What is asserted here is the CONTRACT between producer and
// worker — the job names, and the options every enqueue carries.
export default preset({
  coverage: { lines: 90, functions: 90, branches: 85, statements: 90 },
});
