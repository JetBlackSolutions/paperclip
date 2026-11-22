import { z } from "zod";
import type { DecisionUnavailableReason } from "./decision-models.js";

/** The most agents one request may ask the decision model to choose between. */
export const ASSIGNEE_SUGGESTION_MAX_CANDIDATES = 19;

export const assigneeSuggestionRequestSchema = z.object({
  /** The request the person typed for the new task. */
  text: z.string().trim().min(1).max(4000),
  /** The agents to choose between. The server reads their details; the client sends ids only. */
  candidateAgentIds: z.array(z.string().uuid()).min(2).max(ASSIGNEE_SUGGESTION_MAX_CANDIDATES),
});
export type AssigneeSuggestionRequest = z.infer<typeof assigneeSuggestionRequestSchema>;

export type AssigneeSuggestionResult =
  /** `agentId` is null when the model judged that none of the candidates fits. */
  | { status: "succeeded"; agentId: string | null }
  | { status: "unavailable"; reason: DecisionUnavailableReason }
  | { status: "failed" };
