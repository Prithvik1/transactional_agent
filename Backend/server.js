require('dotenv').config();

const express = require('express');
const cors = require('cors');
const dbPool = require('./db');
const ConversationalAgent = require('./converstationalAgent');

const app = express();
app.use(cors());
app.use(express.json());

// This object will store the full session (order state + history) for each user.
const userSessions = {};
const agent = new ConversationalAgent();

app.post('/api/chat', async (req, res) => {
    // The frontend sends the userId with each message.
    const { message, userId } = req.body;
    if (!message || !userId) {
        return res.status(400).json({ error: 'Message and userId are required.' });
    }

    try {
        // Get the session for the user. If it doesn't exist, create it.
        if (!userSessions[userId]) {
            userSessions[userId] = {
                orderState: { 
                    customerId: parseInt(userId, 10), 
                    purchaseOrderNum: null, 
                    shippingAddress: null, 
                    lineItems: [], 
                    status: 'draft' 
                },
                history: []
            };
            console.log(`[Server] New session created for User ID: ${userId}`);
        }
        const session = userSessions[userId];

        // The agent receives the complete, valid session object.
        const { newOrderState, newHistory, reply } = await agent.handleMessage(message, dbPool, userId, session);
        
        // Update the server's session state with the new state returned by the agent.
        session.orderState = newOrderState;
        session.history = newHistory;
        
        res.json({ reply, orderState: session.orderState });

    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Something went wrong on our end.' });
    }
});

// --- THE PERMANENT FIX: Re-added the missing user validation endpoint ---
app.get('/api/user/:id', async (req, res) => {
    try {
        const [rows] = await dbPool.execute('SELECT id, name FROM customers WHERE id = ?', [req.params.id]);
        if (rows.length > 0) {
            // When a user logs in, create a new, fresh session for them.
            const userId = req.params.id;
            userSessions[userId] = {
                orderState: { 
                    customerId: parseInt(userId, 10), 
                    purchaseOrderNum: null, 
                    shippingAddress: null, 
                    lineItems: [], 
                    status: 'draft' 
                },
                history: []
            };
            console.log(`[Server] Login successful. New session created for User ID: ${userId}`);
            res.json(rows[0]); // Send user data back to frontend.
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
