import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import {
  seedMockAgentWorkspace,
  buildAgentRoute,
} from "../support/helpers/mock-agent";
import { expectComposerVisible } from "../support/helpers/composer";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { addConnectedHostAndReload, reloadPreservingHostRegistry } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { openCompactWorkspaceMenu } from "../support/helpers/compact-workspace-scripts";

test("a controller header remains usable on a disconnected host after app reload", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-host-header-"));
  const calls = path.join(directory, "calls");
  const primary = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await primary.getDaemonConfig();
  const remote = await startIsolatedHostDaemon("header-remote");
  const agent = await seedMockAgentWorkspace({
    port: remote.port,
    repoPrefix: "header-",
    title: "Remote header",
  });
  try {
    await mkdir(path.join(directory, "shared"));
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "host-header", requirements: pluginRequirements })
    );
    await writeFile(
      path.join(directory, "shared/rpc.ts"),
      `import {defineRpc} from '@getpaseo/plugin';import {z} from 'zod';export const start=defineRpc({name:'test.start',input:z.object({}),output:z.object({ready:z.boolean()})});`
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import {appendFile} from 'node:fs/promises';import {start} from './shared/rpc';export default function(server){server.handle(start,async()=>{await appendFile(${JSON.stringify(
        calls
      )},'start\\n');return {ready:true};});return()=>{};}`
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `
import React from 'react';
import {Text,View} from 'react-native';
import {useWorkspace,useRpc} from '@getpaseo/plugin/client';
import {MenuAction} from '@getpaseo/plugin/client/ui';
import {start} from './shared/rpc';
function Controls({host,workspaceId,theme}) {
  const workspace=useWorkspace(workspaceId,w=>w.id);
  const invoke=useRpc(start);
  return <View><Text style={{color:theme.colors.foreground}}>Target {host.id} / {workspace}</Text>
    <MenuAction onSelect={()=>invoke({})}>Start machine</MenuAction></View>;
}
export default function(client) {
  const menu=client.addHeaderButton({id:'machine',serverId:${JSON.stringify(
    remote.serverId
  )},
    button:{title:'Cloud environment',label:'Cloud',icon:'Cloud',behavior:{kind:'popover',Content:Controls}}});
  return ()=>menu.remove();
}`
    );
    await primary.patchDaemonConfig({ pluginsEnabled: true });
    await primary.installDirectoryPlugin(directory);
    await gotoAppShell(page);
    await addConnectedHostAndReload(page, {
      serverId: remote.serverId,
      label: "Cloud test",
      port: remote.port,
    });
    await page.evaluate(() => {
      const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
      if (!nonce) throw new Error("E2E registry seed is missing");
      localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
    });
    await page.goto(
      buildAgentRoute(agent.workspaceId, agent.agentId, remote.serverId)
    );
    await expectComposerVisible(page);
    await remote.stop();
    await reloadPreservingHostRegistry(page);
    const menu = page.getByRole("button", {
      name: "Cloud environment",
      exact: true,
    });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(
      page.getByText(`Target ${remote.serverId} / ${agent.workspaceId}`, {
        exact: true,
      })
    ).toBeVisible();
    expect(await readFile(calls, "utf8").catch(() => "missing")).toBe(
      "missing"
    );
    await page
      .getByRole("menuitem", { name: "Start machine", exact: true })
      .click();
    await expect.poll(() => readFile(calls, "utf8")).toBe("start\n");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await openCompactWorkspaceMenu(page);
    await page
      .getByRole("menuitem", { name: "Cloud environment", exact: true })
      .click();
    await expect(
      page.getByText(`Target ${remote.serverId} / ${agent.workspaceId}`, {
        exact: true,
      })
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("offline-controller-menu-compact.png"),
    });
    await page.keyboard.press("Escape");
    await remote.restart();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectComposerVisible(page);
    expect(await readFile(calls, "utf8")).toBe("start\n");
    await primary.removePlugin("host-header");
    await expect(menu).toHaveCount(0);
  } finally {
    await remote.restart();
    await agent.cleanup();
    await remote.close();
    await primary.removePlugin("host-header").catch(() => undefined);
    await primary.patchDaemonConfig({
      pluginsEnabled: previous.config.pluginsEnabled ?? false,
    });
    await primary.close();
    await rm(directory, { recursive: true, force: true });
  }
});
