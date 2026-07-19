/**
 * Migrate data from Neon → Supabase
 * 
 * Reads all data from the old Neon DB and inserts into the new Supabase DB.
 * Schema must already exist on Supabase (done via prisma db push).
 * 
 * Usage: npx tsx scripts/migrate-neon-to-supabase.ts
 */

import pg from 'pg';
const { Pool } = pg;

const NEON_URL = 'postgresql://neondb_owner:npg_OdwJpn6AuIY9@ep-misty-darkness-amnwme4z-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require';
const SUPABASE_URL = 'postgresql://postgres.tlnuowyxfohcqnrghanw:Sadaka20080315*@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

const neonPool = new Pool({ connectionString: NEON_URL });
const supabasePool = new Pool({ connectionString: SUPABASE_URL });

// Tables in dependency order (parents first, children last)
const TABLES = [
  'users',
  'bank_accounts',
  'banned_ips',
  'registration_tokens',
  'password_reset_otps',
  'bots',
  'bot_verify_tokens',
  'stars_payment_attempts',
  'videos',
  'orders',
  'video_deliveries',
  'video_delivery_jobs',
  'reviews',
  'wallet_transactions',
  'pdf_categories',
  'pdf_subcategories',
  'pdf_series',
  'free_pdfs',
  'special_collections',
  'special_videos',
  'settings',
  'notifications',
  'push_subscriptions',
  'broadcasts',
];

async function migrateTable(table: string) {
  const neonClient = await neonPool.connect();
  const supabaseClient = await supabasePool.connect();

  try {
    // Check if table exists in Neon
    const tableCheck = await neonClient.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
      [table]
    );
    if (!tableCheck.rows[0].exists) {
      console.log(`  ⏭️  Table "${table}" doesn't exist in Neon — skipping`);
      return;
    }

    // Get row count from Neon
    const countResult = await neonClient.query(`SELECT COUNT(*) as count FROM "${table}"`);
    const rowCount = parseInt(countResult.rows[0].count);

    if (rowCount === 0) {
      console.log(`  ⏭️  Table "${table}" is empty — skipping`);
      return;
    }

    console.log(`  📦 Migrating "${table}" (${rowCount} rows)...`);

    // Get all rows
    const rows = await neonClient.query(`SELECT * FROM "${table}"`);

    if (rows.rows.length === 0) return;

    // Get column names from the result
    const columns = rows.fields.map(f => f.name);
    const colList = columns.map(c => `"${c}"`).join(', ');

    // Clear existing data in Supabase table (in case of re-run)
    await supabaseClient.query(`DELETE FROM "${table}"`);

    // Insert in batches of 100
    const batchSize = 100;
    let inserted = 0;

    for (let i = 0; i < rows.rows.length; i += batchSize) {
      const batch = rows.rows.slice(i, i + batchSize);

      const valuePlaceholders: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const row of batch) {
        const rowPlaceholders: string[] = [];
        for (const col of columns) {
          rowPlaceholders.push(`$${paramIndex++}`);
          values.push(row[col]);
        }
        valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
      }

      const insertQuery = `INSERT INTO "${table}" (${colList}) VALUES ${valuePlaceholders.join(', ')} ON CONFLICT DO NOTHING`;
      await supabaseClient.query(insertQuery, values);
      inserted += batch.length;
    }

    console.log(`  ✅ "${table}" — ${inserted} rows migrated`);
  } catch (err: any) {
    console.error(`  ❌ Error migrating "${table}":`, err.message);
  } finally {
    neonClient.release();
    supabaseClient.release();
  }
}

async function main() {
  console.log('🚀 Starting Neon → Supabase data migration\n');

  // Test connections
  try {
    const neonTest = await neonPool.query('SELECT 1');
    console.log('✅ Connected to Neon');
  } catch (err: any) {
    console.error('❌ Cannot connect to Neon:', err.message);
    console.error('   The compute quota may still be exceeded. Try again later.');
    process.exit(1);
  }

  try {
    const supaTest = await supabasePool.query('SELECT 1');
    console.log('✅ Connected to Supabase');
  } catch (err: any) {
    console.error('❌ Cannot connect to Supabase:', err.message);
    process.exit(1);
  }

  console.log('\n--- Migrating tables ---\n');

  // Disable FK constraints during migration
  const supa = await supabasePool.connect();
  await supa.query('SET session_replication_role = replica;');
  supa.release();

  for (const table of TABLES) {
    await migrateTable(table);
  }

  // Re-enable FK constraints
  const supa2 = await supabasePool.connect();
  await supa2.query('SET session_replication_role = DEFAULT;');
  supa2.release();

  console.log('\n🎉 Migration complete!');

  await neonPool.end();
  await supabasePool.end();
}

main().catch(console.error);
