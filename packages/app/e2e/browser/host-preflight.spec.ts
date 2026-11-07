import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import { seedMockAgentWorkspace, buildAgentRoute } from "../support/helpers/mock-agent";
import {
  composerLocator,
  sendComposerWithButton,
  expectComposerVisible,
  attachComposerTestImage,
  expectAttachmentPill,
} from "../support/helpers/composer";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { clickNewChat } from "../support/helpers/launcher";
import { pluginRequirements } from "../support/helpers/plugin-fixture";

test("a controller plugin prepares an offline conversation, preserves failed sends, and supports cancellation", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-host-preflight-"));
  const gate = path.join(directory, "gate");
  const calls = path.join(directory, "calls");
  await writeFile(gate, "hold");
  const primary = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await primary.getDaemonConfig();
  const remote = await startIsolatedHostDaemon("preflight-remote");
  const agent = await seedMockAgentWorkspace({
    port: remote.port,
    repoPrefix: "preflight-",
    title: "Remote preflight",
    featureValues: { mockAssistantResponse: "Remote preflight response" },
  });
  try {
    await mkdir(path.join(directory, "shared"));
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "host-preflight", requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "shared/wake.ts"),
      `import {defineRpc} from '@getpaseo/plugin';import {z} from 'zod';export const wake=defineRpc({name:'test.wake',input:z.object({}),output:z.object({ready:z.boolean()})});`,
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `import {wake} from './shared/wake';export default function(client){return client.addHostPreflight({id:'wake',matches:({serverId})=>serverId===${JSON.stringify(remote.serverId)},prepare:async({reportProgress})=>{reportProgress('Starting test cloud machine…');await client.rpc(wake,{});}});}`,
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import {readFile,appendFile} from 'node:fs/promises';import {wake} from './shared/wake';export default function(server){server.handle(wake,async()=>{await appendFile(${JSON.stringify(calls)},'start\\n');for(let i=0;i<600;i++){const state=await readFile(${JSON.stringify(gate)},'utf8');if(state==='fail')throw new Error('Simulated startup failure');if(state==='ready')return {ready:true};await new Promise(r=>setTimeout(r,50));}throw new Error('Test startup deadline');});return()=>{};}`,
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
    await page.goto(buildAgentRoute(agent.workspaceId, agent.agentId, remote.serverId));
    await expectComposerVisible(page);
    await remote.stop();
    // Merely displaying the cached conversation must never start its machine.
    await expect.poll(async () => readFile(calls, "utf8").catch(() => "missing")).toBe("missing");
    const prompt = "Resume my remote conversation";
    await composerLocator(page).fill(prompt);
    await sendComposerWithButton(page);
    await expect(page.getByText("Starting test cloud machine…", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel startup wait", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("starting-wide.png") });
    await remote.restart();
    await writeFile(gate, "ready");
    await expect(page.getByText("Remote preflight response", { exact: true }).first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Cancel startup wait", exact: true }),
    ).toHaveCount(0);
    await expect(composerLocator(page)).toHaveValue("");

    await attachComposerTestImage(page);
    await remote.stop();
    await writeFile(gate, "fail");
    await composerLocator(page).fill("Keep this draft after failure");
    await sendComposerWithButton(page);
    await expect(page.getByText(/Simulated startup failure/).first()).toBeVisible();
    await expect(composerLocator(page)).toHaveValue("Keep this draft after failure");
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await page.screenshot({ path: test.info().outputPath("startup-failure.png") });

    await writeFile(gate, "hold");
    await page.setViewportSize({ width: 390, height: 844 });
    await sendComposerWithButton(page);
    await expect(page.getByText("Starting test cloud machine…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel startup wait", exact: true }).click();
    await expect(composerLocator(page)).toHaveValue("Keep this draft after failure");
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await expect(page.getByText(/machine may continue starting/).first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("startup-cancelled-compact.png") });
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["start", "start", "start"]);

    await page.setViewportSize({ width: 1280, height: 900 });
    await clickNewChat(page);
    await expect(page.getByText("Starting test cloud machine…", { exact: true })).toBeVisible();
    await expect(composerLocator(page)).toBeEditable();
    await composerLocator(page).fill("First message in a new remote conversation");
    await page.screenshot({ path: test.info().outputPath("new-conversation-startup.png") });
    await remote.restart();
    await writeFile(gate, "ready");
    await expect(
      page.getByRole("button", { name: "Cancel startup wait", exact: true }),
    ).toHaveCount(0, { timeout: 45_000 });
    await sendComposerWithButton(page);
    await expect(
      page
        .getByTestId("user-message")
        .filter({ hasText: "First message in a new remote conversation" }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(composerLocator(page)).toHaveValue("");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "start",
      "start",
      "start",
      "start",
    ]);
  } finally {
    await writeFile(gate, "ready");
    await remote.restart();
    await agent.cleanup();
    await remote.close();
    await primary.removePlugin("host-preflight");
    await primary.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await primary.close();
    await rm(directory, { recursive: true, force: true });
  }
});
