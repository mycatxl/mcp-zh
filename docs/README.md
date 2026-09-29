# docs

`console-snippet.txt` is generated, not hand-written:

```bash
node scripts/make-snippet.mjs --write
```

It is regenerated after every deploy, because the endpoint it contains depends
on which Cloudflare account the Worker lives in — a stale snippet would point
at an old `*.workers.dev` subdomain and register a source that does not resolve.

The generated file is intentionally gitignored: it is a build artefact of
`project.json`.
