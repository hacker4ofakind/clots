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

/**
 * The value of one `{...}` body: a path, or several joined by `|`, of which the first that is present
 * (neither missing nor null) is used. Undefined when none is.
 */
function pick(body: string, value: unknown): unknown {
  for (const path of body.split("|")) {
    const found = pathGet(value, path.trim());
    if (present(found)) return found;
  }
  return undefined;
}

/** Text with each "{path}" replaced by the value at that path; "{a|b}" takes the first of the paths that is present. A missing path gives nothing. */
export function fillPaths(template: string, value: unknown): string {
  return template.replace(/\{([^{}]+)\}/g, (_whole, body: string) => {
    const found = pick(body, value);
    return found === undefined ? "" : show(found);
  });
}

/**
 * Like `fillPaths`, for a key that identifies something: undefined when any path in the template is missing, or
 * when the result is empty, so `"{channel}:{ts}"` never fills to a partial key that would make later events
 * look like repeats of earlier ones.
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

/** The paths a template reads: each `{...}` body split at `|`. */
export function pathsIn(template: string): string[] {
  return [...template.matchAll(/\{([^{}]+)\}/g)].flatMap((m) => m[1].split("|").map((p) => p.trim()));
}
