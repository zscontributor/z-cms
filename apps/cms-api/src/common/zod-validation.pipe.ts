import { BadRequestException, PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { t } from "./i18n";

/**
 * Validates a request payload against a Zod schema from @zcmsorg/schemas.
 *
 * Using the same schemas the admin UI validates against means the two cannot
 * drift: there is one definition of what a valid content payload is, not one
 * per side of the wire.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: t()("errors.validation.invalidPayload"),
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
