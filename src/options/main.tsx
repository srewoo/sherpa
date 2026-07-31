import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Options } from "./Options.js";
import "@/ui/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("options root element missing");
createRoot(container).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
