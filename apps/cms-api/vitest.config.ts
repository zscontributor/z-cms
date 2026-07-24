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
});
