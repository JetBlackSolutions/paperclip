/**
 * Suggests who should receive a new task from the words of the request.
 *
 * It matches the request against what the company already records about each
 * agent (name, title, capabilities and the routines the agent runs) and then
 * applies the reporting line: one clear specialist receives the task; a request
 * that fits several agents goes to the lead they share. It runs in the browser
 * and calls no model.
 */

export interface SuggestionAgent {
  id: string;
  name: string;
  title?: string | null;
  capabilities?: string | null;
  reportsTo?: string | null;
  reportsToUserId?: string | null;
}

export interface SuggestionRoutine {
  assigneeAgentId?: string | null;
  title: string;
  description?: string | null;
  status?: string | null;
}

export type SuggestionTarget =
  | { kind: "agent"; id: string }
  | { kind: "user"; id: string };

export interface AssigneeSuggestion {
  /** Who should receive the task. */
  target: SuggestionTarget;
  /** `specialist`: one agent clearly fits. `lead`: several agents fit and this is the lead they share. */
  reason: "specialist" | "lead";
  /** The agents whose records matched, best first. One for `specialist`, two or more for `lead`. */
  matchedAgentIds: string[];
  /** Words of the request that matched, as the person typed them, most telling first. */
  matchedWords: string[];
  /** The direct lead of the best match, when it is not already the target. */
  lead: SuggestionTarget | null;
}

export interface SuggestAssigneeInput {
  text: string;
  /** Agents that may receive tasks. */
  agents: readonly SuggestionAgent[];
  routines?: readonly SuggestionRoutine[];
  /** People who may receive tasks. A lead outside this list is never suggested. */
  assignableUserIds?: readonly string[];
  /** Agents that would not start work now, such as paused ones. They are never suggested but still count in the reporting line. */
  unavailableAgentIds?: readonly string[];
}

/** Words that say nothing about which agent fits. Role nouns are common to most agent titles. */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "do", "does", "for", "from", "get", "had",
  "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "just", "let", "like", "make", "me", "my", "need",
  "new", "no", "not", "now", "of", "on", "one", "or", "our", "out", "please", "so", "some", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "up", "us", "want", "was", "we", "what", "when", "which",
  "who", "will", "with", "would", "you", "your",
  "agent", "ai", "assistant", "bot", "coordinator", "lead", "manager", "specialist", "task", "team", "work",
]);

const FIELD_WEIGHT = { identity: 4, capabilities: 3, routineTitle: 2, routineBody: 1 } as const;
/**
 * The least evidence that counts as a match. One distinctive word in an agent's
 * name or title clears it; one passing word in a routine does not.
 */
const MIN_SCORE = 2;
/** Another agent "also fits" when it scores at least this share of the best score. */
const ALSO_FITS_RATIO = 0.7;
/** Agents this close to the best score are a tie that the words alone cannot break. */
const TIE_RATIO = 0.9;
/** The request must contain at least this many telling words. */
const MIN_QUERY_TERMS = 2;

/** Reduces a word to a rough stem so "invoices", "invoicing" and "invoice" match. */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.length > 4 && word.endsWith("e")) return word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function terms(text: string): string[] {
  return words(text).filter((word) => word.length > 1 && !STOP_WORDS.has(word)).map(stem);
}

interface AgentProfile {
  agent: SuggestionAgent;
  /** The strongest field weight at which the agent's records contain each term. */
  weights: Map<string, number>;
}

