// Values whose type is unknown on the Node side: parsed JSON, imported modules, thrown errors.
// Page-side functions cannot import, so they narrow in place.

export type JsonObject = Readonly<Record<string, unknown>>;

/** An object with named members: not null, not an array. */
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `code` a Node error carries, such as ENOENT; undefined for any other value. */
export const codeOf = (error: unknown): unknown => (isObject(error) ? error['code'] : undefined);
