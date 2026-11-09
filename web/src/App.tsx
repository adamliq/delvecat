import { lazy, Suspense } from "react";
import { HashRouter, Link, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useCatalogState } from "./lib/CatalogContext";
import { IN_SPLUNK } from "./lib/splunkSource";
import { BuildPage } from "./pages/BuildPage";
import { CoveragePage } from "./pages/CoveragePage";
import { DataProductPage } from "./pages/DataProductPage";
import { DomainsPage } from "./pages/DomainsPage";
import { EntityPage } from "./pages/EntityPage";
import { GlossaryPage } from "./pages/GlossaryPage";
import { GovernancePage } from "./pages/GovernancePage";
import { HealthPage } from "./pages/HealthPage";
import { ComparePage } from "./pages/ComparePage";
import { InsightsPage } from "./pages/InsightsPage";
import { PropertiesPage } from "./pages/PropertiesPage";
import { Home } from "./pages/Home";
import { SchemasPage } from "./pages/SchemasPage";
import { SearchPage } from "./pages/SearchPage";

// SQLite (about 1 MB) loads only when the console is opened.
const SqlPage = lazy(() => import("./pages/SqlPage"));

function Body() {
  const { state } = useCatalogState();
  const { pathname } = useLocation();
  // In the Splunk app the Build page works with or without a catalog.
  if (IN_SPLUNK && pathname === "/build") return <BuildPage />;
  if (state.status === "loading") return <p className="muted">Loading catalog…</p>;
  if (state.status === "error") {
    return (
      <div className="stack">
        <h1>No catalog loaded</h1>
        <p className="error">{state.message}</p>
        {IN_SPLUNK ? (
          <p>
            <Link to="/build">Build the catalog of this Splunk</Link> (needs the <code>delvecat_publisher</code>{" "}
            role), or publish one with <code>delvecat-ingest publish</code>.
          </p>
        ) : (
          <p>
            Use <strong>Open bundle</strong> to load a <code>catalog.json</code> produced by{" "}
            <code>delvecat-ingest</code>. The file is read in your browser and is not uploaded.
          </p>
        )}
      </div>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/entity/:id" element={<EntityPage />} />
      <Route path="/glossary" element={<GlossaryPage />} />
      <Route path="/domains" element={<DomainsPage />} />
      <Route path="/domains/:name" element={<DomainsPage />} />
      <Route path="/products/:name" element={<DataProductPage />} />
      <Route path="/properties" element={<PropertiesPage />} />
      <Route path="/sql" element={<Suspense fallback={<p className="muted">Loading SQL console…</p>}><SqlPage /></Suspense>} />
      <Route path="/insights" element={<InsightsPage />} />
      <Route path="/compare" element={<ComparePage />} />
      <Route path="/schemas" element={<SchemasPage />} />
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
