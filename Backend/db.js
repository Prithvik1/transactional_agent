const mysql = require('mysql2/promise');

// Create a connection pool using the environment variables
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

console.log('Database connection pool created.');

// Export the pool to be used in other parts of the application
module.exports = dbPool;
