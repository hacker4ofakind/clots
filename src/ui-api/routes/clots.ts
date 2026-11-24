import { answerRequestSchema, MAX_IMAGE_BYTES, sendMessageSchema, type AskCard, type ClotInfo, type ClotSummary, type MessagePage } from "@clots/ui-api-schemas";
import type { Asks } from "../../asks.js";
import type { Clot } from "../../clot.js";
import type { Config } from "../../config.js";
import { HOME_CLOT } from "../../config.js";
import type { ConversationService } from "../../conversation/conversation.js";
import type { ImageRow } from "../../conversation/store.js";
import type { Store } from "../../store.js";
import { COMMAND_LIST } from "../../commands.js";
import { ApiError, ApiResult, parseBody, RawResult, type UiApi } from "../server.js";
import { workerView } from "./workers.js";

export interface ClotRouteDeps {
  store: Store;
  conv: ConversationService;
  asks: Asks;
  config: () => Config;
  /** The Clots that run, by name. */
  clots: () => Map<string, Clot>;
  /** The Clots' names in the order the rail shows them. */
  names: () => string[];
  now: () => number;
}

const PAGE = 50;

/** A repository URL as owner/name. */
const repositoryOf = (repoUrl: string): string => /github\.com[/:]([^/]+\/[^/.]+)/.exec(repoUrl)?.[1] ?? repoUrl;

/** The image types a message may carry, and what their first bytes look like. */
const IMAGE_SIGNATURES: { type: string; matches: (b: Buffer) => boolean }[] = [
  { type: "image/png", matches: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/webp", matches: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { type: "image/gif", matches: (b) => b.length > 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")) },
];

/** An image from a data URL, with its type taken from its own bytes, not from what the URL claims. */
export function decodeImage(dataUrl: string): ImageRow {
  const match = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) throw new ApiError(400, "an image must be a base64 data URL");
  const data = Buffer.from(match[1]!, "base64");
  if (data.length > MAX_IMAGE_BYTES) throw new ApiError(413, "an image is larger than 5 MB");
  const found = IMAGE_SIGNATURES.find((s) => s.matches(data));
  if (!found) throw new ApiError(400, "only PNG, JPEG, WebP and GIF images are accepted");
  return { mediaType: found.type, data };
}

