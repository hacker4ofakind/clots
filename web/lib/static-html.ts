import { isValidElement, type ReactNode } from "react";

/**
 * Turns a tree of plain React elements into HTML text without `react-dom/server`, which the proxy cannot import.
 * It only understands what a static page is made of: tags, text, fragments, and components that are plain functions
 * or `forwardRef`/`memo` wrappers around them (no hooks, no context). A test keeps its output equal to React's own.
 */
const ATTRIBUTE_NAMES: Record<string, string> = { className: "class", htmlFor: "for", strokeWidth: "stroke-width", strokeLinecap: "stroke-linecap", strokeLinejoin: "stroke-linejoin", fillRule: "fill-rule", clipRule: "clip-rule" };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const FORWARD_REF = Symbol.for("react.forward_ref");
const MEMO = Symbol.for("react.memo");
const FRAGMENT = Symbol.for("react.fragment");

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function attributes(props: Record<string, unknown>): string {
  let out = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "ref" || value === undefined || value === null || value === false) continue;
    const name = ATTRIBUTE_NAMES[key] ?? key;
    out += value === true && !name.startsWith("aria-") ? ` ${name}=""` : ` ${name}="${escape(String(value))}"`;
  }
  return out;
}

export function renderStatic(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return escape(String(node));
  if (Array.isArray(node)) return node.map(renderStatic).join("");
  if (!isValidElement(node)) throw new Error("renderStatic: not an element");
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (type === FRAGMENT) return renderStatic(props.children as ReactNode);
  if (typeof type === "string") {
    if (VOID.has(type) && props.children === undefined) return `<${type}${attributes(props)}/>`;
    return `<${type}${attributes(props)}>${renderStatic(props.children as ReactNode)}</${type}>`;
  }
  if (typeof type === "function") return renderStatic((type as (p: unknown) => ReactNode)(props));
  const wrapper = type as { $$typeof?: symbol; render?: (p: unknown, ref: unknown) => ReactNode; type?: unknown };
  if (wrapper.$$typeof === FORWARD_REF && wrapper.render) return renderStatic(wrapper.render(props, null));
  if (wrapper.$$typeof === MEMO && wrapper.type) return renderStatic({ ...(node as object), type: wrapper.type } as ReactNode);
  throw new Error("renderStatic: unsupported component");
}
