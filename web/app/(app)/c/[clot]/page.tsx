import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ClotInfo, MessagePage } from "@clots/ui-api-schemas";
import { ChatView } from "@/components/clots/chat-view";
import { DaemonError, daemonJson } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ clot: string }> }): Promise<Metadata> {
  return { title: decodeURIComponent((await params).clot) };
}

export default async function ChatPage({ params }: { params: Promise<{ clot: string }> }) {
  const clot = decodeURIComponent((await params).clot);
  try {
    const [info, initial] = await Promise.all([daemonJson<ClotInfo>(`/clots/${encodeURIComponent(clot)}`), daemonJson<MessagePage>(`/clots/${encodeURIComponent(clot)}/messages`)]);
    return <ChatView key={clot} clot={clot} info={info} initial={initial} />;
  } catch (error) {
    if (error instanceof DaemonError && error.status === 404) notFound();
    // The daemon is away: the banner says so, and the chat opens empty and fills when it is back.
    return <ChatView key={clot} clot={clot} info={{ name: clot, repository: null, connections: [] }} initial={{ messages: [], hasMore: false }} />;
  }
}
