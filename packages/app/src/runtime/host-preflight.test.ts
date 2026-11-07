import { describe, expect, test } from "vitest";
import { HostPreflight } from "./host-preflight";

function setup() {
  let online = false;
  const listeners = new Set<() => void>();
  const manager = new HostPreflight({
    host: (id) => ({
      serverId: id,
      label: id,
      status: id === "controller" || online ? "online" : "offline",
    }),
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: () => {},
    timeoutMs: 1000,
  });
  return {
    manager,
    online() {
      online = true;
      for (const listener of listeners) listener();
    },
  };
}

describe("conversation host preflight", () => {
  test("awaits one startup for simultaneous conversations before allowing either action", async () => {
    const { manager, online } = setup();
    let starts = 0;
    let finish!: () => void;
    let entered!: () => void;
    const enteredStartup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const started = new Promise<void>((resolve) => {
      finish = resolve;
    });
    manager.register(
      { serverId: "controller", pluginId: "cloud", signal: new AbortController().signal },
      {
        id: "wake",
        matches: () => true,
        prepare: async ({ reportProgress }) => {
          starts++;
          reportProgress("Starting machine");
          entered();
          await started;
          online();
        },
      },
    );
    const first = manager.prepare({ serverId: "remote", reason: "agent.create" });
    const second = manager.prepare({ serverId: "remote", reason: "agent.send" });
    await enteredStartup;
    expect(starts).toBe(1);
    expect(manager.snapshot("remote")?.message).toBe("Starting machine");
    finish();
    await Promise.all([first, second]);
    expect(manager.snapshot("remote")).toBeNull();
  });
});

test("online hosts bypass every plugin and offline unmanaged hosts fail without side effects", async () => {
  const { manager, online } = setup();
  await expect(manager.prepare({ serverId: "remote", reason: "agent.send" })).rejects.toThrow(
    "no available controller",
  );
  online();
  await expect(
    manager.prepare({ serverId: "remote", reason: "agent.send" }),
  ).resolves.toBeUndefined();
  expect(manager.snapshot("remote")).toBeNull();
});

test("failed startup can be retried without poisoning the host", async () => {
  const { manager, online } = setup();
  let attempts = 0;
  manager.register(
    { serverId: "controller", pluginId: "cloud", signal: new AbortController().signal },
    {
      id: "wake",
      matches: () => true,
      prepare: async () => {
        attempts++;
        if (attempts === 1) throw new Error("Start failed");
        online();
      },
    },
  );
  await expect(manager.prepare({ serverId: "remote", reason: "agent.send" })).rejects.toThrow(
    "Start failed",
  );
  expect(manager.snapshot("remote")).toEqual({ phase: "failed", message: "Start failed" });
  await manager.prepare({ serverId: "remote", reason: "agent.send" });
  expect(attempts).toBe(2);
});

test("cancel releases all waiting conversations and plugin removal cancels its active prepare", async () => {
  const { manager } = setup();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const remove = manager.register(
    { serverId: "controller", pluginId: "cloud", signal: new AbortController().signal },
    {
      id: "wake",
      matches: () => true,
      prepare: async () => {
        entered();
        await new Promise<void>(() => {});
      },
    },
  );
  const first = manager.prepare({ serverId: "remote", reason: "agent.send" });
  const rejected = expect(first).rejects.toThrow("cancelled");
  await ready;
  manager.cancel("remote");
  await rejected;
  const enteredAgain = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const second = manager.prepare({ serverId: "remote", reason: "agent.create" });
  const unloaded = expect(second).rejects.toThrow("controller plugin stopped");
  await enteredAgain;
  remove();
  await unloaded;
});

test("a controller that never becomes ready reaches the startup deadline", async () => {
  const manager = new HostPreflight({
    host: (serverId) => ({
      serverId,
      label: serverId,
      status: serverId === "controller" ? "online" : "offline",
    }),
    subscribe: () => () => {},
    connect: () => {},
    timeoutMs: 1,
  });
  manager.register(
    { serverId: "controller", pluginId: "cloud", signal: new AbortController().signal },
    { id: "wake", matches: () => true, prepare: async () => new Promise<void>(() => {}) },
  );
  await expect(manager.prepare({ serverId: "remote", reason: "agent.create" })).rejects.toThrow(
    "Host startup timed out",
  );
  expect(manager.snapshot("remote")?.phase).toBe("failed");
});
