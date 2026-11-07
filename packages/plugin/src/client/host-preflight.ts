import type { PluginCleanup } from "../contracts.js";

/** An explicit conversation action, never passive host observation or route restoration. */
export interface PluginHostPreflightRequest {
  readonly serverId: string;
  readonly workspaceId?: string;
  readonly agentId?: string;
  readonly reason: "agent.create" | "agent.send";
}

export interface PluginHostPreflightContribution {
  readonly id: string;
  /** Match only hosts managed by this plugin. Runs through the installation's own controller. */
  matches(
    request: PluginHostPreflightRequest & { readonly signal: AbortSignal },
  ): boolean | Promise<boolean>;
  /** Resolve when the machine is ready to connect. Paseo then awaits its authenticated connection. */
  prepare(
    request: PluginHostPreflightRequest & {
      readonly signal: AbortSignal;
      readonly reportProgress: (message: string) => void;
    },
  ): Promise<void>;
}

export interface PluginHostPreflightRegistration {
  addHostPreflight(contribution: PluginHostPreflightContribution): PluginCleanup;
}
