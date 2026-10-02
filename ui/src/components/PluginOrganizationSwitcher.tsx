import { useState, type ReactNode } from "react";
import type { PluginOrganizationSwitcherProps } from "@paperclipai/plugin-sdk/ui";
import { useAccountIdentity, useCompanyListQuery } from "@/api/companies-query";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { useSignOut } from "@/hooks/useSignOut";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

/** Optional replacement; the built-in menu stays usable throughout rollout. */
export function PluginOrganizationSwitcher({ children, open: controlledOpen, onOpenChange }: {
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { userId, settled } = useAccountIdentity();
  const { selectedCompanyId } = useCompany();
  const companyList = useCompanyListQuery();
  // Selection is component state and can outlive its account until an effect
  // clears it. Resolve it against this account's query before mounting plugins.
  const selectedCompany = companyList.data?.companies.find(company => company.id === selectedCompanyId) ?? null;
  const contextSettled = settled && companyList.isSuccess && !companyList.data?.unauthorized
    && (selectedCompanyId === null || selectedCompany !== null);
  return (
    <OrganizationSwitcher key={JSON.stringify([userId, selectedCompanyId])}
      settled={contextSettled} companyId={selectedCompanyId}
      company={selectedCompany} open={controlledOpen} onOpenChange={onOpenChange}>
      {children}
    </OrganizationSwitcher>
  );
}

function OrganizationSwitcher({ children, settled, companyId, company, open: controlledOpen, onOpenChange }: {
  children: ReactNode; settled: boolean; companyId: string | null;
  company: { name: string; issuePrefix: string; logoUrl?: string | null } | null;
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  function closeNavigation() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }
  const signOut = useSignOut({ onSignedOut: closeNavigation });
  const { slots, errorMessage } = usePluginSlots({ slotTypes: ["organizationSwitcher"], companyId, enabled: settled });
  // Never choose an arbitrary winner for a replacement surface.
  if (!settled || errorMessage || slots.length !== 1) return children;
  const props: PluginOrganizationSwitcherProps = {
    organizationSwitcher: {
      currentCompany: company ? { name: company.name, logoUrl: company.logoUrl ?? null } : null,
      collapsed: collapsed && !peeking, open, onOpenChange: setOpen,
      onNavigate: closeNavigation, onSignOut: () => signOut.mutate(), signingOut: signOut.isPending,
      renderIcon: (name, logoUrl, inMenu) => <CompanyPatternIcon companyName={name} logoUrl={logoUrl}
        className={inMenu
          ? "size-(--organization-popover-avatar-size) shrink-0 rounded-lg text-(length:--text-micro)"
          : "size-5 shrink-0 rounded-md text-(length:--text-micro)"} />,
    },
  };
  return <PluginSlotMount slot={slots[0]!}
    context={{ companyId, companyPrefix: company?.issuePrefix ?? null }}
    componentProps={{ ...props }} fallback={children} />;
}
