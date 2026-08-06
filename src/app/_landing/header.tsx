import Image from "next/image";
import Link from "next/link";

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-8">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/img/Logo-1.png" alt="Avanza" width={32} height={32} className="h-8 w-auto" />
        </Link>
        <nav aria-label="Principal" className="hidden items-center gap-8 text-sm font-medium text-text-secondary sm:flex">
          <a href="#precios" className="hover:text-text-primary">Precios</a>
          <a href="#faq" className="hover:text-text-primary">Preguntas frecuentes</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm font-medium text-text-secondary hover:text-text-primary">
            Iniciar sesión
          </Link>
          <Link
            href="/signup"
            className="rounded-input bg-royal-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-royal-700"
          >
            Empieza gratis
          </Link>
        </div>
      </div>
    </header>
  );
}