export function registerClotRoutes(api: UiApi, d: ClotRouteDeps): void {
  const { store, conv, asks } = d;
  const known = (name: string): void => {
    if (!d.names().includes(name)) throw new ApiError(404, "no such Clot");
  };
  const waitingFor = (name: string) => store.openAsks(name).length;

  api.route("GET", "/identity", () => {
    const config = d.config();
    let serveHost: string | undefined;
    try {
      serveHost = config.publicUrl === "" ? undefined : new URL(config.publicUrl).hostname.toLowerCase();
    } catch {
      serveHost = undefined;
    }
    return { owner: config.ui.owner, serveHost };
  });

  api.route("GET", "/clots", (): ClotSummary[] =>
    d.names().map((name) => {
      const { state, reason } = conv.stateOf(name);
      const definition = d.config().clots.find((c) => c.name === name);
      const icon = definition?.icon;
      const last = store.conversation.latest(name, "clot");
      const preview = last === undefined ? null : last.text.replace(/\s+/g, " ").trim().slice(0, 120) || null;
      return { name, ...(icon === undefined ? {} : { icon }), state, ...(reason === undefined ? {} : { reason }), unread: store.conversation.unread(name), waiting: waitingFor(name), home: name === HOME_CLOT, repository: definition === undefined ? null : repositoryOf(definition.repoUrl), preview, resumesAt: state === "paused" ? (store.getClot(name)?.pausedUntil ?? null) : null };
    }),
  );

  api.route("GET", "/clots/:clot", (req): ClotInfo => {
    known(req.params.clot!);
    const name = req.params.clot!;
    const config = d.config();
    const definition = config.clots.find((c) => c.name === name);
    const repository = definition === undefined ? null : repositoryOf(definition.repoUrl);
    return {
      name,
      repository,
      connections: [
        ...config.sources.email.filter((a) => a.clot === name || a.shared).map((a) => ({ kind: "email" as const, account: a.account, label: a.address, shared: a.shared })),
        ...config.sources.composio.filter((a) => a.clot === name || a.shared).map((a) => ({ kind: "composio" as const, account: a.account, label: `${a.toolkit}: ${a.account}`, toolkit: a.toolkit, shared: a.shared })),
      ],
    };
  });

  api.route("GET", "/clots/:clot/messages", (req): MessagePage => {
    known(req.params.clot!);
    const before = req.query.get("before") ?? undefined;
    const rows = store.conversation.list(req.params.clot!, before, PAGE + 1);
    const hasMore = rows.length > PAGE;
    const messages = rows.slice(0, PAGE).map(({ seq: _seq, ...view }) => {
      if (view.ref === null) return view;
      if (view.kind === "ask") return { ...view, ask: askCard(Number(view.ref)) };
      if (view.kind === "workers") return { ...view, workers: store.workersOfTurn(view.ref).map(workerView) };
      return view;
    });
    return { messages, hasMore };
  });

  /** An ask message's card: the open ask as it stands, or how it ended. */
  function askCard(id: number): AskCard | undefined {
    const ask = store.askById(id);
    if (ask) {
      const snapshot = asks.snapshot(ask);
      return snapshot && { id, state: ask.state, snapshot: { ...snapshot, messageId: store.conversation.askMessage(id)?.id ?? null } };
    }
    const past = store.conversation.askOutcome(id);
    return past && { id, state: "closed", view: past.view as AskCard["view"], summary: past.summary, outcome: past.outcome };
  }

  api.route(
    "POST",
    "/clots/:clot/messages",
    async (req) => {
      known(req.params.clot!);
      const name = req.params.clot!;
      const body = parseBody(sendMessageSchema, req.body);
      const text = body.text;
      const images = body.images.map(decodeImage);
      if (text.trim() === "" && images.length === 0) throw new ApiError(400, "a message needs text or an image");
      const at = d.now();
      const { message, created } = conv.addUser(name, { id: body.id, text, images, at });
      // A repeated ID is the same send retried: it is stored once and handled once.
      if (!created) return { message, duplicate: true };
      const clot = d.clots().get(name);
      if (!clot) throw new ApiError(503, "this Clot is not running");
      // Commands, empty text and images alone are never feedback to an open ask.
      const feedback = text.trim() !== "" && !text.trim().startsWith("/") && images.length === 0;
      if (feedback && (await asks.onUserMessage(name, text))) return { message };
      void clot.onMessage({ id: body.id, text, at: new Date(at), images: images.length }).catch((error) => console.error(`[${name}] handling a message failed:`, error));
      return new ApiResult(201, { message });
    },
    { maxBytes: 24 * 1024 * 1024 },
  );

  api.route("GET", "/clots/:clot/messages/:id/images/:n", (req) => {
    known(req.params.clot!);
    const message = store.conversation.get(req.params.id!);
    const image = message && message.clot === req.params.clot ? store.conversation.image(message.id, Number(req.params.n)) : undefined;
    if (!image) throw new ApiError(404, "no such image");
    return new RawResult(image.mediaType, image.data);
  });

  api.route("POST", "/clots/:clot/read", (req) => {
    known(req.params.clot!);
    store.conversation.markRead(req.params.clot!);
    return { ok: true };
  });

  api.route("GET", "/commands", () => COMMAND_LIST);

  api.route("GET", "/asks", () => asks.list().map((snapshot) => ({ ...snapshot, messageId: store.conversation.askMessage(snapshot.id)?.id ?? null })));

  api.route("POST", "/asks/:id/answer", async (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new ApiError(400, "no such ask");
    const { answer, key } = parseBody(answerRequestSchema, req.body);
    const result = await asks.answer(id, answer, key);
    switch (result.status) {
      case "answered":
        return { outcome: result.outcome };
      case "closed":
        return new ApiResult(409, { outcome: result.outcome });
      case "busy":
        return new ApiResult(202, { outcome: result.outcome });
      case "invalid":
        throw new ApiError(400, result.reason);
      default:
        throw new ApiError(404, "no such ask");
    }
  });
}
