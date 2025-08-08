// server.js - FULLY UPDATED

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const dbPool = require('./db'); // This should be your pg-configured db.js
const ConversationalAgent = require('./converstationalAgent');

const app = express();

// FIX: Secure CORS configuration. 
// In your Render backend settings, add an Environment Variable:
// Key: FRONTEND_URL
// Value: The URL of your deployed frontend (e.g., https://your-app-name.onrender.com)
const corsOptions = {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173', // Fallback for local dev
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// REMOVED: The in-memory userSessions object is gone. We now use the database.
const agent = new ConversationalAgent();

app.post('/api/chat', async (req, res) => {
    const { message, userId } = req.body;
    if (!message || !userId) {
        return res.status(400).json({ error: 'Message and userId are required.' });
    }

    try {
        // Step 1: Fetch the user's session from the database.
        const sessionResult = await dbPool.query('SELECT session_data FROM user_sessions WHERE user_id = $1', [userId]);
        
        let session;
        if (sessionResult.rows.length > 0) {
            session = sessionResult.rows[0].session_data;
            console.log(`[Server] Loaded session from DB for User ID: ${userId}`);
        } else {
            // This is a safeguard. The user should always have a session after logging in.
            return res.status(404).json({ error: 'Session not found. Please log in again.' });
        }

        // The agent receives the complete session object from the database.
        const { newOrderState, newHistory, reply } = await agent.handleMessage(message, dbPool, userId, session);
        
        // Step 2: Create the updated session object to be saved.
        const updatedSession = {
            orderState: newOrderState,
            history: newHistory
        };

        // Step 3: Save the updated session back to the database.
        // This query inserts a new session or updates it if one already exists for the user.
        await dbPool.query(
            `INSERT INTO user_sessions (user_id, session_data) 
             VALUES ($1, $2)
             ON CONFLICT (user_id) 
             DO UPDATE SET session_data = EXCLUDED.session_data, updated_at = NOW()`,
            [userId, updatedSession]
        );

        res.json({ reply, orderState: updatedSession.orderState });

    } catch (error) {
        console.error('API Error in /api/chat:', error);
        res.status(500).json({ error: 'Something went wrong on our end.' });
    }
});

app.get('/api/user/:id', async (req, res) => {
    try {
        const userId = req.params.id;

        // FIX: Use .query() and $1 placeholder for PostgreSQL.
        const { rows } = await dbPool.query('SELECT id, name, default_shipping_address, default_po_number FROM customers WHERE id = $1', [userId]);

        if (rows.length > 0) {
            // When a user logs in, create a fresh session FOR THEM in the database.
            const initialSession = {
                orderState: { 
                    customerId: parseInt(userId, 10), 
                    purchaseOrderNum: rows[0].default_po_number, 
                    shippingAddress: rows[0].default_shipping_address, 
                    lineItems: [], 
                    status: 'draft' 
                },
                history: []
            };
            
            await dbPool.query(
                `INSERT INTO user_sessions (user_id, session_data) 
                 VALUES ($1, $2)
                 ON CONFLICT (user_id) 
                 DO UPDATE SET session_data = EXCLUDED.session_data, updated_at = NOW()`,
                [userId, initialSession]
            );
            
            console.log(`[Server] Login successful. New session created/reset in DB for User ID: ${userId}`);
            res.json(rows[0]); // Send user data back to the frontend.
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error) {
        console.error('API Error fetching user:', error);
        res.status(500).json({ error: 'Could not fetch user.' });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});