function buildProfiles(agents: readonly SuggestionAgent[], routines: readonly SuggestionRoutine[]): AgentProfile[] {
  const byId = new Map<string, AgentProfile>();
  const add = (profile: AgentProfile, text: string | null | undefined, weight: number) => {
    if (!text) return;
    for (const term of terms(text)) {
      if ((profile.weights.get(term) ?? 0) < weight) profile.weights.set(term, weight);
    }
  };
  for (const agent of agents) {
    const profile: AgentProfile = { agent, weights: new Map() };
    add(profile, agent.name, FIELD_WEIGHT.identity);
    add(profile, agent.title, FIELD_WEIGHT.identity);
    add(profile, agent.capabilities, FIELD_WEIGHT.capabilities);
    byId.set(agent.id, profile);
  }
  for (const routine of routines) {
    if (routine.status === "archived" || !routine.assigneeAgentId) continue;
    const profile = byId.get(routine.assigneeAgentId);
    if (!profile) continue;
    add(profile, routine.title, FIELD_WEIGHT.routineTitle);
    add(profile, routine.description, FIELD_WEIGHT.routineBody);
  }
  return [...byId.values()];
}

/** The chain of agent leads above an agent, nearest first. Stops at a cycle. */
function agentLeads(agentId: string, byId: Map<string, SuggestionAgent>): string[] {
  const chain: string[] = [];
  const seen = new Set([agentId]);
  let current = byId.get(agentId)?.reportsTo ?? null;
  while (current && !seen.has(current) && byId.has(current)) {
    chain.push(current);
    seen.add(current);
    current = byId.get(current)?.reportsTo ?? null;
  }
  return chain;
}

export function suggestAssignee(input: SuggestAssigneeInput): AssigneeSuggestion | null {
  // Kept as typed, so the reason shown to the person reads "WordPress", not "wordpress".
  const typed = (input.text.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word.toLowerCase()));
  const queryTerms = [...new Set(typed.map((word) => stem(word.toLowerCase())))];
  if (queryTerms.length < MIN_QUERY_TERMS || input.agents.length === 0) return null;

  const unavailable = new Set(input.unavailableAgentIds ?? []);
  // Unavailable agents are still scored: a request that fits one of them and a
  // colleague spans both, and belongs with their lead.
  const profiles = buildProfiles(input.agents, input.routines ?? []);
  // A word only one agent has counts in full; a word every agent shares counts for little.
  const agentsWithTerm = new Map<string, number>();
  for (const term of queryTerms) {
    agentsWithTerm.set(term, profiles.filter((profile) => profile.weights.has(term)).length);
  }
  const rarity = (term: string) => 1 - ((agentsWithTerm.get(term) ?? 1) - 1) / profiles.length;

  const scored = profiles
    .map((profile) => {
      const matched = queryTerms.filter((term) => profile.weights.has(term));
      const score = matched.reduce((sum, term) => sum + rarity(term) * (profile.weights.get(term) ?? 0), 0);
      return { profile, matched, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.profile.agent.name.localeCompare(b.profile.agent.name));

  const best = scored[0];
  if (!best || best.score < MIN_SCORE) return null;

  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const assignableUsers = new Set(input.assignableUserIds ?? []);
  const directLead = (agent: SuggestionAgent): SuggestionTarget | null => {
    if (agent.reportsTo && byId.has(agent.reportsTo)) {
      return unavailable.has(agent.reportsTo) ? null : { kind: "agent", id: agent.reportsTo };
    }
    if (agent.reportsToUserId && assignableUsers.has(agent.reportsToUserId)) return { kind: "user", id: agent.reportsToUserId };
    return null;
  };
  // The words that carried the match, strongest first; weak extras are left out of the reason.
  const matchedWordsFor = (entries: Array<{ profile: AgentProfile; matched: string[] }>) => {
    const strength = new Map<string, number>();
    for (const entry of entries) {
      for (const term of entry.matched) {
        strength.set(term, Math.max(strength.get(term) ?? 0, rarity(term) * (entry.profile.weights.get(term) ?? 0)));
      }
    }
    const ordered = [...strength].sort((a, b) => b[1] - a[1]);
    const strongest = ordered[0]?.[1] ?? 0;
    return ordered
      .filter(([, value]) => value >= strongest / 2)
      .slice(0, 3)
      .map(([term]) => typed.find((word) => stem(word.toLowerCase()) === term) ?? term);
  };

  const fits = scored.filter((entry) => entry.score >= best.score * ALSO_FITS_RATIO);
  if (fits.length > 1) {
    const fitIds = fits.map((entry) => entry.profile.agent.id);
    const lead = sharedLead(fitIds, byId, assignableUsers, unavailable);
    if (lead) {
      // The shared lead may itself be one of the matches; the rest are its reports.
      const reports = fitIds.filter((id) => !(lead.kind === "agent" && lead.id === id));
      return {
        target: lead,
        reason: "lead",
        matchedAgentIds: reports,
        matchedWords: matchedWordsFor(fits),
        lead: lead.kind === "agent" ? directLead(byId.get(lead.id)!) : null,
      };
    }
    // Several agents fit equally well and nobody leads them all: the words cannot decide.
    if (fits[1]!.score >= best.score * TIE_RATIO) return null;
  }
  if (unavailable.has(best.profile.agent.id)) return null;

  return {
    target: { kind: "agent", id: best.profile.agent.id },
    reason: "specialist",
    matchedAgentIds: [best.profile.agent.id],
    matchedWords: matchedWordsFor([best]),
    lead: directLead(best.profile.agent),
  };
}

/** The agent or person an agent reports to directly, when that lead may receive tasks. */
export function directLeadOf(
  agentId: string,
  agents: readonly SuggestionAgent[],
  assignableUserIds: readonly string[] = [],
): SuggestionTarget | null {
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) return null;
  if (agent.reportsTo && agents.some((candidate) => candidate.id === agent.reportsTo)) return { kind: "agent", id: agent.reportsTo };
  if (agent.reportsToUserId && assignableUserIds.includes(agent.reportsToUserId)) return { kind: "user", id: agent.reportsToUserId };
  return null;
}

