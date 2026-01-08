# Implementation Plan: Cloud Monitoring Instance Creation

## Overview

Implement `npx postgresai mon install <db-url>` command to create monitoring instances in PostgresAI cloud, similar to how the platform-ui creates instances via API calls and Ansible provisioning.

## Background Research

### Current CLI Architecture
- **Framework**: Commander.js v12.1.0
- **API Client**: Custom RPC client in `cli/lib/checkup-api.ts` with retry logic
- **Auth**: API key stored in `~/.config/postgresai/config.json`
- **Existing Commands**: `mon local-install`, `mon targets add/remove`, `checkup`, `issues`

### API Integration Patterns (from existing code)
```typescript
// Base URL: https://postgres.ai/api/general/
// Auth header: access-token: <apiKey>
// RPC pattern: POST /rpc/<function_name> with JSON body
```

### Existing `mon local-install` Flow
1. Validates options (--demo, --db-url, --api-key)
2. Sets up project directory
3. Configures API key
4. Adds PostgreSQL instance to instances.yml
5. Tests database connection
6. Runs Docker Compose to start monitoring stack

## Proposed Implementation

### Command Structure
```bash
# Basic usage
npx postgresai mon install <db-url>

# With options
npx postgresai mon install <db-url> --name <instance-name> --region <region>

# Examples
npx postgresai mon install postgresql://user:pass@mydb.example.com:5432/production
npx postgresai mon install postgresql://user:pass@host:5432/db --name "prod-db" --region us-east-1
```

### New Files to Create

1. **`cli/lib/cloud-api.ts`** - Cloud provisioning API client
   - `checkOrganizationPaymentStatus()` - Verify org has payment method
   - `createCloudMonitoringInstance()` - Provision new cloud instance
   - `getCloudMonitoringInstanceStatus()` - Check provisioning status
   - `listCloudMonitoringInstances()` - List user's cloud instances

2. **`cli/lib/types/cloud.ts`** - TypeScript interfaces for cloud API

### API Endpoints (Proposed)

Based on similar patterns in the codebase, the backend likely exposes these RPC functions:

```typescript
// Check payment status
POST /rpc/org_payment_status
Body: { access_token: string }
Response: { has_payment_method: boolean, org_id: number, org_name: string }

// Create monitoring instance
POST /rpc/monitoring_instance_create
Body: {
  access_token: string,
  db_connection_string: string,
  instance_name: string,
  region?: string,
  preset_metrics?: string
}
Response: {
  instance_id: number,
  status: "provisioning" | "ready" | "error",
  grafana_url?: string,
  error_message?: string
}

// Get instance status
POST /rpc/monitoring_instance_status
Body: { access_token: string, instance_id: number }
Response: { status: string, grafana_url?: string, progress?: number }
```

### CLI Implementation (`cli/bin/postgres-ai.ts`)

Add new subcommand under `mon`:

```typescript
mon
  .command("install <db-url>")
  .description("create cloud monitoring instance for a PostgreSQL database")
  .option("--name <name>", "instance name (auto-generated if not provided)")
  .option("--region <region>", "cloud region (default: auto-select nearest)")
  .option("--wait", "wait for provisioning to complete", true)
  .option("--no-wait", "return immediately after starting provisioning")
  .action(async (dbUrl: string, opts: CloudInstallOptions) => {
    // Implementation
  });
```

### Implementation Steps

#### Step 1: Validate Prerequisites
```typescript
// 1. Check API key exists
const { apiKey } = getConfig(rootOpts);
if (!apiKey) {
  console.error("Error: API key required. Run 'postgresai auth login' first.");
  process.exitCode = 1;
  return;
}

// 2. Parse and validate database URL
const parsed = parseDbUrl(dbUrl);
if (!parsed) {
  console.error("Error: Invalid PostgreSQL connection URL");
  console.error("Expected format: postgresql://user:pass@host:port/database");
  process.exitCode = 1;
  return;
}

// 3. Test database connectivity (optional but recommended)
```

#### Step 2: Check Payment Status
```typescript
// Check if organization has payment method
const paymentStatus = await checkOrganizationPaymentStatus({ apiKey, apiBaseUrl });

if (!paymentStatus.has_payment_method) {
  console.error("Error: No payment method on file");
  console.error("");
  console.error("Cloud monitoring requires a valid payment method.");
  console.error(`Add a payment method at: https://console.postgres.ai/orgs/${paymentStatus.org_id}/billing`);
  console.error("");
  console.error("After adding a payment method, run this command again.");
  process.exitCode = 1;
  return;
}
```

#### Step 3: Create Cloud Instance
```typescript
// Create the monitoring instance
const spinner = createTtySpinner(true, "Creating cloud monitoring instance...");

