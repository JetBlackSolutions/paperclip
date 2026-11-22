import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ASSIGNEE_SUGGESTION_MAX_CANDIDATES, type AssigneeSuggestionResult } from "@paperclipai/shared";
import { Sparkles } from "lucide-react";
import { agentsApi } from "../api/agents";
import { decisionModelsApi } from "../api/decision-models";
import { routinesApi } from "../api/routines";
import {
  directLeadOf,
  shortlistAgents,
  suggestAssignee,
  type AssigneeSuggestion,
  type SuggestionAgent,
  type SuggestionTarget,
} from "../lib/assignee-suggestion";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";

/** How long typing must pause before the suggestion is worked out again. */
const TYPING_PAUSE_MS = 400;
/** A model is worth asking only once the request says something. */
const MIN_TEXT_FOR_MODEL = 12;

const valueOf = (target: SuggestionTarget) => `${target.kind}:${target.id}`;

interface Applied {
  suggestion: AssigneeSuggestion;
  source: "words" | "model";
  /** For a model's choice: the request it was made for. The choice lapses when the request changes. */
  text?: string;
}

export interface AssigneeSuggestionState {
  /** The suggestion now selected as the assignee, or null. */
  applied: Applied | null;
  /** The assignee the dialog started from, before any suggestion replaced it. */
  previousValue: string;
  /** Whether the company's decision model can be asked to choose. */
  canAskModel: boolean;
  askModel: () => void;
  askingModel: boolean;
  /** What the last model request came to when it selected nobody. */
  modelNote: string | null;
  /** Agents that would not start work now; they are not offered as alternatives. */
  unavailableAgentIds: readonly string[];
  /** True when the data behind suggestions could not be loaded. */
  loadFailed: boolean;
  retryLoad: () => void;
}

