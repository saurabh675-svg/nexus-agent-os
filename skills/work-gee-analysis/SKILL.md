---
name: work-gee-analysis
description: Earth Engine and NDVI/UHI analysis: run as a background job, export, then verify the artifact.
source: derived from 1 automation(s) on this PC
---

# Remote sensing work

## Pattern that works here
- `gee_automation.py check` / `ndvi` via the `job` tool (exports outlive a chat request).
- Never treat a started export as finished; poll the job and read the last lines.
- Save maps to the workspace so the Viewer can render them, and state the file path you actually verified.

## Honesty rules
- A map that was not written to disk does not exist. Check the path.
- Quote the date range and the sensor when reporting a statistic.

## Provenance
- geoinformatics-funding-and-proposals (heartbeat, ACTIVE)
