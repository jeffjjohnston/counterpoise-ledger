import { LoginForm } from "./LoginForm";

/**
 * A static page. The form asks the API in the browser whether registration is
 * open, because the flag and the user count both change after deploy.
 */
export default function LoginPage() {
  return <LoginForm />;
}
