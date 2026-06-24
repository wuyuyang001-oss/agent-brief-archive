# AI / Agent Morning Brief Archive

This folder is a static website that collects the generated AI / Agent morning briefs. It now also generates one visual overview image for each daily brief.

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

Each overview image includes the day's paper title and summary, key counts, and a GitHub project trend/proxy bar chart extracted from the brief tables.

## Deploy

Deploy `designs/agent-brief-archive/` as the site root on any static host:

- GitHub Pages
- Vercel
- Netlify
- Cloudflare Pages
- Lovable, if you want a hosted editable project

The `briefs/` directory contains copied HTML reports and their image assets. Keep those paths together when deploying.
