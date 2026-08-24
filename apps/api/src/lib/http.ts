export class ValidationError extends Error {}

export async function readBodyString(value: unknown, field: string, max = 100_000): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.slice(0, max);
}
