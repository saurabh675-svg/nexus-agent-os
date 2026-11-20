---
name: kaggle-runner
description: Push a Kaggle kernel, watch it, and pull the output/log reliably through the Kaggle API.
---

# Kaggle runner

## Before pushing
1. The kernel folder must contain `kernel-metadata.json` with `id` (`owner/slug`), `title`, `code_file`, `language`, `kernel_type` (`script` or `notebook`), `is_private`, `enable_gpu` (bool), `enable_internet` (bool), and `dataset_sources` / `competition_sources` arrays.
2. Validate the metadata locally with `files` (read) before spending a GPU run:
   - every `dataset_sources` entry is `owner/dataset-name`
   - `code_file` exists in the same folder
3. Push with the `kaggle` tool: `{"action":"push","dir":"<absolute folder>"}`. This is the same call the CLI makes (`/api/v1/kernels/push`) and it also refreshes the run.

## Watching a run
- Status: `{"action":"status","ref":"owner/slug"}` — `queued` → `running` → `complete` | `error`.
- Never poll faster than every 30s. A GPU job typically takes 3–15 minutes.
- On `error`, immediately pull the log: `{"action":"log","ref":"owner/slug"}` and quote the first traceback, not the last line.
- Output files: `{"action":"output","ref":"owner/slug"}`.

## Local work instead of remote runs
Kaggle notebooks are slow to iterate. Prototype locally first with `shell`:
- `python -c "import pandas as pd; print(pd.read_csv('train.csv').shape)"`
- only push once the script runs end-to-end locally on a 5% sample.

## Reporting
Always report: ref, final status, wall-clock, and the exact metric printed in the log. Do not claim a score you did not read from the log.
