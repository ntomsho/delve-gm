/**
 * METRO: the bundler React Native uses where the web uses Vite.
 *
 * The app is its own npm project, deliberately not an npm workspace: Vercel
 * installs the repo root to build the web and the API, and a workspace would
 * make every deploy download React Native as well. So Metro is told two things
 * by hand that a workspace would have set up automatically.
 */

const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sharedSrc = path.resolve(projectRoot, "../src");

const config = getDefaultConfig(projectRoot);

// 1. WATCH THE GAME. Metro only bundles files inside folders it watches, and
//    the game's source lives one level up, outside this project.
config.watchFolders = [sharedSrc];

// 2. ONE COPY OF EVERY PACKAGE. A file in ../src that imports
//    "@supabase/auth-js" would normally find it by walking up to the repo
//    root's node_modules: the web's copy, not the app's. So a package imported
//    from the shared source is looked up as if the import were written here
//    instead. The app then has one auth client, one zod and, above all, one
//    React. Two Reacts in one app crash at runtime.
const asIfFromApp = path.join(projectRoot, "package.json");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const bare = !moduleName.startsWith(".") && !path.isAbsolute(moduleName) && !moduleName.startsWith("@delve/");
  const fromShared = context.originModulePath.startsWith(sharedSrc + path.sep);
  if (bare && fromShared) {
    return context.resolveRequest({ ...context, originModulePath: asIfFromApp }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
