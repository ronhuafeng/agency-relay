import { createContext, useContext } from "react";
import type { ServiceContext } from "../auth/service-delegation";
import { memberHref } from "./member-href";

export const MemberScope = createContext<ServiceContext | null>(null);
export function useMemberScope() {
  const service = useContext(MemberScope);
  return {
    service,
    prefix: service ? `/me/service-accounts/${encodeURIComponent(service.id)}` : "/me",
    href: (view: Parameters<typeof memberHref>[0], key?: string) => memberHref(view, key, service?.id),
    label: (noun: string) => service ? `${service.display_name} · ${noun}` : `我的${noun}`
  };
}
