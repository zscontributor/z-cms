import { preset } from "../../vitest.shared";

/**
 * The API is NestJS, so its classes carry decorators — but these suites never go
 * through the DI container. Every service and guard is constructed directly with
 * plain mock dependencies, precisely because `Test.createTestingModule` needs the
 * `emitDecoratorMetadata` that the test transform does not emit. Vitest 4's oxc
 * transform handles the `@Injectable()` decorators themselves, so no extra
 * decorator configuration is required here.
 */
export default preset({
  coverage: { lines: 70, functions: 70, branches: 65, statements: 70 },
  // The auth suites hash and verify with REAL bcryptjs at cost 12 (pure JS, on
  // purpose — the crypto is the thing under test). A single case can chain three
  // or four rounds, which overruns the 5s default on a loaded CI runner. Same
  // allowance the other real-crypto suites take (scanner, package).
  testTimeout: 20_000,
});
