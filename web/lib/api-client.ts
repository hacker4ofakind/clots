import type { z } from "zod";

/**
 * A failed call to the daemon through the app: the status and what the daemon said. `message` is for the console and the logs;
 * what a person reads comes from readableError, never from here.
 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `Failed with ${status}`);
  }
  private get code(): unknown {
    return typeof this.body === "object" && this.body !== null && "code" in this.body ? (this.body as { code: unknown }).code : undefined;
  }
  /** The daemon could not be reached (or the app could not reach it): the app's own answer for that, never one the daemon wrote. */
  get unreachable(): boolean {
    return this.status === 0 ? !this.timedOut : this.code === "daemon-unreachable";
  }
  /** The call took longer than the app waits for one. */
  get timedOut(): boolean {
    return this.status === 0 && this.code === "timeout";
  }
}

/** How long a call may take: an upload of the largest size is the slowest. */
const CALL_TIMEOUT_MS = 90_000;

/** Calls the daemon's API through the app's own route, from the browser. Throws an ApiFailure on any status over 399. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/d${path}`, { method: init.method ?? "GET", headers: init.body === undefined ? undefined : { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: "no-store", signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (e) {
    throw new ApiFailure(0, e instanceof DOMException && e.name === "TimeoutError" ? { error: "timeout", code: "timeout" } : { error: "network", code: "network" });
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
