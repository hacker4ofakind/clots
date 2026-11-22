/** The value at a path of names and indexes, such as "data.0.rows"; the value itself for "". */
export function pathGet(value: unknown, path: string): unknown {
  if (path === "") return value;
  let at: unknown = value;
  for (const step of path.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[step];
  }
  return at;
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

const show = (value: unknown): string => (typeof value === "object" ? JSON.stringify(value) : String(value));

/** `{lines:path}` fills the object at the path as `key: value` lines, at most this many. */
const MAX_LINES = 20;
const LINES = "lines:";

/** The path of a `{lines:path}` body; undefined for any other body. */
const linesPath = (body: string): string | undefined => (body.startsWith(LINES) ? body.slice(LINES.length).trim() : undefined);

/** An object as `key: value` lines: scalars only (string, number, boolean), none whose key begins with `$`, the first 20. Empty for anything that is not an object. */
function linesOf(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value as Record<string, unknown>)
    .filter(([key, v]) => !key.startsWith("$") && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .slice(0, MAX_LINES)
    .map(([key, v]) => `${key}: ${String(v)}`)
    .join("\n");
}

/**
 * The value of one `{...}` body: a path, or several joined by `|`, of which the first that is present
 * (neither missing nor null) is used. Undefined when none is. A `lines:` body has no alternatives: it is the
 * object's lines, or undefined when there are none.
 */
function pick(body: string, value: unknown): unknown {
  const lines = linesPath(body);
  if (lines !== undefined) return linesOf(pathGet(value, lines)) || undefined;
  for (const path of body.split("|")) {
    const found = pathGet(value, path.trim());
    if (present(found)) return found;
  }
  return undefined;
}

/** A template line that is only a `{lines:path}` filling nothing is dropped, so that it leaves no blank line in a body. */
function withoutEmptyLines(template: string, value: unknown): string {
  if (!template.includes("{lines:")) return template;
  return template
    .split("\n")
    .filter((line) => {
      const body = /^\s*\{([^{}]+)\}\s*$/.exec(line)?.[1];
      return body === undefined || linesPath(body) === undefined || pick(body, value) !== undefined;
    })
    .join("\n");
}

/**
 * Text with each "{path}" replaced by the value at that path; "{a|b}" takes the first of the paths that is present. A missing path gives nothing.
 * "{lines:path}" fills the object at the path as `key: value` lines (scalars only, no `$` keys, at most 20); nothing when it is missing or empty.
 */
export function fillPaths(template: string, value: unknown): string {
  return withoutEmptyLines(template, value).replace(/\{([^{}]+)\}/g, (_whole, body: string) => {
    const found = pick(body, value);
    return found === undefined ? "" : show(found);
  });
}

/**
 * Like `fillPaths`, for a key that identifies something: undefined when any path in the template is missing, or
 * when the result is empty, so `"{channel}:{ts}"` never fills to a partial key that would make later events
 * look like repeats of earlier ones. A `{lines:path}` that fills nothing counts as missing.
 */
export function fillKey(template: string, value: unknown): string | undefined {
  let complete = true;
  const filled = template.replace(/\{([^{}]+)\}/g, (_whole, body: string) => {
    const found = pick(body, value);
    if (found === undefined) {
      complete = false;
      return "";
    }
    return show(found);
  });
  return complete && filled.trim() !== "" ? filled : undefined;
}

/** The paths a template reads: each `{...}` body split at `|`; a `{lines:path}` gives its path, without the prefix. */
export function pathsIn(template: string): string[] {
  return [...template.matchAll(/\{([^{}]+)\}/g)].flatMap((m) => {
    const lines = linesPath(m[1]);
    return lines !== undefined ? [lines] : m[1].split("|").map((p) => p.trim());
  });
}
