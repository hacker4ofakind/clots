import { beforeEach, describe, expect, it } from "vitest";
import type { ClotEvent } from "../src/events/types.js";
import { handOver } from "../src/hand-over.js";
import type { ClotPort } from "../src/steering.js";
import { Store } from "../src/store.js";

class Port implements ClotPort {
  queued: { id: string; notice: string }[] = [];
  isBusy() {
    return false;
  }
  steerEvent() {
    return false;
  }
  async queueEvent(event: ClotEvent, notice: string) {
    this.queued.push({ id: event.id, notice });
  }
}

let store: Store;
let shop: Port;
let said: { clot: string; text: string }[];
const deps = () => ({ store, clots: new Map<string, ClotPort>([["graphite", new Port()], ["shop", shop]]), say: async (clot: string, text: string) => void said.push({ clot, text }) });

beforeEach(() => {
  store = new Store(":memory:");
  shop = new Port();
  said = [];
  store.insertEvent({ id: "e-1", source: "email", account: "gmail", kind: "email", place: "me@gmail.com", actor: "jane@x.com", title: "Refund for order 7", body: "", url: "", ref: "<1@x>", subject: "thread:<1@x>", automated: false, receivedAt: 0 });
  store.setEventClot("e-1", "graphite");
  store.recordTriage("e-1", "Jane asks for a refund. Looking into it.", false);
});

describe("handOver", () => {
  it("moves an event to another Clot, queues it there and says so in both channels", async () => {
    expect(await handOver(deps(), "graphite", "e-1", "shop")).toContain("Handed to shop");
    expect(store.getEvent("e-1")!.clot).toBe("shop");
    expect(shop.queued).toEqual([{ id: "e-1", notice: "Moved here from graphite at the user's request: Jane asks for a refund. Looking into it." }]);
    expect(said).toEqual([{ clot: "graphite", text: "Moved to shop at your request: Refund for order 7" }]);
  });

  it("refuses an unknown event, one that is not this Clot's, a Clot that does not exist, and the same Clot", async () => {
    expect(await handOver(deps(), "graphite", "nope", "shop")).toContain("no event");
    expect(await handOver(deps(), "shop", "e-1", "graphite")).toContain("not routed to you");
    expect(await handOver(deps(), "graphite", "e-1", "nobody")).toContain("no Clot named nobody");
    expect(await handOver(deps(), "graphite", "e-1", "graphite")).toContain("already");
    expect(shop.queued).toEqual([]);
  });
});
