import type { AdminDashboardAccessModel } from "../dashboard-data";
import { CREDIT_SURFACE_IDS } from "../../auth/credits";
import { personLabel } from "../format";
import { clientAccess } from "./person-access";
import { CreditTableIsland } from "./islands";
const labels = {codex:"Codex",grok:"Grok",xai:"xAI API"};
export function PersonCredits({model,personId}: {readonly model: AdminDashboardAccessModel;readonly personId: string}) {
  const named = model.selectedUser?.id === personId ? model.selectedUser : model.users.find(user=>user.id===personId);
  return <CreditTableIsland rows={CREDIT_SURFACE_IDS.map(surface=>{
    const state = model.creditStates?.find(state=>state.user_id===personId && state.surface_grant===`surface:${surface}:production`) ?? null;
    return {state,keyAccess:named ? clientAccess(model,named).find(access=>access.client===surface)!.state : "none",control:{id:`credit-policy-${encodeURIComponent(personId)}-${surface}`,action:`/admin/ui/users/${encodeURIComponent(personId)}/credits/${surface}`,clientLabel:labels[surface],personId,personLabel:personLabel(named,personId),mode:state?.mode ?? "disabled",monthlyAllowance:state?.mode === "limited" && state.monthly_allowance !== null ? String(state.monthly_allowance) : ""}};
  })}/>;
}
