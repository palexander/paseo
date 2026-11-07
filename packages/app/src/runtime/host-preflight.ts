import type {
  PluginHostSummary,
  PluginHostPreflightContribution,
  PluginHostPreflightRequest,
} from "@getpaseo/plugin/client";

interface Owner {
  serverId: string;
  pluginId: string;
  signal: AbortSignal;
}
export interface HostPreflightState {
  phase: "preparing" | "connecting" | "failed";
  message: string;
}
interface Pending {
  abort: AbortController;
  promise: Promise<void>;
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Startup wait cancelled. The machine may continue starting.");
}

function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted(signal));
      return;
    }
    const cancel = () => reject(aborted(signal));
    signal.addEventListener("abort", cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Joins explicit conversation requests by host; opening a workspace never calls prepare. */
export class HostPreflight {
  private readonly hooks = new Map<
    string,
    { owner: Owner; hook: PluginHostPreflightContribution }
  >();
  private readonly pending = new Map<string, Pending>();
  private readonly states = new Map<string, HostPreflightState>();
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly ports: {
      host(serverId: string): PluginHostSummary | null;
      subscribe(serverId: string, listener: () => void): () => void;
      connect(serverId: string): void;
      timeoutMs?: number;
    },
  ) {}

  register(owner: Owner, hook: PluginHostPreflightContribution): () => void {
    if (
      !/^[a-z][a-z0-9-]*$/.test(hook.id) ||
      typeof hook.matches !== "function" ||
      typeof hook.prepare !== "function"
    )
      throw new Error("Invalid host preflight contribution");
    const key = `${owner.serverId}/${owner.pluginId}/${hook.id}`;
    if (this.hooks.has(key)) throw new Error(`Duplicate host preflight: ${hook.id}`);
    if (owner.signal.aborted) throw new Error("Plugin has stopped");
    const lifetime = new AbortController();
    this.hooks.set(key, { owner: { ...owner, signal: lifetime.signal }, hook });
    const remove = () => {
      lifetime.abort();
      this.hooks.delete(key);
      owner.signal.removeEventListener("abort", remove);
    };
    owner.signal.addEventListener("abort", remove, { once: true });
    return remove;
  }

  snapshot(serverId: string): HostPreflightState | null {
    return this.states.get(serverId) ?? null;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  cancel(serverId: string): void {
    this.pending
      .get(serverId)
      ?.abort.abort(new Error("Startup wait cancelled. The machine may continue starting."));
  }
  dismiss(serverId: string): void {
    if (!this.pending.has(serverId)) this.publish(serverId, null);
  }
  private publish(serverId: string, state: HostPreflightState | null): void {
    if (state) this.states.set(serverId, state);
    else this.states.delete(serverId);
    for (const listener of this.listeners) listener();
  }

  prepare(request: PluginHostPreflightRequest): Promise<void> {
    if (this.ports.host(request.serverId)?.status === "online") {
      if (this.states.has(request.serverId)) this.publish(request.serverId, null);
      return Promise.resolve();
    }
    const existing = this.pending.get(request.serverId);
    if (existing) return existing.promise;
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new Error("Host startup timed out. Try sending again to retry.")),
      this.ports.timeoutMs ?? 300_000,
    );
    const promise = this.run(request, abort.signal)
      .then(
        () => {
          this.publish(request.serverId, null);
          return undefined;
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.publish(request.serverId, { phase: "failed", message });
          throw error;
        },
      )
      .finally(() => {
        clearTimeout(timer);
        this.pending.delete(request.serverId);
      });
    this.pending.set(request.serverId, { abort, promise });
    return promise;
  }

  private async run(request: PluginHostPreflightRequest, signal: AbortSignal): Promise<void> {
    if (!this.ports.host(request.serverId)) throw new Error("Unknown host");
    this.publish(request.serverId, { phase: "preparing", message: "Checking host availability…" });
    let selected: { owner: Owner; hook: PluginHostPreflightContribution } | undefined;
    for (const entry of this.hooks.values()) {
      if (entry.owner.signal.aborted || this.ports.host(entry.owner.serverId)?.status !== "online")
        continue;
      if (await cancellable(Promise.resolve(entry.hook.matches({ ...request, signal })), signal)) {
        if (selected)
          throw new Error(
            "Multiple plugins manage this host. Check your controller configuration.",
          );
        selected = entry;
      }
    }
    if (!selected) throw new Error("Host is not connected and no available controller manages it.");
    if (selected.owner.signal.aborted) throw new Error("The host controller plugin stopped");
    const controller = new AbortController();
    const cancel = () => controller.abort(aborted(signal));
    const unloaded = () =>
      controller.abort(
        new Error("The host controller plugin stopped. Try sending again after it reconnects."),
      );
    signal.addEventListener("abort", cancel, { once: true });
    selected.owner.signal.addEventListener("abort", unloaded, { once: true });
    try {
      if (signal.aborted) cancel();
      await cancellable(
        selected.hook.prepare({
          ...request,
          signal: controller.signal,
          reportProgress: (message) => {
            if (!controller.signal.aborted)
              this.publish(request.serverId, {
                phase: "preparing",
                message: message.trim().slice(0, 500) || "Preparing host…",
              });
          },
        }),
        controller.signal,
      );
      this.publish(request.serverId, { phase: "connecting", message: "Connecting to host…" });
      await this.waitForConnection(request.serverId, controller.signal);
    } finally {
      signal.removeEventListener("abort", cancel);
      selected.owner.signal.removeEventListener("abort", unloaded);
    }
  }

  private waitForConnection(serverId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let release = () => {};
      const cleanup = () => {
        release();
        signal.removeEventListener("abort", cancel);
      };
      const check = () => {
        const host = this.ports.host(serverId);
        if (!host) {
          cleanup();
          reject(new Error("Host was removed during startup"));
        } else if (host.status === "online") {
          cleanup();
          resolve();
        }
      };
      const cancel = () => {
        cleanup();
        reject(aborted(signal));
      };
      if (signal.aborted) {
        reject(aborted(signal));
        return;
      }
      release = this.ports.subscribe(serverId, check);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        this.ports.connect(serverId);
        check();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}
