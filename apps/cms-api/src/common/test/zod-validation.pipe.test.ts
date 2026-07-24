import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZodValidationPipe } from "../zod-validation.pipe";

/**
 * The pipe that validates request bodies against the shared Zod schemas.
 *
 * Real Zod, real schemas — validation asserted against a mocked validator would
 * prove nothing. The behaviours that matter for security:
 *   - a malformed body is REFUSED, not coerced and let through;
 *   - the refusal is useful to the client (which field, what was wrong) but does
 *     NOT leak internal detail — no stack trace, no raw exception text.
 */

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

describe("ZodValidationPipe", () => {
  it("returns the parsed value for a body that satisfies the schema", () => {
    const pipe = new ZodValidationPipe(LoginSchema);

    const result = pipe.transform({ email: "user@example.test", password: "longenough" });

    expect(result).toEqual({ email: "user@example.test", password: "longenough" });
  });

  it("rejects a body that violates the schema", () => {
    // An invalid payload reaching a service is how malformed data becomes a bug or
    // a bypass. It stops here.
    const pipe = new ZodValidationPipe(LoginSchema);

    expect(() => pipe.transform({ email: "not-an-email", password: "x" })).toThrow(
      BadRequestException,
    );
  });

  it("rejects a body of the wrong type entirely, rather than throwing an unhandled error", () => {
    // safeParse means a null/string/array body is a clean 400, not a 500 that
    // tells the caller the server crashed on their input.
    const pipe = new ZodValidationPipe(LoginSchema);

    expect(() => pipe.transform(null)).toThrow(BadRequestException);
    expect(() => pipe.transform("just a string")).toThrow(BadRequestException);
  });

  it("names the offending field so the client can fix it, without a stack trace", () => {
    const pipe = new ZodValidationPipe(LoginSchema);

    let error: BadRequestException | undefined;
    try {
      pipe.transform({ email: "bad", password: "short" });
    } catch (err) {
      error = err as BadRequestException;
    }

    const response = error!.getResponse() as { message: string; errors: any[] };
    expect(response.errors.map((e) => e.path)).toContain("email");
    // The detail is field + message only — no internal representation leaks out.
    const serialized = JSON.stringify(response);
    expect(serialized).not.toMatch(/ZodError/);
    expect(serialized).not.toMatch(/at Object\.|node_modules|\.ts:\d+/);
  });

  it("strips unknown keys an attacker adds, when the schema does not allow them", () => {
    // Mass-assignment defence. A default Zod object drops keys it does not
    // declare, so `isAdmin: true` smuggled into the body never reaches the service.
    const pipe = new ZodValidationPipe(LoginSchema);

    const result = pipe.transform({
      email: "user@example.test",
      password: "longenough",
      isAdmin: true,
      role: "OWNER",
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("isAdmin");
    expect(result).not.toHaveProperty("role");
  });

  it("refuses unknown keys outright when the schema is strict", () => {
    const pipe = new ZodValidationPipe(LoginSchema.strict());

    expect(() =>
      pipe.transform({
        email: "user@example.test",
        password: "longenough",
        isAdmin: true,
      }),
    ).toThrow(BadRequestException);
  });
});