try {
  const result = await createCloudMonitoringInstance({
    apiKey,
    apiBaseUrl,
    dbConnectionString: dbUrl,
    instanceName: opts.name || generateInstanceName(parsed),
    region: opts.region,
  });

  if (opts.wait) {
    // Poll for completion
    spinner.update("Provisioning cloud infrastructure...");
    const finalStatus = await pollInstanceStatus(apiKey, apiBaseUrl, result.instance_id);

    spinner.stop("Cloud monitoring instance created!");
    console.log("");
    console.log("Instance Details:");
    console.log(`  Name: ${result.instance_name}`);
    console.log(`  ID: ${result.instance_id}`);
    console.log(`  Grafana URL: ${finalStatus.grafana_url}`);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Open Grafana dashboard to view metrics");
    console.log("  2. Configure alerts in console.postgres.ai");
  } else {
    spinner.stop("Instance creation started!");
    console.log(`Instance ID: ${result.instance_id}`);
    console.log("Check status with: postgresai mon status --instance-id " + result.instance_id);
  }
} catch (err) {
  spinner.stop("");
  handleCloudApiError(err);
}
```

#### Step 4: Error Handling

```typescript
function handleCloudApiError(err: unknown): void {
  if (err instanceof RpcError) {
    // Handle specific error codes
    switch (err.statusCode) {
      case 402: // Payment Required
        console.error("Error: Payment method required");
        console.error("Add a card at: https://console.postgres.ai/billing");
        break;
      case 403: // Forbidden
        console.error("Error: Access denied");
        console.error("Check your API key permissions");
        break;
      case 409: // Conflict
        console.error("Error: Instance already exists for this database");
        break;
      default:
        formatRpcErrorForDisplay(err).forEach(line => console.error(line));
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
}
```

### Additional Commands (Future Enhancement)

```typescript
// List cloud instances
mon.command("list")
  .description("list cloud monitoring instances")
  .action(async () => { /* ... */ });

// Show instance status
mon.command("status")
  .option("--instance-id <id>", "specific instance ID")
  .description("show cloud monitoring instance status")
  .action(async (opts) => { /* ... */ });

// Delete instance
mon.command("delete <instance-id>")
  .description("delete cloud monitoring instance")
  .action(async (instanceId) => { /* ... */ });
```

### Testing Plan

1. **Unit Tests** (`cli/test/cloud-api.test.ts`)
   - Mock API responses
   - Test payment status checking
   - Test error handling
   - Test URL parsing

2. **Integration Tests**
   - Test with real API (using test API key)
   - Test payment error flow
   - Test successful provisioning

3. **Manual Testing**
   - Test without API key
   - Test without payment method
   - Test with valid credentials
   - Test with invalid database URL

### Files to Modify

1. `cli/bin/postgres-ai.ts` - Add new `mon install` command
2. `cli/lib/checkup-api.ts` - Add new cloud API functions (or create new file)
3. `cli/lib/util.ts` - Add database URL parsing utility

### Files to Create

1. `cli/lib/cloud-api.ts` - Cloud provisioning API client
2. `cli/test/cloud-api.test.ts` - Unit tests for cloud API

## Open Questions / Assumptions

1. **API Endpoints**: The exact API endpoint names need to be confirmed. I've assumed PostgREST-style RPC naming based on existing patterns.

2. **Payment Check**: Assumed there's an API to check org payment status. May need to fetch org info first to get org_id.

3. **Provisioning Flow**: Assumed async provisioning with polling. The actual backend might use webhooks or a different pattern.

4. **Region Selection**: Need to confirm available regions and default selection logic.

5. **Ansible Integration**: The platform-ui likely triggers Ansible playbooks server-side. The CLI just needs to call the API; provisioning logic runs on backend.

## Implementation Order

1. Create `cloud-api.ts` with API client functions
2. Add `mon install` command to CLI
3. Implement payment status check with proper error message
4. Implement instance creation with progress display
5. Add tests
6. Update README documentation

## Success Criteria

- [ ] `npx postgresai mon install <db-url>` creates a cloud instance
- [ ] Clear error message when no payment method is configured
- [ ] Error message includes link to `console.postgres.ai` billing page
- [ ] Progress indicator during provisioning
- [ ] Final output shows Grafana URL and next steps
