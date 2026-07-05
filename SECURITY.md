# Security policy

## Secrets

Never package or commit `.env` files. Generate separate random values for `CAMOFOX_API_KEY` and `BROWSER_SEARCH_API_KEY`, store them in the deployment platform, and rotate them whenever a working-directory archive or log may have exposed them.

Create distributable source archives with:

```bash
npm run package:source -- browser-search-resilient-source.zip
```

The command refuses a dirty working tree and uses `git archive`, so ignored secrets, dependencies, build output, and Git metadata are excluded.

## Reporting

Report suspected vulnerabilities privately to the repository maintainers. Include the affected revision, reproduction steps, expected impact, and any proposed mitigation. Do not include live credentials in an issue or diagnostic archive.
