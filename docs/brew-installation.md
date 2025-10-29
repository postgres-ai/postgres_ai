# Homebrew Installation for PostgresAI CLI

This document describes how to set up and distribute the PostgresAI CLI via Homebrew.

## For Users

### Installation

Once the Homebrew tap is set up, users can install with:

```bash
# Add the PostgresAI tap
brew tap postgres-ai/tap https://gitlab.com/postgres-ai/homebrew-tap.git

# Install postgresai
brew install postgresai

# Verify installation
pgai --version
```

### Updating

```bash
brew update
brew upgrade postgresai
```

### Uninstalling

```bash
brew uninstall postgresai
brew untap postgres-ai/tap
```

## For Maintainers

### Creating the Homebrew Tap Repository

1. Create a new GitLab repository named `homebrew-tap` at:
   `https://gitlab.com/postgres-ai/homebrew-tap`

2. Add the formula file `Formula/postgresai.rb` to the repository

3. Update the formula SHA256 after each npm publish:
   ```bash
   # Download the tarball
   curl -L https://registry.npmjs.org/postgresai/-/postgresai-VERSION.tgz -o postgresai.tgz
   
   # Calculate SHA256
   shasum -a 256 postgresai.tgz
   
   # Update the sha256 field in the formula
   ```

### Updating the Formula

After publishing a new version to npm:

1. Update the `url` with the new version number
2. Calculate and update the `sha256` hash
3. Test the formula locally:
   ```bash
   brew install --build-from-source Formula/postgresai.rb
   brew test postgresai
   ```
4. Commit and push to the homebrew-tap repository

### Testing Locally

Before pushing to the tap:

```bash
# Install from local formula
brew install --build-from-source Formula/postgresai.rb

# Run tests
brew test postgresai

# Audit the formula
brew audit --strict postgresai

# Uninstall
brew uninstall postgresai
```

## Alternative: Homebrew Core

To submit to the main Homebrew repository (more visibility but stricter requirements):

1. Formula must meet Homebrew's acceptance criteria
2. Project should be notable/popular
3. Follow instructions at: https://docs.brew.sh/Adding-Software-to-Homebrew

## Automation

Consider setting up CI/CD to automatically:
1. Calculate SHA256 from the npm tarball
2. Update the formula
3. Commit to homebrew-tap repository

This can be done in GitLab CI after successful npm publish.

