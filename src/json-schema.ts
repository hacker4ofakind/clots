import { z } from "zod";

/**
 * A zod schema as the JSON Schema Claude Code takes for structured output. Claude Code's validator does not know the
 * draft that zod names in `$schema` ("no schema with key or ref ... 2020-12"), so the key is left out.
 */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _draft, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
