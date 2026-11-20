# Nexus 7.1 Refined

This edition improves the recovered original Nexus 7.1, retaining its tools, agent, connector and document workflows.

- Chat-first welcome screen with four task cards, a smaller sidebar, searchable tools and an Options menu.
- Chat paints before provider discovery completes. Background state polling is less frequent and cannot overlap. Closed or hidden panels skip polling.
- Existing chat drafts survive switching panels. New-chat history separation and stream recovery are retained from the first enhancement.
- The selected provider follows the actual provider chain instead of stale legacy settings. Model discovery follows that selection and refreshes its cache on a provider switch.
- API profiles send their saved apiKey correctly; local services without a key no longer receive Bearer undefined.
- Every streaming reply receives provider identity from the provider that produced content, including fallback. Local Ollama, remote APIs and Ollama Cloud via a local service are distinguished.
- Provider keys are masked in public settings.
- Existing Node.js is detected; an already-running Nexus is reopened, and an unrelated occupied port produces a clear error.
- One ZIP contains the application and the checked, backed-up update path. No extra dependencies were installed.

The source remains based on the original engine. Targeted changes to llm.js, agentloop.js, config.js and server.js fix provider authentication, reporting and settings masking. This is not a claim that every original capability has been independently validated.
