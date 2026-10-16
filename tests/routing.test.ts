import { describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import { buildRoutingPrompt, parseRoutingAnswer, type RoutingCall, type RoutingInput } from "../src/routing-call.js";
import { bindingResolver, EventRouter, type Binding } from "../src/routing.js";
import type { RoutingRule } from "../src/rulebook.js";

const mail: ClotEvent = { id: "email:gmail:<m1@x>", source: "email", account: "gmail", kind: "email", place: "me+shop@gmail.com", actor: "jane@example.com", title: "Refund?", body: "", url: "", ref: "<m1@x>", subject: "thread:<m1@x>", automated: false, receivedAt: 0 };

class FakeCall implements RoutingCall {
  inputs: RoutingInput[] = [];
  answer: { clot: string | null; confident: boolean } | Error = { clot: null, confident: false };
  async decide(input: RoutingInput) {
    this.inputs.push(input);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function router(o: { binding?: Binding; rules?: RoutingRule[]; home?: string; call?: FakeCall }) {
  const call = o.call ?? new FakeCall();
  return {
    call,
    router: new EventRouter({
      bindingOf: () => o.binding,
      rules: () => o.rules ?? [],
      call,
      clots: () => [
        { name: "shop", about: "An online shop." },
        { name: "graphite", about: "A drawing app." },
      ],
      guidance: () => "Global guidance.",
      home: o.home,
    }),
  };
}

describe("EventRouter", () => {
  it("sends a bound account's events to its Clot, whatever the rules say", async () => {
    const { router: r, call } = router({ binding: { clot: "graphite" }, rules: [{ source: "email", clot: "shop" }] });
    expect(await r.route(mail)).toEqual({ clot: "graphite", how: "bound" });
    expect(call.inputs).toEqual([]);
  });

  it("routes a shared account's event by the first rule that matches", async () => {
    const { router: r, call } = router({ binding: "shared", rules: [{ place: "other@x.ch", clot: "graphite" }, { source: "email", place: "ME+shop@gmail.com", clot: "shop" }] });
    expect(await r.route(mail)).toEqual({ clot: "shop", how: "routing rule" });
    expect(call.inputs).toEqual([]);
  });

  it("asks the routing call when no rule matches, and takes a confident answer naming a Clot", async () => {
    const call = new FakeCall();
    call.answer = { clot: "shop", confident: true };
    const { router: r } = router({ binding: "shared", call, home: "home" });
    expect(await r.route(mail)).toEqual({ clot: "shop", how: "routing call" });
    expect(call.inputs[0]).toMatchObject({ guidance: "Global guidance.", clots: [{ name: "shop" }, { name: "graphite" }] });
  });

  it("goes home when the call is not confident, names no Clot that exists, or fails", async () => {
    for (const answer of [{ clot: "shop", confident: false }, { clot: "nobody", confident: true }, { clot: null, confident: true }, new Error("down")]) {
      const call = new FakeCall();
      call.answer = answer;
      const { router: r } = router({ binding: "shared", call, home: "home" });
      expect((await r.route(mail)).clot).toBe("home");
    }
  });

  it("goes nowhere without a home Clot, and says why", async () => {
    const { router: r } = router({ binding: "shared" });
    expect(await r.route(mail)).toEqual({ how: "no routing rule matched and the routing call was not sure, and there is no home Clot" });
  });

  it("sends an event from an unbound GitHub repository home, without asking", async () => {
    const { router: r, call } = router({ binding: undefined, home: "home" });
    expect(await r.route({ ...mail, source: "github" })).toEqual({ clot: "home", how: "no Clot is bound to this repository" });
    const { router: none } = router({ binding: undefined });
    expect(await none.route({ ...mail, source: "github" })).toEqual({ how: "no Clot is bound to this repository" });
    expect(call.inputs).toEqual([]);
  });
});

describe("bindingResolver", () => {
  const resolve = bindingResolver({
    repos: new Map([["octo/widgets", "graphite"]]),
    accounts: [
      { source: "stripe", account: "shop", clot: "shop", shared: false },
      { source: "email", account: "gmail", shared: true },
    ],
    recipes: (name) => (name === "linear-second" ? { clot: "graphite" } : undefined),
  });

  it("binds a GitHub repository, an account and a recipe, and knows a shared account", () => {
    expect(resolve({ ...mail, source: "github", account: "github", place: "octo/widgets" })).toEqual({ clot: "graphite" });
    expect(resolve({ ...mail, source: "github", account: "github", place: "octo/other" })).toBeUndefined();
    expect(resolve({ ...mail, source: "stripe", account: "shop" })).toEqual({ clot: "shop" });
    expect(resolve(mail)).toBe("shared");
    expect(resolve({ ...mail, source: "linear-second", account: "linear-second" })).toEqual({ clot: "graphite" });
    expect(resolve({ ...mail, source: "email", account: "unknown" })).toBe("shared");
  });
});

describe("the routing call's prompt and answer", () => {
  const input: RoutingInput = { event: mail, guidance: "Refunds go to the shop.", clots: [{ name: "shop", about: "An online shop." }] };

  it("lists the projects and the guidance, and wraps the event", () => {
    const prompt = buildRoutingPrompt(input);
    expect(prompt).toContain("<event source=\"email\"");
    expect(prompt).toContain("<projects>\n- shop: An online shop.\n</projects>");
    expect(prompt).toContain("<guidance>\nRefunds go to the shop.\n</guidance>");
  });

  it("accepts a listed project, and treats anything else as not sure", () => {
    expect(parseRoutingAnswer({ clot: "shop", confident: true }, input)).toEqual({ clot: "shop", confident: true });
    expect(parseRoutingAnswer({ clot: "elsewhere", confident: true }, input)).toEqual({ clot: null, confident: false });
    expect(parseRoutingAnswer({ clot: null, confident: true }, input)).toEqual({ clot: null, confident: false });
    expect(parseRoutingAnswer("junk", input)).toEqual({ clot: null, confident: false });
  });
});
