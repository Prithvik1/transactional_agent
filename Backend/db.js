// This file is now configured to use the 'pg' library for PostgreSQL
const { Pool } = require('pg');

// This is the only configuration needed.
// The pool will automatically use the DATABASE_URL from your Render environment.
const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // This is required for connecting to Render's PostgreSQL databases
    ssl: {
        rejectUnauthorized: false
    }
});

console.log('PostgreSQL connection pool created.');

// Export the pool to be used in other parts of the application
module.exports = dbPool;