import { isRegistrationOpen } from "@/lib/registration";
import { LoginForm } from "./LoginForm";

/**
 * Whether registration is open depends on the database, so this page cannot be
 * prerendered — the Docker build has no database and the query fails the build.
 * It would also be wrong to bake the answer in at build time: the flag and the
 * user count both change after deploy.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  return <LoginForm registrationOpen={await isRegistrationOpen()} />;
}
