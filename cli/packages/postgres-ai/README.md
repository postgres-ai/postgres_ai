# postgres-ai

This is a wrapper package for [postgresai](https://www.npmjs.com/package/postgresai).

## Prefer installing postgresai directly

```bash
npm install -g postgresai
```

This gives you two commands:
- `postgresai` — canonical, discoverable
- `pgai` — short and convenient

## Why this package exists

This package exists for discoverability on npm. If you search for "postgres-ai", you'll find this package which depends on and forwards to `postgresai`.

Installing this package (`npm install -g postgres-ai`) will install both packages, giving you all three command aliases:
- `postgres-ai` (from this package)
- `postgresai` (from the main package)
- `pgai` (from the main package)

## Documentation

See the main package for full documentation: https://www.npmjs.com/package/postgresai
