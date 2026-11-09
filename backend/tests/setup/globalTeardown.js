const path = require('path');
const fs = require('fs');
const os = require('os');
const { Client } = require('pg');

module.exports = async () => {
  const file = path.join(os.tmpdir(), 'bb-api-test-db.json');
  if (!fs.existsSync(file)) return;
  const { adminUrl, name } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const admin = new Client({ connectionString: adminUrl, ssl: require('../../../db/ssl').sslOptions() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  fs.unlinkSync(file);
};
