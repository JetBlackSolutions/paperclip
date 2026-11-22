// @vitest-environment jsdom

import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssigneeSuggestionNotice, useAssigneeSuggestion } from "./AssigneeSuggestion";

const mockAgentsApi = vi.hoisted(() => ({ suggestAssignee: vi.fn() }));
const mockDecisionModelsApi = vi.hoisted(() => ({ availability: vi.fn() }));
const mockRoutinesApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/decision-models", () => ({ decisionModelsApi: mockDecisionModelsApi }));
vi.mock("../api/routines", () => ({ routinesApi: mockRoutinesApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [
  { id: "support", name: "Support bot", title: "Customer Support" },
  { id: "lead", name: "Atlas", title: "Web Delivery Lead" },
  { id: "wp", name: "Quill", title: "WordPress Developer", reportsTo: "lead" },
];
const names: Record<string, string> = { "agent:support": "Support bot", "agent:lead": "Atlas", "agent:wp": "Quill" };

function Harness({ text, initialAuto = true }: { text: string; initialAuto?: boolean }) {
  const [value, setValue] = useState("agent:support");
  const [auto, setAuto] = useState(initialAuto);
  const state = useAssigneeSuggestion({
    auto,
    companyId: "company-1",
    text,
    agents,
    assignableUserIds: [],
    unavailableAgentIds: [],
    currentValue: value,
    defaultValue: "agent:support",
    onApply: setValue,
  });
  return (
    <div>
      <output data-testid="assignee">{value}</output>
      <AssigneeSuggestionNotice
        state={state}
        nameOf={(id) => names[id] ?? null}
        onChoose={(id) => { setAuto(false); setValue(id); }}
      />
    </div>
  );
}

describe("assignee suggestion in the new-task box", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = (text: string) => act(async () => {
    root.render(
      <QueryClientProvider client={client}><Harness text={text} /></QueryClientProvider>,
    );
  });
  // Lets the typing pause elapse and pending requests settle.
  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(500); });
  const assignee = () => container.querySelector('[data-testid="assignee"]')?.textContent;
  const notice = () => container.querySelector('[role="status"]')?.textContent ?? "";
  const button = (label: RegExp) =>
    [...container.querySelectorAll("button")].find((element) => label.test(element.textContent ?? ""));
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockRoutinesApi.list.mockResolvedValue([]);
    mockDecisionModelsApi.availability.mockResolvedValue({ available: false, reason: "not_configured" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("selects the matching agent once typing pauses and says why", async () => {
    await render("Update the WordPress theme");
    expect(assignee()).toBe("agent:support");
    await settle();
    expect(assignee()).toBe("agent:wp");
    expect(notice()).toContain("Suggested: Quill · matches “WordPress”");
    expect(button(/Send to Atlas \(lead\)/)).toBeTruthy();
    expect(button(/Keep Support bot/)).toBeTruthy();
  });

  it("returns to the earlier assignee when the request no longer matches anyone", async () => {
    await render("Update the WordPress theme");
    await settle();
    await render("Book a flight to Denver");
    await settle();
    expect(assignee()).toBe("agent:support");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("stops suggesting once the person picks a recipient", async () => {
    await render("Update the WordPress theme");
    await settle();
    await act(async () => { button(/Send to Atlas/)!.click(); });
    expect(assignee()).toBe("agent:lead");
    await render("Update the WordPress theme and the plugins");
    await settle();
    expect(assignee()).toBe("agent:lead");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("waits for routines before it changes the assignee", async () => {
    let loaded!: (routines: unknown[]) => void;
    mockRoutinesApi.list.mockReturnValue(new Promise((resolve) => { loaded = resolve; }));
    await render("Update the WordPress theme");
    await settle();
    expect(assignee()).toBe("agent:support");
    await act(async () => { loaded([]); });
    await settle();
    expect(assignee()).toBe("agent:wp");
  });

  it("says so and offers a retry when suggestions cannot be loaded", async () => {
    mockRoutinesApi.list.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    await render("Update the WordPress theme");
    await settle();
    expect(assignee()).toBe("agent:support");
    expect(notice()).toContain("Couldn't load assignee suggestions.");
    await act(async () => { button(/Retry/)!.click(); });
    await settle();
    expect(assignee()).toBe("agent:wp");
    expect(notice()).not.toContain("Couldn't load");
  });

  it("offers no AI button when the company has no decision model", async () => {
    await render("Something vague that matches nobody at all");
    await settle();
    expect(button(/Ask AI/)).toBeUndefined();
  });

  it("asks the decision model on request and selects its choice", async () => {
    mockDecisionModelsApi.availability.mockResolvedValue({ available: true });
    mockAgentsApi.suggestAssignee.mockResolvedValue({ status: "succeeded", agentId: "wp" });
    await render("Something vague that matches nobody at all");
    await settle();
    expect(assignee()).toBe("agent:support");
    await act(async () => { button(/Ask AI to pick/)!.click(); });
    await settle();
    expect(mockAgentsApi.suggestAssignee).toHaveBeenCalledWith("company-1", {
      text: "Something vague that matches nobody at all",
      candidateAgentIds: expect.arrayContaining(["support", "lead", "wp"]),
    });
    expect(assignee()).toBe("agent:wp");
    expect(notice()).toContain("Suggested: Quill · chosen by AI from your request");
    expect(button(/Ask AI/)).toBeUndefined();
  });

  it("drops a model's choice when the request is rewritten", async () => {
    mockDecisionModelsApi.availability.mockResolvedValue({ available: true });
    mockAgentsApi.suggestAssignee.mockResolvedValue({ status: "succeeded", agentId: "wp" });
    await render("Something vague that matches nobody at all");
    await settle();
    await act(async () => { button(/Ask AI to pick/)!.click(); });
    await settle();
    expect(assignee()).toBe("agent:wp");
    await render("A different request that matches nobody either");
    await settle();
    expect(assignee()).toBe("agent:support");
    expect(notice()).not.toContain("chosen by AI");
    expect(button(/Ask AI to pick/)).toBeTruthy();
  });

  it("offers the AI button only once routines have loaded", async () => {
    mockDecisionModelsApi.availability.mockResolvedValue({ available: true });
    let loaded!: (routines: unknown[]) => void;
    mockRoutinesApi.list.mockReturnValue(new Promise((resolve) => { loaded = resolve; }));
    await render("Something vague that matches nobody at all");
    await settle();
    expect(button(/Ask AI/)).toBeUndefined();
    await act(async () => { loaded([]); });
    await settle();
    expect(button(/Ask AI to pick/)).toBeTruthy();
  });

  it("ignores a model answer that arrives after the person picked a recipient", async () => {
    mockDecisionModelsApi.availability.mockResolvedValue({ available: true });
    let answer!: (result: unknown) => void;
    mockAgentsApi.suggestAssignee.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    await render("Update the WordPress theme");
    await settle();
    await act(async () => { button(/Ask AI instead/)!.click(); });
    await act(async () => { button(/Send to Atlas/)!.click(); });
    await act(async () => { answer({ status: "succeeded", agentId: "support" }); });
    await settle();
    expect(assignee()).toBe("agent:lead");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("ignores a model failure for a request that has since been rewritten", async () => {
    mockDecisionModelsApi.availability.mockResolvedValue({ available: true });
    let fail!: (error: Error) => void;
    mockAgentsApi.suggestAssignee.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    await render("Something vague that matches nobody at all");
    await settle();
    await act(async () => { button(/Ask AI to pick/)!.click(); });
    await render("A different request that matches nobody either");
    await settle();
    await act(async () => { fail(new Error("offline")); });
    await settle();
    expect(notice()).not.toContain("AI couldn't choose");
  });

  it("keeps the assignee and says so when the model finds no fit", async () => {
    mockDecisionModelsApi.availability.mockResolvedValue({ available: true });
    mockAgentsApi.suggestAssignee.mockResolvedValue({ status: "succeeded", agentId: null });
    await render("Something vague that matches nobody at all");
    await settle();
    await act(async () => { button(/Ask AI to pick/)!.click(); });
    await settle();
    expect(assignee()).toBe("agent:support");
    expect(notice()).toContain("AI found no clear fit");
    // The note belongs to that request only.
    await render("Another request that matches nobody at all");
    await settle();
    expect(notice()).not.toContain("AI found no clear fit");
  });
});
