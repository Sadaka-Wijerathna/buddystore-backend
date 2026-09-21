const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres.tlnuowyxfohcqnrghanw:Sadaka20080315*@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true';

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to database.");

    // Delete the failed migration record so Prisma can retry it
    const res = await client.query(`DELETE FROM _prisma_migrations WHERE migration_name = '20260921151125_add_has_started_bot'`);
    console.log(`Deleted ${res.rowCount} failed migration records.`);

  } catch (err) {
    console.error("Error:", err);
  } finally {
    await client.end();
  }
}

run();
