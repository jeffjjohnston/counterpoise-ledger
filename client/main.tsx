import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "./routes";
import { startVersionCheck } from "./version-check";
import "@/app/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

startVersionCheck(router);

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
