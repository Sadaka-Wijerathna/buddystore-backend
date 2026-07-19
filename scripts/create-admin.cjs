const { Client } = require('pg');
const bcrypt = require('bcryptjs');

async function main() {
  const client = new Client({
    connectionString: 'postgresql://neondb_owner:npg_OdwJpn6AuIY9@ep-misty-darkness-amnwme4z-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected to DB');

  const hash = await bcrypt.hash('admin123', 12);
  const username = 'SadakaWijerathna';

  // Check if user exists
  const existing = await client.query('SELECT id, role FROM users WHERE "telegramUsername" = $1', [username]);

  if (existing.rows.length > 0) {
    // Update to admin
    await client.query('UPDATE users SET role = $1, "passwordHash" = $2 WHERE "telegramUsername" = $3', ['ADMIN', hash, username]);
    console.log('✅ Updated existing user to ADMIN');
    console.log('   ID:', existing.rows[0].id);
  } else {
    // Insert new admin
    const id = require('crypto').randomUUID();
    await client.query(
      `INSERT INTO users (id, "telegramId", "telegramUsername", "firstName", "lastName", "passwordHash", role, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
      [id, 9900112233, username, 'Sadaka', 'Wijerathna', hash, 'ADMIN']
    );
    console.log('✅ Created new ADMIN user');
    console.log('   ID:', id);
  }

  console.log('   Username: @' + username);
  console.log('   Password: admin123');

  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
