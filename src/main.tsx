import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./ui/app/App.tsx";
import { EndingsPreview } from "./ui/dev/EndingsPreview.tsx";
import { readSwitches } from "./ui/app/switches.ts";
import "./index.css";

// `?endings` replaces the app rather than steering it: `App` makes a session on
// its first render, and a preview of the last screen has no use for one.
createRoot(document.getElementById("root")!).render(
  <StrictMode>{readSwitches(location.search).endings ? <EndingsPreview /> : <App />}</StrictMode>
);
