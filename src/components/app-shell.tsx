import Link from "next/link";
import {
  IconBlueprints,
  IconCases,
  IconClients,
  IconMembers,
  IconSettings,
  type IconProps,
} from "./icons";

type NavKey = "cases" | "blueprints" | "clients" | "members";

const NAV: { key: NavKey; label: string; href: string; Icon: (p: IconProps) => React.ReactElement }[] = [
  { key: "cases", label: "Expedientes", href: "/cases", Icon: IconCases },
  { key: "blueprints", label: "Plantillas", href: "/blueprints", Icon: IconBlueprints },
  { key: "clients", label: "Clientes", href: "/clients", Icon: IconClients },
  { key: "members", label: "Miembros", href: "/members", Icon: IconMembers },
];

/** Solid Royal Blue 700 navigation — the product's identity anchor (see DESIGN.md). */
export function Sidebar({ active }: { active: NavKey }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col bg-royal-700 px-3 py-5 text-white">
      <div className="mb-8 flex items-center gap-2.5 px-2">
        <div className="flex size-8 items-center justify-center rounded-input bg-white/15 text-sm font-bold">D</div>
        <span className="text-[15px] font-semibold tracking-tight">DocuFlow</span>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map(({ key, label, href, Icon }) => {
          const isActive = key === active;
          return (
            <Link
              key={key}
              href={href}
              className={`flex items-center gap-3 rounded-input px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10 hover:text-white"
              }`}
            >
              <Icon className="size-[18px]" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-1 border-t border-white/10 pt-3">
        <button className="flex items-center gap-3 rounded-input px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white">
          <IconSettings className="size-[18px]" />
          Configuración
        </button>
        <div className="mt-1 flex items-center gap-2.5 px-3 py-2">
          <div className="flex size-8 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">NC</div>
          <div className="leading-tight">
            <div className="text-sm font-medium">Notaría Central</div>
            <div className="text-xs text-white/60">Personal</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** The app shell: royal sidebar + main column. Children fill the main area. */
export function AppShell({ active, children }: { active: NavKey; children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-app-bg text-text-primary">
      <Sidebar active={active} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
