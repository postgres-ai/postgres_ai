# pgai

`pgai` is a thin wrapper around the [`postgresai`](../cli/README.md) CLI, intended to provide a short command name.

## Usage

Run without installing:

```bash
npx pgai --help
npx pgai init postgresql://admin@host:5432/dbname
```

This is equivalent to:

```bash
npx postgresai --help
npx postgresai init postgresql://admin@host:5432/dbname
```


