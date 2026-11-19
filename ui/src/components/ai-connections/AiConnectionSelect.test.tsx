// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiConnectionBinding, AiManagedConnectionSummary } from "@paperclipai/shared";
import { AiConnectionSelect } from "./AiConnectionSelect";

vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

let root: Root;
let container: HTMLDivElement;
const account = (id: string, name: string, status: AiManagedConnectionSummary["status"]): AiManagedConnectionSummary => ({
  id, grantId: `${id}-grant`, companyId: "company", provider: "openrouter", method: "api_key", name,
  ownership: "shared", isDefault: false, status,
});
const accounts = [
  account("current", "Current key", "connected"),
  account("removed", "Removed key", "revoked"),
  account("in-use", "Removed key still in use", "revoked"),
];
const binding = (connection: AiManagedConnectionSummary): AiConnectionBinding => ({
  provider: "openrouter", method: "api_key", mode: "shared", connectionId: connection.id, grantId: connection.grantId,
});
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}
async function options(value: AiConnectionBinding) {
  flushSync(() => root.render(
    <AiConnectionSelect requirement={{ companyId: "company", provider: "openrouter", method: "api_key" }}
      connections={accounts} value={value} currentUserId="owner" agentId="agent" agentName="Nova"
      adapterType="opencode_local" onChange={vi.fn()} onConnect={vi.fn()} />,
  ));
  await settle();
  const trigger = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await settle();
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(option => option.textContent ?? "");
}
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });

it("hides removed accounts from the connection list", async () => {
  const shown = await options(binding(accounts[0]!));
  expect(shown.some(text => text.includes("Current key"))).toBe(true);
  expect(shown.some(text => text.includes("Removed key"))).toBe(false);
});

it("keeps showing a removed account the agent still uses, marked for reconnection", async () => {
  const shown = await options(binding(accounts[2]!));
  expect(shown.find(text => text.includes("Removed key still in use"))).toContain("Reconnect");
  expect(shown.some(text => text.includes("Removed key") && !text.includes("still in use"))).toBe(false);
});
