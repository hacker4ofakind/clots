import type { z } from "zod";

/** A failed call to the daemon through the app: the status and what the daemon said. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `Failed with ${status}`);
  }
  /** The daemon could not be reached (or the app could not reach it). */
  get unreachable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503;
  }
}

/** Calls the daemon's API through the app's own route, from the browser. Throws an ApiFailure on any status over 399. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/d${path}`, { method: init.method ?? "GET", headers: init.body === undefined ? undefined : { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: "no-store" });
  } catch {
    throw new ApiFailure(0, { error: "network" });
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiFailure(res.status, body);
  return body as T;
}

/** Like api, but the answer is checked against a schema from the shared package. */
export async function apiParsed<S extends z.ZodType>(schema: S, path: string, init: { method?: string; body?: unknown } = {}): Promise<z.infer<S>> {
  return schema.parse(await api(path, init));
}
