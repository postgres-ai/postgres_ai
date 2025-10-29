"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Get the user-level config directory path
 * @returns {string} Path to ~/.config/postgresai
 */
function getConfigDir() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "postgresai");
}

/**
 * Get the user-level config file path
 * @returns {string} Path to ~/.config/postgresai/config.json
 */
function getConfigPath() {
  return path.join(getConfigDir(), "config.json");
}

/**
 * Get the legacy project-local config file path
 * @returns {string} Path to .pgwatch-config in current directory
 */
function getLegacyConfigPath() {
  return path.resolve(process.cwd(), ".pgwatch-config");
}

/**
 * Read configuration from file
 * Tries user-level config first, then falls back to legacy project-local config
 * @returns {Object} Configuration object with apiKey, baseUrl, orgId
 */
function readConfig() {
  const config = {
    apiKey: null,
    baseUrl: null,
    orgId: null,
  };

  // Try user-level config first
  const userConfigPath = getConfigPath();
  if (fs.existsSync(userConfigPath)) {
    try {
      const content = fs.readFileSync(userConfigPath, "utf8");
      const parsed = JSON.parse(content);
      config.apiKey = parsed.apiKey || null;
      config.baseUrl = parsed.baseUrl || null;
      config.orgId = parsed.orgId || null;
      return config;
    } catch (err) {
      console.error(`Warning: Failed to read config from ${userConfigPath}: ${err.message}`);
    }
  }

  // Fall back to legacy project-local config
  const legacyPath = getLegacyConfigPath();
  if (fs.existsSync(legacyPath)) {
    try {
      const stats = fs.statSync(legacyPath);
      if (stats.isFile()) {
        const content = fs.readFileSync(legacyPath, "utf8");
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const match = line.match(/^api_key=(.+)$/);
          if (match) {
            config.apiKey = match[1].trim();
            break;
          }
        }
      }
    } catch (err) {
      console.error(`Warning: Failed to read legacy config from ${legacyPath}: ${err.message}`);
    }
  }

  return config;
}

/**
 * Write configuration to user-level config file
 * @param {Object} config - Configuration object with apiKey, baseUrl, orgId
 */
function writeConfig(config) {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  // Read existing config and merge
  let existingConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf8");
      existingConfig = JSON.parse(content);
    } catch (err) {
      // Ignore parse errors, will overwrite
    }
  }

  const mergedConfig = {
    ...existingConfig,
    ...config,
  };

  // Write config file with restricted permissions
  fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * Delete specific keys from configuration
 * @param {string[]} keys - Array of keys to delete (e.g., ['apiKey'])
 */
function deleteConfigKeys(keys) {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(content);

    for (const key of keys) {
      delete config[key];
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch (err) {
    console.error(`Warning: Failed to update config: ${err.message}`);
  }
}

/**
 * Check if config file exists
 * @returns {boolean} True if config exists
 */
function configExists() {
  return fs.existsSync(getConfigPath()) || fs.existsSync(getLegacyConfigPath());
}

module.exports = {
  getConfigDir,
  getConfigPath,
  getLegacyConfigPath,
  readConfig,
  writeConfig,
  deleteConfigKeys,
  configExists,
};

