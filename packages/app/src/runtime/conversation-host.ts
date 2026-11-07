import { useSyncExternalStore } from "react";
import type { PluginHostPreflightRequest } from "@getpaseo/plugin/client";
import { getHostRuntimeStore } from "./host-runtime";
import { HostPreflight } from "./host-preflight";

export const conversationHostPreflight = new HostPreflight({
  host(serverId) {
    const store = getHostRuntimeStore();
    const host = store.getHosts().find((value) => value.serverId === serverId);
    return host
      ? {
          serverId,
          label: host.label || serverId,
          status: store.getSnapshot(serverId)?.connectionStatus ?? "offline",
        }
      : null;
  },
  subscribe: (serverId, listener) => getHostRuntimeStore().subscribe(serverId, listener),
  connect: (serverId) => getHostRuntimeStore().ensureConnected(serverId),
});

export const prepareConversationHost = (request: PluginHostPreflightRequest) =>
  conversationHostPreflight.prepare(request);

export function useConversationHostPreflight(serverId: string) {
  return useSyncExternalStore(
    conversationHostPreflight.subscribe,
    () => conversationHostPreflight.snapshot(serverId),
    () => null,
  );
}
