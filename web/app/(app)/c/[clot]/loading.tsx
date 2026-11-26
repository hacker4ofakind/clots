import { ChatSkeleton } from "@/components/clots/skeletons";

/** Shown while a chat's first page of messages comes from the daemon, when moving between chats. */
export default function Loading() {
  return <ChatSkeleton />;
}
