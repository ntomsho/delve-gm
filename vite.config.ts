import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * THE API KEY NEVER REACHES THE BROWSER.
 *
 * `loadEnv(mode, cwd, "")` — note the empty prefix — reads every key out of
 * .env.local, including un-prefixed ones. That is what lets this config see
 * ANTHROPIC_API_KEY. It is NOT what exposes it: Vite only inlines `VITE_`-
 * prefixed variables into client code, and the key deliberately is not one.
 *
 * The key is attached to the outbound request by the proxy below, which runs
 * in the dev server process. The client calls `/api/anthropic/...` and has no
 * way to read the header it will be given. That keeps the client's call shape
 * identical to what a real backend would serve later.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.ANTHROPIC_API_KEY;

  return {
    plugins: [react(), tailwindcss()],

    server: {
      proxy: {
        "/api/anthropic": {
          target: "https://api.anthropic.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (apiKey) proxyReq.setHeader("x-api-key", apiKey);
              proxyReq.setHeader("anthropic-version", "2023-06-01");
              // The request originates here, not in a page, so the browser
              // escape hatch is neither needed nor wanted.
              proxyReq.removeHeader("origin");
              proxyReq.removeHeader("referer");
            });
          },
        },
      },
    },

    test: {
      // Engine and runtime are framework-free and must stay runnable headless.
      // A jsdom project arrives with the first UI test, not before.
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  };
});
