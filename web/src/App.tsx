import { HashRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useCatalogState } from "./lib/CatalogContext";
import { CoveragePage } from "./pages/CoveragePage";
import { EntityPage } from "./pages/EntityPage";
import { GlossaryPage } from "./pages/GlossaryPage";
import { GovernancePage } from "./pages/GovernancePage";
import { HealthPage } from "./pages/HealthPage";
import { Home } from "./pages/Home";
import { SearchPage } from "./pages/SearchPage";

function Body() {
  const { state } = useCatalogState();
  if (state.status === "loading") return <p className="muted">Loading catalog…</p>;
  if (state.status === "error") {
    return (
      <div className="stack">
        <h1>No catalog loaded</h1>
        <p className="error">{state.message}</p>
        <p>
          Use <strong>Open bundle</strong> to load a <code>catalog.json</code> produced by{" "}
          <code>delvecat-ingest</code>. The file is read in your browser and is not uploaded.
        </p>
      </div>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/entity/:id" element={<EntityPage />} />
      <Route path="/glossary" element={<GlossaryPage />} />
      <Route path="/coverage" element={<CoveragePage />} />
      <Route path="/health" element={<HealthPage />} />
      <Route path="/governance" element={<GovernancePage />} />
      <Route path="/glossary/:term" element={<GlossaryPage />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}

export function App() {
  return (
    <HashRouter>
      <Layout>
        <Body />
      </Layout>
    </HashRouter>
  );
}
