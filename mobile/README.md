# Delve GM for Android

A React Native (Expo) client for Delve GM. It plays the same game as the web app,
against the same API, using the same game code.

## How it fits the repo

```
  ui/ (React DOM, Vite)          mobile/ (React Native, Expo, Metro)
          \                              /
           api-client · gameplay · rules · shared      <- ../src, shared as-is
                          |
                server/ (Hono on Vercel)                <- the only holder of the model key
```

- **One engine, two shells.** The app imports the game through the `@delve/*` alias
  (`tsconfig.json`), which points at `../src`. It isn't a copy and it isn't a package.
  `src/architecture.test.ts` checks that the app only imports the layers a client
  may use (`api-client`, `gameplay`, `illustrations`, `rules`, `shared`), never
  generation, the model or the prompts.
- **The API client is told where it runs.** `src/api-client/config.ts` takes
  the base URL, the session storage and the sign-in flow from whichever shell
  loads it. The web passes its own in `src/ui/app/api-config.ts`, and this app
  passes its own in `src/api.ts`.
- **Its own npm project, not a workspace.** Vercel installs the repo root to
  build the web, and a workspace would make every deploy install React Native.
  `metro.config.js` watches `../src` and resolves the packages that code imports
  from this folder's `node_modules`, so the app bundles one copy of each.
  `npx expo-doctor` reports React twice (the web's and the app's). That warning
  is expected: shared code never imports React, which the architecture test enforces.

## Running it

```sh
cd mobile
npm install
cp .env.example .env.local      # then fill in the two Supabase values
npm start
```

Then do one of the following:

- **Expo Go on an Android phone** (the quickest way). Install Expo Go from the Play
  Store, put the phone on the same Wi-Fi as the computer, and scan the QR code.
- **An Android emulator.** Install Android Studio, create a virtual device, and
  press `a` in the `npm start` terminal.

### Signing in

Google sends the player back to the app through a redirect URL, and Supabase
only redirects to URLs on its allow list (Dashboard → Authentication → URL
Configuration → Redirect URLs):

| Running in | Redirect URL to allow |
|---|---|
| A built APK | `delve://**` |
| Expo Go | the `exp://<address>:8081` URL that `npm start` prints, plus `/**` |

Allow the exact Expo Go address rather than `exp://**`. A wildcard would let
anyone's Expo Go project receive a sign-in.

## Checks

```sh
npm run typecheck                 # TypeScript, including the shared code the app imports
npm run export:android            # bundles the app with Metro, as a build would
```
