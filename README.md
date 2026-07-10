# AI / Agent Morning Brief Archive

This folder is a static research console for the generated AI / Agent morning briefs. It prioritizes decision-ready summaries, model and product signals, evaluation methods, reusable tools, and one visual overview image per brief.

The public UI includes:

- a compact 90-second decision summary before the full report
- topic views for model capability, Agent products, evaluation methods, and architecture/tools
- verified OpenAI/Anthropic or leader signals extracted from each report
- repository-name search across all historical GitHub links
- a responsive full-screen reader on mobile
- private feedback states and notes stored only in the current browser via `localStorage`

## Local Preview

From `/Users/wuyuyang/Documents/Rhythm`, run:

```bash
python3 -m http.server 4311 --directory designs
```

Then open:

```text
http://localhost:4311/agent-brief-archive/index.html
```

## Daily Update

After a new `morning-brief-YYYY-MM-DD.html` is generated in `/Users/wuyuyang/Documents/Rhythm`, run:

```bash
node designs/agent-brief-archive/scripts/update-archive.mjs
```

The script will:

- copy all `morning-brief*.html` files into `briefs/`
- copy referenced `*-assets/` folders so embedded figures still work
- generate one SVG overview image per brief under `overviews/`
- write extracted metadata to `data/briefs.json`
- rebuild `index.html` so the newest brief is the default entry
- add lazy loading to copied report images without modifying the source reports

Each overview image includes the day's paper title and summary, key counts, and a GitHub project trend/proxy bar chart extracted from the brief tables.

To update the public GitHub Pages site in one step, run:

```bash
designs/agent-brief-archive/scripts/update-and-publish.sh
```

That command regenerates the archive, commits any changed files, and pushes to GitHub. It can use either `node` from `PATH` or the bundled Codex Node runtime. GitHub Pages then serves the latest version from the `main` branch.

## Deploy

Deploy `designs/agent-brief-archive/` as the site root on any static host:

- GitHub Pages
- Vercel
- Netlify
- Cloudflare Pages
- Lovable, if you want a hosted editable project

The `briefs/` directory contains copied HTML reports and their image assets. Keep those paths together when deploying.
