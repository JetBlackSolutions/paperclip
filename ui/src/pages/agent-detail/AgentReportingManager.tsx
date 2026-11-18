import { Identity } from "@/components/Identity";
import { humanReportingOptions, reportingManagerPatch } from "@/lib/human-reporting";
import { Pencil, UserRound } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { ReportsToPicker } from "@/components/ReportsToPicker";
import { AgentIdentityChipContent, agentIdentityChipClass } from "@/components/agents/AgentIdentityChip";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { agentDetailHref } from "../agent-detail-navigation";

/** A manager cannot be the agent itself or any member of its reporting subtree. */
export function invalidManagerIds(agentId: string, agents: Agent[]): string[] {
  const invalid = new Set([agentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const agent of agents) {
      if (agent.reportsTo && invalid.has(agent.reportsTo) && !invalid.has(agent.id)) {
        invalid.add(agent.id);
        changed = true;
      }
    }
  }
  return [...invalid];
}

export function AgentReportingManager({ agent }: { agent: Agent }) {
  const client = useQueryClient();
  const directory = useQuery({
    queryKey: queryKeys.agents.list(agent.companyId),
    queryFn: () => agentsApi.list(agent.companyId),
  });
  const org = useQuery({ queryKey: queryKeys.org(agent.companyId), queryFn: () => agentsApi.org(agent.companyId) });
  const orgView = useQueryView(org);
  const options = humanReportingOptions(org.data ?? [], agent.id);
  const humanManager = options.humans.find((human) => human.id === agent.reportsToUserId);
  const directoryView = useQueryView(directory);
  const update = useMutation({
    mutationFn: (patch: ReturnType<typeof reportingManagerPatch>) => agentsApi.update(agent.id, patch, agent.companyId),
    onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ["agents"] }), client.invalidateQueries({ queryKey: queryKeys.org(agent.companyId) })]); },
  });
  const agents = directory.data ?? [];
  const manager = !agent.reportsToUserId && agents.find((candidate) => candidate.id === agent.reportsTo);
  const disabled = !directory.data || !org.data || directoryView.kind === "error" || orgView.kind === "error" || update.isPending;
  return <div className="flex flex-col gap-1.5 px-(--agent-detail-module-inset) py-1.5 text-sm">
    <span className="text-muted-foreground">Reports to:</span>
    <div className="flex items-center gap-1.5">
      {humanManager ? <Link to={`/company/settings/members?member=${encodeURIComponent(humanManager.id)}`} className={`${agentIdentityChipClass} no-underline`}>
        <Identity name={humanManager.name} avatarUrl={humanManager.image} size="sm" />
      </Link> : null}
      {manager ? <Link to={agentDetailHref(agentRouteRef(manager))} className={`${agentIdentityChipClass} no-underline`}>
        <AgentIdentityChipContent agent={manager} />
      </Link> : null}
      <ReportsToPicker
        agents={agents}
        value={agent.reportsTo}
        onChange={(id) => update.mutate(reportingManagerPatch("agent", id))}
        humans={options.humans}
        humanValue={agent.reportsToUserId}
        onHumanChange={(id) => update.mutate(reportingManagerPatch("user", id))}
        disabledHumanIds={options.blockedHumans}
        disabled={disabled}
        disabledAgentIds={[...invalidManagerIds(agent.id, agents), ...options.blockedAgents]}
        trigger={<button type="button" disabled={disabled} aria-label={(manager || humanManager) ? "Change manager" : "Choose manager"}
          className={`${(manager || humanManager) ? "agent-identity-chip inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground transition-colors" : agentIdentityChipClass} disabled:cursor-not-allowed disabled:opacity-50`}>
          {(manager || humanManager) ? <Pencil className="size-3.5" aria-hidden /> : <><UserRound className="size-5 text-muted-foreground" aria-hidden /><span>{(agent.reportsTo || agent.reportsToUserId) ? "Manager unavailable" : "No manager"}</span></>}
        </button>}
      />
    </div>
    {directoryView.kind === "error" ? <QueryErrorState error={directoryView.error} size="inline" action="load agents" onRetry={directoryView.retry} retrying={directoryView.isFetching} /> : null}
    {orgView.kind === "error" ? <QueryErrorState error={orgView.error} size="inline" action="load human managers" onRetry={orgView.retry} retrying={orgView.isFetching} /> : null}
    {update.error ? <QueryErrorState error={update.error} size="inline" action="change manager" /> : null}
  </div>;
}
