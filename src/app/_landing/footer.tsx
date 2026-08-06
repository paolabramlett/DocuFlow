import Image from "next/image";
import Link from "next/link";

export function LandingFooter() {
  return (
    <footer className="bg-surface py-12">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="flex flex-col items-center justify-between gap-6 border-t border-border pt-8 sm:flex-row">
          <div className="flex items-center gap-2">
            <Image src="/img/Logo-1.png" alt="Avanza" width={28} height={28} className="h-7 w-auto" />
            <span className="text-sm font-semibold text-text-primary">Avanza</span>
          </div>
          <nav aria-label="Enlaces" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-text-secondary">
            <a href="#precios" className="hover:text-text-primary">Precios</a>
            <a href="#faq" className="hover:text-text-primary">Preguntas frecuentes</a>
            <Link href="/login" className="hover:text-text-primary">Iniciar sesión</Link>
            <Link href="/signup" className="hover:text-text-primary">Crear cuenta</Link>
          </nav>
        </div>
        <p className="mt-8 text-center text-xs text-text-secondary">
          © {new Date().getFullYear()} Avanza. Todos los derechos reservados.
        </p>
      </div>
    </footer>
  );
}
