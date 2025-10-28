## CLI developer quickstart

### run without install
```bash
npm --prefix cli install --no-audit --no-fund
node ./cli/bin/postgres-ai.js --help
```

### use aliases locally (no ./)
```bash
# install from repo into global prefix
npm install -g ./cli

# ensure global npm bin is in PATH (zsh)
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc
exec zsh -l

# aliases
postgres-ai --help
pgai --help
```

### one‑off run (no install)
```bash
npx -y -p file:cli postgres-ai --help
```

### env vars for integration tests
- `PGAI_API_KEY`
- `PGAI_BASE_URL` (default `https://v2.postgres.ai/api/general/`)

