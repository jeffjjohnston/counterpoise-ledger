import { Navigate } from "react-router";

/** The old account page. Its contents moved to the settings page. */
export function AccountRedirect() {
  return <Navigate to="/settings#account" replace />;
}
