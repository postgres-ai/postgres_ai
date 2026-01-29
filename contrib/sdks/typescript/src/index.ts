/**
 * PostgresAI Express Checkup - TypeScript SDK
 *
 * A lightweight library for running PostgreSQL health checks.
 * Works with any PostgreSQL client (pg, postgres, drizzle, prisma, etc.)
 *
 * Usage with `pg`:
 *   import { Client } from 'pg';
 *   import { Checkup } from 'postgresai-checkup';
 *
 *   const client = new Client('postgresql://...');
 *   await client.connect();
 *
 *   const checkup = new Checkup(async (sql) => {
 *     const result = await client.query(sql);
 *     return result.rows;
 *   });
 *
 *   const reports = await checkup.runAll();
 *
 * Usage with `postgres` (porsager/postgres):
 *   import postgres from 'postgres';
 *   import { Checkup } from 'postgresai-checkup';
 *
 *   const sql = postgres('postgresql://...');
 *   const checkup = new Checkup(async (query) => sql.unsafe(query));
 *   const reports = await checkup.runAll();
 */

export * from './checkup';
export * from './types';
export * from './checks';
export { formatBytes } from './utils';
