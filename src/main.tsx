import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./ui/app/App.tsx";
import { readSwitches } from "./ui/app/switches.ts";
import "./index.css";

// `?endings` replaces the app rather than steering it: `App` makes a session on
// its first render, and a preview of the last screen has no use for one. It is a
// dev page, so it is its own chunk and no player downloads it.
const EndingsPreview = lazy(() =>
  import("./ui/dev/EndingsPreview.tsx").then((m) => ({ default: m.EndingsPreview }))
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {readSwitches(location.search).endings ? (
      <Suspense>
        <EndingsPreview />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>
);
