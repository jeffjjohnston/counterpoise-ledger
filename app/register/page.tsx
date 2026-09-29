import { RegisterForm } from "./RegisterForm";

/**
 * A static page. The form asks the API in the browser whether registration is
 * open, and goes to /login when it is closed.
 */
export default function RegisterPage() {
  return <RegisterForm />;
}
