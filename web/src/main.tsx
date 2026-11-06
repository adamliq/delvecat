import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CatalogProvider } from "./lib/CatalogContext";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CatalogProvider>
      <App />
    </CatalogProvider>
  </StrictMode>,
);