export function useAssigneeSuggestion(input: {
  /** True while the assignee is still the dialog's own default: the person has not chosen one. */
  auto: boolean;
  companyId: string | null | undefined;
  text: string;
  /** Agents that may receive tasks. */
  agents: readonly SuggestionAgent[];
  /** People that may receive tasks. */
  assignableUserIds: readonly string[];
  /** Agents that would not start work now. */
  unavailableAgentIds: readonly string[];
  currentValue: string;
  /** The assignee the dialog started from. The assignee returns to it when no suggestion applies. */
  defaultValue: string;
  /** Selects an assignee without recording it as the person's own choice. */
  onApply: (value: string) => void;
}): AssigneeSuggestionState {
  const { auto, companyId, agents, assignableUserIds, unavailableAgentIds, currentValue, defaultValue, onApply } = input;
  const [text, setText] = useState("");
  useEffect(() => {
    if (!auto) { setText(""); return; }
    const timer = setTimeout(() => setText(input.text), TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [auto, input.text]);

  const routinesQuery = useQuery({
    queryKey: queryKeys.routines.list(companyId!),
    queryFn: () => routinesApi.list(companyId!),
    enabled: Boolean(companyId) && auto,
    staleTime: 60_000,
  });
  const routines = routinesQuery.data;
  const availabilityQuery = useQuery({
    queryKey: ["decision-model", "availability", companyId],
    queryFn: () => decisionModelsApi.availability(companyId!),
    enabled: Boolean(companyId) && auto,
    staleTime: 60_000,
  });
  const availability = availabilityQuery.data;

  const computed = useMemo(
    // Routines are part of what an agent is known for; a match made without them could pick the wrong agent.
    () => (auto && routines && text.trim() ? suggestAssignee({ text, agents, routines, assignableUserIds, unavailableAgentIds }) : null),
    [auto, text, agents, routines, assignableUserIds, unavailableAgentIds],
  );
  // Callers may pass fresh arrays on every render; only a different suggestion counts as a change.
  const signature = JSON.stringify(computed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fromWords = useMemo(() => computed, [signature]);

  const [applied, setApplied] = useState<Applied | null>(null);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const appliedRef = useRef<Applied | null>(null);
  appliedRef.current = applied;
  // What a pending model request must still find true before its answer may be used.
  const liveRef = useRef({ auto, text: input.text });
  liveRef.current = { auto, text: input.text };

  // The person took over, or the dialog closed: forget the suggestion.
  useEffect(() => {
    if (auto) return;
    setApplied(null);
    setModelNote(null);
  }, [auto]);

  // Follow the words once typing has paused, until a model has been asked to choose.
  const settled = text === input.text && routines !== undefined;
  // A model's choice stands only for the request it was asked about.
  const modelChoiceStands = applied?.source === "model" && applied.text === input.text.trim();
  useEffect(() => {
    if (!auto || !settled || modelChoiceStands) return;
    if (fromWords) {
      setApplied({ suggestion: fromWords, source: "words" });
      if (valueOf(fromWords.target) !== currentValue) onApply(valueOf(fromWords.target));
    } else {
      // Nothing fits the request now: return to the default, also in a reopened draft that still holds an old suggestion.
      if (appliedRef.current) setApplied(null);
      if (defaultValue !== currentValue) onApply(defaultValue);
    }
    // Only a new suggestion should move the assignee; the other values are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, fromWords, settled]);

  const ask = useMutation({
    mutationFn: async () => ({
      askedText: input.text,
      result: await requestModelChoice(),
    }),
    onSuccess: ({ askedText, result }) => {
      // The person took over or changed the request while the model was choosing: the answer is stale.
      if (!liveRef.current.auto || liveRef.current.text !== askedText) return;
      applyModelChoice(result);
    },
    onError: () => {
      if (liveRef.current.auto) setModelNote("AI couldn't choose this time. The assignee is unchanged.");
    },
  });
  const requestModelChoice = () => agentsApi.suggestAssignee(companyId!, {
    text: input.text.trim().slice(0, 4000),
    candidateAgentIds: shortlistAgents(
      { text: input.text, agents: agents.filter((agent) => !unavailableAgentIds.includes(agent.id)), routines: routines ?? [], assignableUserIds },
      ASSIGNEE_SUGGESTION_MAX_CANDIDATES,
    ),
  });
  const applyModelChoice = (result: AssigneeSuggestionResult) => {
    if (result.status === "succeeded" && result.agentId && agents.some((agent) => agent.id === result.agentId)) {
      const target: SuggestionTarget = { kind: "agent", id: result.agentId };
      setModelNote(null);
      setApplied({
        source: "model",
        text: liveRef.current.text.trim(),
        suggestion: {
          target,
          reason: "specialist",
          matchedAgentIds: [result.agentId],
          matchedWords: [],
          lead: directLeadOf(result.agentId, agents, assignableUserIds, unavailableAgentIds),
        },
      });
      if (valueOf(target) !== currentValue) onApply(valueOf(target));
      return;
    }
    setModelNote(
      result.status === "succeeded"
        ? "AI found no clear fit, so the assignee is unchanged."
        : result.status === "unavailable"
          ? "AI suggestions aren't available right now. The assignee is unchanged."
          : "AI couldn't choose this time. The assignee is unchanged.",
    );
  };

  return {
    // Hidden at once when the person takes over, without waiting for the reset above.
    applied: auto ? applied : null,
    previousValue: defaultValue,
    // Routines shape the shortlist the model chooses from, so the button waits for them.
    canAskModel: auto && availability?.available === true && routines !== undefined
      && agents.length - unavailableAgentIds.length >= 2
      && input.text.trim().length >= MIN_TEXT_FOR_MODEL && !modelChoiceStands,
    askModel: () => ask.mutate(),
    askingModel: ask.isPending,
    modelNote: auto ? modelNote : null,
    unavailableAgentIds,
    loadFailed: auto && input.text.trim().length > 0 && (routinesQuery.isError || availabilityQuery.isError),
    retryLoad: () => {
      if (routinesQuery.isError) void routinesQuery.refetch();
      if (availabilityQuery.isError) void availabilityQuery.refetch();
    },
  };
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/**
 * One line under the new-task box that says who was suggested and why, with
 * the other sensible recipients one click away.
 */
export function AssigneeSuggestionNotice({ state, nameOf, onChoose, disabled }: {
  state: AssigneeSuggestionState;
  /** The display name for an assignee value such as `agent:<id>`. Null when it cannot be assigned. */
  nameOf: (value: string) => string | null;
  /** The person picks a recipient themselves; suggestions stop. */
  onChoose: (value: string) => void;
  disabled?: boolean;
}) {
  const { applied, previousValue, canAskModel, askModel, askingModel, modelNote, loadFailed, retryLoad } = state;
  if (!applied && !canAskModel && !askingModel && !modelNote && !loadFailed) return null;

  const suggestion = applied?.suggestion;
  const targetName = suggestion ? nameOf(valueOf(suggestion.target)) : null;
  const inSentence = (name: string) => (name === "Me" ? "me" : name);
  const words = suggestion?.matchedWords.map((word) => `“${word}”`).join(", ");
  const matchedNames = (suggestion?.matchedAgentIds ?? []).flatMap((id) => nameOf(`agent:${id}`) ?? []);

  const targetIsPerson = suggestion?.target.kind === "user";
  const leadName = targetName === "Me" ? "you" : targetName;
  let reason = "";
  if (suggestion && applied.source === "model") reason = "chosen by AI from your request";
  else if (suggestion?.reason === "lead") {
    reason = matchedNames.length > 1
      ? `${joinNames(matchedNames)} ${matchedNames.length === 2 ? "both" : "all"} fit and report to ${leadName}`
      : `${matchedNames[0] ?? "A report"} also fits and reports to ${leadName}`;
  } else if (words) reason = `matches ${words}`;

  // Other recipients worth one click: the specialist under a suggested lead, the lead above a specialist, and the earlier default.
  const alternatives: Array<{ value: string; label: string }> = [];
  const offer = (value: string, label: (name: string) => string) => {
    const name = nameOf(value);
    if (!name || !suggestion || value === valueOf(suggestion.target) || alternatives.some((item) => item.value === value)) return;
    alternatives.push({ value, label: label(inSentence(name)) });
  };
  const specialist = suggestion?.reason === "lead"
    ? suggestion.matchedAgentIds.find((id) => !state.unavailableAgentIds.includes(id))
    : undefined;
  if (specialist) offer(`agent:${specialist}`, (name) => `Send to ${name}`);
  if (suggestion?.lead) {
    const viaPerson = suggestion.lead.kind === "user";
    offer(valueOf(suggestion.lead), (name) => (viaPerson ? `Send to ${name} (lead, no AI usage)` : `Send to ${name} (lead)`));
  }
  if (previousValue) offer(previousValue, (name) => `Keep ${name}`);

  return (
    <div role="status" aria-live="polite" data-testid="assignee-suggestion" className="flex flex-col gap-1.5 pt-2 pb-2 text-xs text-muted-foreground">
      {suggestion && targetName ? (
        <p className="min-w-0">
          <Sparkles aria-hidden className="mr-1 inline size-3.5 align-text-bottom" />
          Suggested: <span className="font-medium text-foreground">{targetName}</span>
          {targetIsPerson ? " (no AI usage)" : ""}
          {reason ? ` · ${reason}` : ""}
        </p>
      ) : modelNote ? (
        <p>{modelNote}</p>
      ) : null}
      {loadFailed ? (
        <p role="alert" className="flex flex-wrap items-center gap-1.5">
          Couldn't load assignee suggestions.
          <Button type="button" variant="ghost" size="xs" onClick={retryLoad}>Retry</Button>
        </p>
      ) : null}
      {alternatives.length > 0 || canAskModel || askingModel ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {alternatives.map((item) => (
            <Button key={item.value} type="button" variant="outline" size="xs" disabled={disabled} onClick={() => onChoose(item.value)}>
              {item.label}
            </Button>
          ))}
          {canAskModel || askingModel ? (
            <Button type="button" variant="ghost" size="xs" disabled={disabled || askingModel} onClick={askModel}>
              {askingModel ? "Asking AI…" : suggestion ? "Ask AI instead" : "Ask AI to pick"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
