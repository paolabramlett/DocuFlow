import Link from "next/link";
import { signOut } from "@/features/auth/actions";
import {
  IconBlueprints,
  IconCases,
  IconClients,
  IconMembers,
  IconSettings,
  type IconProps,
} from "./icons";

export interface ShellAccount {
  readonly name: string;
  readonly sub: string;
}

type NavKey = "cases" | "blueprints" | "clients" | "members" | "settings";

const NAV: { key: NavKey; label: string; href: string; Icon: (p: IconProps) => React.ReactElement }[] = [
  { key: "cases", label: "Expedientes", href: "/cases", Icon: IconCases },
  { key: "blueprints", label: "Plantillas", href: "/blueprints", Icon: IconBlueprints },
  { key: "clients", label: "Clientes", href: "/clients", Icon: IconClients },
  { key: "members", label: "Miembros", href: "/members", Icon: IconMembers },
  { key: "settings", label: "Configuración", href: "/settings", Icon: IconSettings },
];

const DEFAULT_ACCOUNT: ShellAccount = { name: "Notaría Central", sub: "Personal" };

/** Solid Royal Blue 700 navigation — the product's identity anchor (see DESIGN.md). */
export function Sidebar({ active, account = DEFAULT_ACCOUNT }: { active: NavKey; account?: ShellAccount }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col bg-royal-700 px-3 py-5 text-white">
      <div className="mb-8 flex items-center gap-2.5 px-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/img/LogoMark-white.png" alt="" className="size-8 rounded-input" />
        <span className="text-[15px] font-semibold tracking-tight">Avanza</span>
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
        <div className="flex items-center gap-2.5 px-3 py-2">
          <div className="flex size-8 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">
            {initials(account.name)}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium">{account.name}</div>
            <div className="truncate text-xs text-white/60">{account.sub}</div>
          </div>
          <form action={signOut}>
            <button type="submit" title="Cerrar sesión" className="rounded-input p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white">
              <IconLogout className="size-[18px]" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

const IconLogout = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 17l-5-5 5-5M5 12h11" />
  </svg>
);

/** The app shell: royal sidebar + main column. Children fill the main area. */
export function AppShell({ active, account, children }: { active: NavKey; account?: ShellAccount; children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-app-bg text-text-primary">
      <Sidebar active={active} account={account} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
