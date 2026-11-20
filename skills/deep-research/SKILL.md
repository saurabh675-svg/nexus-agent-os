---
name: deep-research
description: Multi-source research loop that ends in a cited answer instead of a single search.
---

# Deep research

## Loop
1. **Decompose** the question into 3–6 sub-questions. Write them down before searching.
2. **Search wide** — one `web_search` per sub-question, different phrasings. Never reuse the same query.
3. **Open the winners** with `open_page`. A snippet is not evidence; the sentence on the page is.
4. **Fill gaps** — for anything still unanswered, search again with the specific missing term, or drive the live browser through a login wall.
5. **Cross-check** every load-bearing number against a second independent source. Mark single-source claims as such.

## Confidence rules
- **High** — two independent, recent, primary sources agree.
- **Medium** — one primary source, or secondary sources agree.
- **Low** — forums, SEO listicles, undated pages. Say so.

## Output shape
- Direct answer in the first two sentences.
- Then evidence bullets, each with an inline URL.
- Then "Uncertain / conflicting" if applicable.
- Never invent a URL, a date, or a statistic. If a number is unavailable, say it is unavailable.
