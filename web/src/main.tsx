import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CatalogProvider } from "./lib/CatalogContext";
import "./styles.css";

function mount() {
  // index.html has #root; Splunk's page template does not, so add one there.
  let root = document.getElementById("root");
  if (!root) {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  }
  createRoot(root).render(
    <StrictMode>
      <CatalogProvider>
        <App />
      </CatalogProvider>
    </StrictMode>,
  );
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
