# Contributing to Nexus

Thanks for helping improve Nexus. Bug reports, documentation fixes, tests, and focused
feature contributions are welcome.

## Before opening an issue

- Search existing issues for duplicates.
- Include your operating system, Node.js version, steps to reproduce, and expected versus actual
  behavior.
- Remove API keys, access tokens, private URLs, personal data, and local file paths from logs.
- Do not report security vulnerabilities in public issues. Contact the repository owner privately
  so a fix can be prepared before disclosure.

## Development setup

1. Install Node.js 20 or newer.
2. Clone the repository and run `npm install`.
3. Start the app with `npm start`, then open `http://127.0.0.1:8787`.
4. For the optional Windows desktop app, run `npm run desktop`.

The base server uses Node.js built-ins and does not need runtime npm dependencies. Electron and
electron-builder are development dependencies for the desktop shell and installer.

## Changes and pull requests

- Keep changes focused and follow existing code style and patterns.
- Add or update tests for behavior changes.
- Run `npm test` and `npm run doctor` before submitting.
- Update relevant documentation.
- Never include `data/`, `.env` files, API keys, credentials, personal datasets, or generated
  installers in a commit.
- Explain the problem, the solution, how you tested it, and any trade-offs in your pull request.

By submitting a contribution, you agree that it may be distributed under the project's MIT
License.
