import { redirect } from "next/navigation";

// La app abre directo en el workspace de expedientes.
export default function Home() {
  redirect("/cases");
}
