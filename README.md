# Studio Builder

A browser-based Android project generator. The existing light dashboard is in `index.html`.

## Current architecture

- **AI source generation:** the browser calls the AI provider selected in Settings. The selected AI key remains in this browser's local storage.
- **Project storage:** generated project files and metadata are saved in the Neon PostgreSQL database.
- **Source ZIP:** generated projects can be exported in the browser with JSZip; no GitHub build is needed.
- **APK builds:** tapping **Build APK** or **Build Release** asks the Neon Function to dispatch the GitHub Actions workflow. The workflow downloads source from Neon, installs Java 17 / Android SDK 35 / Gradle 8.9, compiles the APK, and uploads an artifact.

## Neon configuration

Project: `studio-build-backend`  
Project ID: `dry-fire-13288712`  
Branch: `main`  
Database: `neondb`  
Function: `studiobuildapi`

Function URL:

`https://br-steep-leaf-b59uvinr-studiobuildapi.compute.c-7.us-east-2.aws.neon.tech`

The `studio_projects` and `studio_builds` tables are already created on the main branch.

## Required GitHub secret on the Neon Function

APK dispatch and artifact downloads need a GitHub fine-grained Personal Access Token. Limit it to this repository:

- Repository access: `SDcompaniesug/studio-builder`
- **Contents:** Read and write
- **Actions:** Read and write

Store the token as the Neon Function environment variable `GITHUB_TOKEN`. Do not put it in `index.html`, commit it, or save it in browser storage.

With the Neon CLI installed and authenticated, link this project and deploy the function with the secret:

```bash
neon link --project-id dry-fire-13288712
neon functions deploy studiobuildapi --src backend/index.mjs --env GITHUB_TOKEN=YOUR_TOKEN
```

Run the deploy command from the repository root after dependencies have been installed in `backend/`:

```bash
cd backend
npm install
cd ..
```

The current function deployment is active, but without `GITHUB_TOKEN`, APK build dispatch returns a configuration error. Source ZIP export and project storage do not need that token.

## GitHub Actions

- `.github/workflows/studio-api-bundle.yml` validates the frontend JavaScript and bundles the Neon Function.
- `.github/workflows/studio-android-build.yml` handles `repository_dispatch` events of type `studio-build`.

## Android defaults

Generated native Android projects are instructed to use Android Gradle Plugin 8.7.3, Gradle 8.9, Java 17, and compileSdk 35. Java + XML projects must use Java and XML, not Kotlin or Compose.

## Important security note

The API currently has no user sign-in or per-user authorization. Its project list and source endpoints are public to anyone who knows the function URL and a project UUID. Do not store private or sensitive app source in this deployment until authentication is added. The repository is public, so do not commit API keys, GitHub tokens, database URLs, or signing keys.
