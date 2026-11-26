"use client";

import { memo, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * How a Clot's reply is drawn. Raw HTML is not rendered (react-markdown leaves it out), links open in a new tab and carry
 * no opener, and an image is shown as a link rather than loaded: nothing in a reply can make the browser call out by itself.
 */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary-ink underline underline-offset-2 hover:no-underline">
      {children}
    </a>
  ),
  img: ({ src, alt }) => {
    const href = typeof src === "string" ? src : undefined;
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary-ink underline underline-offset-2 hover:no-underline">
        {alt || href}
      </a>
    ) : (
      <span>{alt}</span>
    );
  },
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-6 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-6 first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  h1: ({ children }) => <h3 className="mt-4 mb-1 text-section first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-1 text-section first:mt-0">{children}</h3>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 text-chat font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 text-chat font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h4 className="mt-3 mb-1 text-chat font-semibold first:mt-0">{children}</h4>,
  h6: ({ children }) => <h4 className="mt-3 mb-1 text-chat font-semibold first:mt-0">{children}</h4>,
  blockquote: ({ children }) => <blockquote className="my-2 rounded-r-control border-l-2 border-input pl-3 text-foreground-soft">{children}</blockquote>,
  hr: () => <hr className="my-4 border-border" />,
  pre: ({ children }) => <pre className="my-2 max-w-full overflow-x-auto rounded-control bg-muted p-3 font-mono text-code leading-5 first:mt-0 last:mb-0">{children}</pre>,
  code: ({ className, children }) => (className ? <code className={cn("font-mono", className)}>{children}</code> : <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-code">{children}</code>),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-body">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
};

type Props = Omit<ComponentProps<typeof ReactMarkdown>, "components" | "remarkPlugins" | "children"> & { text: string; className?: string };

export const Markdown = memo(function Markdown({ text, className, ...rest }: Props) {
  return (
    <div className={cn("text-chat break-words [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml {...rest}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
