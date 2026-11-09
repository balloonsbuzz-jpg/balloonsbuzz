// SSL options for pg connections. Supabase requires TLS; local Docker doesn't.
//   PGSSL=true            -> encrypted connection
//   PGSSL_CA=<path.crt>   -> also verify the server against that CA (Supabase:
//                            Project Settings -> Database -> SSL certificate). Recommended for production.
const fs = require('fs');

function sslOptions(env = process.env) {
  if (String(env.PGSSL).toLowerCase() !== 'true') return undefined;
  if (env.PGSSL_CA) return { ca: fs.readFileSync(env.PGSSL_CA, 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

module.exports = { sslOptions };
