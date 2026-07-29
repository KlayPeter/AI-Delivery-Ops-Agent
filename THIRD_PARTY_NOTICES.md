# Third-party notices

This file records notable external projects, services, and content sources
connected to AI Delivery Ops Agent. It does not replace the license notices
shipped with dependencies.

## liyoro/ai-news-radar

- Project: <https://github.com/liyoro/ai-news-radar>
- Use here: product inspiration for a multi-source news radar, time-window
  filtering, and traceable source links.
- Bundling status: no source code, static site, GitHub Pages workflow, or data
  archive from that repository is bundled.
- License note: the referenced repository did not publish a license file when
  this notice was prepared. This project therefore treats it only as credited
  product inspiration and does not claim permission to redistribute its code.

## AI HOT

- Service: <https://aihot.virxact.com>
- Public access terms: <https://aihot.virxact.com/terms>
- Use here: optional, anonymous, read-only access to the versioned public API
  through `backend/src/agents/native/ai-news-radar/provider.ts`.
- Attribution: public displays must retain AI HOT attribution and the canonical
  entry supplied by the API. Original articles, images, and full text remain
  the property of their respective sources.
- Bundling status: AI HOT data is fetched at runtime and is not included in this
  repository.

## Package dependencies

Backend and frontend dependencies are declared in `backend/package.json` and
`frontend/package.json`, with resolved versions in their lockfiles. Each
dependency remains subject to its own license and copyright notices.
