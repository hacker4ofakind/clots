import { pathGet } from "../../paths.js";
import { isRead } from "../rating.js";
import type { ToolkitDef } from "./index.js";

/** Any toolkit with no built-in def: its triggers are the ones its account names, and its identity is the one its Composio recipe reads. */
export const genericDef: ToolkitDef = {
  toolkit: "",
  source: "",
  async triggers(a) {
    return a.triggers.map((t) => ({ slug: t.slug, config: t.config, ...(t.pollMinutes === undefined ? {} : { pollingMinutes: t.pollMinutes }) }));
  },
  async identity(a, host) {
    const read = host.recipe(a.toolkit)?.identity;
    // A recipe without an identity leaves the toolkit with none: nothing to retry.
    if (read === undefined) return undefined;
    // The recipe is a file the Clots can write: the tool is checked again before each run, as the enrichment's reads are.
    const tool = await host.tool(read.tool);
    if (tool === undefined || tool.toolkit !== a.toolkit || !isRead(tool)) throw new Error(`${read.tool} is not a read tool of ${a.toolkit}`);
    const result = await host.run(a, read.tool, {});
    if (!result.ok) throw new Error(`reading who the ${a.toolkit} connection is failed: ${result.error}`);
    const found = pathGet(result.data, read.path);
    if (typeof found !== "string" && typeof found !== "number") throw new Error(`${read.tool} answered no ${read.path}`);
    const id = String(found);
    if (id === "") throw new Error(`${read.tool} answered an empty ${read.path}`);
    return id;
  },
};
