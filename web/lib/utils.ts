import { createCn } from "cn/config";

/**
 * The class merger. The design's type styles (`text-body`, `text-label`...) are font sizes, and the merger has to know that: without it
 * it takes them for colours and drops one of them whenever a real text colour sits beside it in the same call. The same goes for the design's
 * own radii and shadows.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["title-mobile", "title", "dialog-title", "section", "chat", "body", "ui", "empty", "label", "caption", "code", "button", "button-sm", "tab"] }],
      rounded: [{ rounded: ["control", "menu", "card", "panel", "composer", "bar", "tile-sm", "tile-md", "tile-lg", "tile-xl", "tile-2xl"] }],
      shadow: [{ shadow: ["pop", "dialog", "panel", "menu", "bar", "card"] }],
    },
  },
});
