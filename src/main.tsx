import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AnalysisApp from "./analysis-app";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AnalysisApp />
  </StrictMode>,
);
