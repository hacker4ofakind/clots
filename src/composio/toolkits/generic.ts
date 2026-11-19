import type { ToolkitDef } from "./index.js";

/** Any toolkit with no built-in def: its triggers are the ones its account names. */
export const genericDef: ToolkitDef = {
  toolkit: "",
  source: "",
  async triggers(a) {
    return a.triggers.map((t) => ({ slug: t.slug, config: t.config }));
  },
};