/**
 * The agents worth asking a model to choose between: the best word matches
 * first, then their leads, then the agents nearest the top of the company.
 */
export function shortlistAgents(input: SuggestAssigneeInput, limit: number): string[] {
  const queryTerms = [...new Set(terms(input.text))];
  const profiles = buildProfiles(input.agents, input.routines ?? []);
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const matched = profiles
    .map((profile) => ({
      id: profile.agent.id,
      score: queryTerms.reduce((sum, term) => sum + (profile.weights.get(term) ?? 0), 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.id);
  const leads = matched.flatMap((id) => agentLeads(id, byId).slice(0, 1));
  const byDepth = [...input.agents]
    .sort((a, b) => agentLeads(a.id, byId).length - agentLeads(b.id, byId).length || a.name.localeCompare(b.name))
    .map((agent) => agent.id);
  const half = Math.ceil(limit / 2);
  return [...new Set([...matched.slice(0, half), ...leads.slice(0, half), ...matched, ...byDepth])].slice(0, limit);
}

/**
 * The nearest lead that every matching agent reports to, directly or through
 * other agents. An agent in the set that leads all the others is that lead.
 * A lead that would not start work is passed over for the next one up. When the
 * agents share no agent lead, a person they all report to directly is used.
 */
function sharedLead(
  agentIds: string[],
  byId: Map<string, SuggestionAgent>,
  assignableUsers: Set<string>,
  unavailable: Set<string>,
): SuggestionTarget | null {
  // Each agent's own id comes first, so a lead inside the set can be the answer.
  const chains = agentIds.map((id) => [id, ...agentLeads(id, byId)]);
  const [first, ...rest] = chains;
  const common = first!.find((candidate) => !unavailable.has(candidate) && rest.every((chain) => chain.includes(candidate)));
  if (common) return { kind: "agent", id: common };
  const person = byId.get(agentIds[0]!)?.reportsToUserId;
  if (person && assignableUsers.has(person) && agentIds.every((id) => byId.get(id)?.reportsToUserId === person)) {
    return { kind: "user", id: person };
  }
  return null;
}
