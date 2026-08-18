import { redirect } from "next/navigation";
import { isRegistrationOpen } from "@/lib/registration";
import { RegisterForm } from "./RegisterForm";

/**
 * Same reason as /login: the gate is a database question, so prerendering both
 * breaks the Docker build and would freeze the answer at build time.
 */
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  // Presentation only — POST /api/auth/register is the security boundary.
  // This exists so a closed instance does not serve a form that can only fail.
  if (!(await isRegistrationOpen())) redirect("/login");

  return <RegisterForm />;
}
