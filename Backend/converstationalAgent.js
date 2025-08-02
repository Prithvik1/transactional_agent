const { GoogleGenerativeAI } = require("@google/generative-ai");
const OrderProcessingAgent = require('./orderProcessingAgent');

class ConversationalAgent {
    constructor() {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY is not set in the environment variables.");
        }
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model = genAI.getGenerativeModel({ model: "gemini-2.5-flash"});
    }

    async handleMessage(message, db, userId, session) {
        const numericUserId = parseInt(userId, 10);
        const userProfile = await this.loadUserProfile(db, numericUserId);

        console.log(`\n--- New Turn: User ${numericUserId} (${userProfile.name}) ---`);
        console.log(`[Agent] Received message: "${message}"`);
        
        let history = [...session.history, `User: ${message}`];
        
        const llmResponse = await this.getLlmResponse(message, userProfile, session.orderState, history);
        let agentReply = "I'm not sure how to handle that. Could you rephrase?";
        let newOrderState = JSON.parse(JSON.stringify(session.orderState));

        if (llmResponse && llmResponse.intent) {
            switch (llmResponse.intent) {
                case 'multi_action':
                    console.log('[MCP] Detected multi-action request. Processing all actions.');
                    const replies = [];
                    if (llmResponse.entities && llmResponse.entities.items && Array.isArray(llmResponse.entities.items)) {
                        for (const item of llmResponse.entities.items) {
                            let singleReply;
                            if (item.action === 'add') {
                                ({ newOrderState, reply: singleReply } = await this.addItem({ items: [item] }, db, newOrderState, userProfile));
                            } else if (item.action === 'remove') {
                                ({ newOrderState, reply: singleReply } = await this.removeItem({ items: [item] }, db, newOrderState));
                            }
                            replies.push(singleReply);
                        }
                    }
                    agentReply = replies.join('\n');
                    break;
                case 'start_order':
                    ({ newOrderState, reply: agentReply } = await this.startDefaultOrder(newOrderState, userProfile, db));
                    break;
                case 'add_item':
                    ({ newOrderState, reply: agentReply } = await this.addItem(llmResponse.entities, db, newOrderState, userProfile));
                    if (!agentReply.includes("Which one did you mean?")) {
                        agentReply += `\n\nAnything else to add?`;
                    }
                    break;
                case 'remove_item':
                    ({ newOrderState, reply: agentReply } = await this.removeItem(llmResponse.entities, db, newOrderState));
                    break;
                case 'set_delivery_location':
                    const newAddress = llmResponse.entities?.shippingAddress || llmResponse.entities?.location;
                    if (newAddress) {
                        newOrderState.shippingAddress = newAddress;
                        agentReply = `Okay, I've updated the shipping address to: ${newOrderState.shippingAddress}.`;
                    } else {
                        agentReply = "I couldn't determine the new address. Please be more specific.";
                    }
                    break;
                case 'request_confirmation':
                    agentReply = this.presentConfirmation(newOrderState);
                    break;
                case 'finalize_order':
                    ({ newOrderState, reply: agentReply } = await OrderProcessingAgent.finalizeOrder(newOrderState, db));
                    if (agentReply.startsWith('Order #')) {
                       agentReply = llmResponse.reply || agentReply;
                       history = [];
                    }
                    break;
                case 'answer_question':
                    agentReply = llmResponse.reply;
                    break;
                case 'greet':
                    const historyPattern = await OrderProcessingAgent.getOrderHistoryPattern(numericUserId, db);
                    if (historyPattern) {
                        agentReply = `Welcome back, ${userProfile.name}! I see you frequently order the "${historyPattern.name}". Would you like to add it to a new order?`;
                    } else {
                        agentReply = `Hello ${userProfile.name}! How can I help you today?`;
                    }
                    break;
                case 'negative_response':
                    if (newOrderState.lineItems.length > 0) {
                        agentReply = "Okay. Would you like to review your order?";
                    } else {
                        agentReply = "Okay. Let me know what you need.";
                    }
                    break;
                default:
                    agentReply = llmResponse.reply || agentReply;
            }
        }
        
        
        if (!agentReply || agentReply.trim() === "") {
            agentReply = "I'm sorry, I'm having trouble understanding. Could you please rephrase?";
            console.error("[Agent ERROR] Agent was about to send an empty reply. LLM Response:", llmResponse);
        }

        history.push(`Agent: ${agentReply}`);
        console.log(`[Agent] Sending reply: "${agentReply}"`);
        return { newOrderState, newHistory: history, reply: agentReply };
    }

    async getLlmResponse(message, userProfile, orderState, history) {
        const prompt = `You are a B2B order processing assistant. Your only job is to understand the user's intent and extract key information.

CONTEXT:
1.  **User Profile:** ${JSON.stringify(userProfile)}
2.  **Current Order State:** ${JSON.stringify(orderState)}
3.  **Conversation History (last 4 turns):** ${history.slice(-4).join('\n')}

LATEST USER MESSAGE: "${message}"

INTENTS:
- **add_item**: User wants to add products.
- **remove_item**: User wants to remove products.
- **start_order**: User wants to begin their "usual" order.
- **set_delivery_location**: User wants to change the shipping address.
- **request_confirmation**: User wants to review the order.
- **finalize_order**: User confirms the order.
- **answer_question**: User asks a general question.
- **greet**: User is saying hello or has just logged in.
- **negative_response**: User is saying no.
- **multi_action**: The user's message contains more than one of the above intents.
- **other**: The intent is unclear.

INSTRUCTIONS:
- **CRITICAL: Base your answers *exclusively* on the CONTEXT provided.**
- **If a user says "no" but then gives a new command (e.g., "no, i want my usual order"), the intent is the new command ('start_order'), NOT 'negative_response' or 'multi_action'.**
- **If the user's message contains multiple distinct actions (e.g., adding AND removing items), the primary intent MUST be 'multi_action'. Each object in the 'entities.items' array MUST then include an 'action' key with the value 'add' or 'remove'.**
- For single-action messages, use the "intent" field as before.
- For 'add_item', 'remove_item', or 'start_order', extract an array of objects into the "entities.items" field. Each object must have "productName" and "quantity".
- **IMPORTANT: When extracting "productName", you MUST simplify it to its core, singular keywords (e.g., "smart watches" becomes "Smart Watch").**
- **Do NOT add proactive questions.** The application will handle the conversation flow.
- Respond with ONLY a single JSON object.

JSON-ONLY RESPONSE:`;

        try {
            console.log(`[Agent] Sending request to Gemini...`);
            const result = await this.model.generateContent(prompt);
            const response = result.response;
            const jsonString = response.text().replace(/```json|```/g, '').trim();
            console.log(`[Agent] Received from Gemini: ${jsonString}`);
            return JSON.parse(jsonString);
        } catch (error) {
            console.error('[Agent ERROR] Failed to get or parse LLM response:', error);
            return { intent: 'other', reply: 'I am having trouble connecting to my brain right now.' };
        }
    }
    
    async addItem(entities, db, orderState, userProfile) {
        if (!entities || !entities.items || !Array.isArray(entities.items)) {
            return { newOrderState: orderState, reply: "I understood you wanted to add items, but I couldn't process the details." };
        }
        
        if (orderState.lineItems.length === 0 && !orderState.shippingAddress) {
            console.log('[MCP] No active order. Automatically starting one with default details.');
            orderState.shippingAddress = userProfile.default_shipping_address;
            orderState.purchaseOrderNum = userProfile.default_po_number;
        }

        const replies = [];
        for (const item of entities.items) {
            const products = await OrderProcessingAgent.findProduct(item.productName, db);

            if (!products || products.length === 0) {
                replies.push(`Couldn't find a product matching "${item.productName}".`);
                continue;
            }

            if (products.length > 1) {
                let clarification = `I found a few different types of "${item.productName}". Which one did you mean?\n`;
                products.forEach(p => {
                    clarification += `- ${p.name}\n`;
                });
                replies.push(clarification);
                continue; 
            }

            const product = products[0];
            if (product.stock < item.quantity) {
                replies.push(`Sorry, only ${product.stock} units of ${product.name} in stock.`);
                continue;
            }
            
            const existingItem = orderState.lineItems.find(i => i.sku === product.sku);
            if (existingItem) {
                existingItem.quantity += item.quantity;
            } else {
                orderState.lineItems.push({ sku: product.sku, quantity: item.quantity, name: product.name, price: product.price });
            }
            replies.push(`Added ${item.quantity} of ${product.name}.`);
        }
        return { newOrderState: orderState, reply: replies.join('\n') };
    }

    async removeItem(entities, db, orderState) {
        if (!entities || !entities.items || !Array.isArray(entities.items)) {
            return { newOrderState: orderState, reply: "I understood you wanted to remove items, but I couldn't process the details." };
        }

        const replies = [];
        for (const item of entities.items) {
            const products = await OrderProcessingAgent.findProduct(item.productName, db);
            if (!products || products.length === 0) {
                replies.push(`I couldn't find a product matching "${item.productName}" in your order.`);
                continue;
            }
            
            const product = products[0];
            const existingItemIndex = orderState.lineItems.findIndex(i => i.sku === product.sku);

            if (existingItemIndex > -1) {
                orderState.lineItems[existingItemIndex].quantity -= item.quantity;
                replies.push(`Removed ${item.quantity} of ${product.name}.`);
                if (orderState.lineItems[existingItemIndex].quantity <= 0) {
                    orderState.lineItems.splice(existingItemIndex, 1);
                    replies.push(`${product.name} has been fully removed from your order.`);
                }
            } else {
                replies.push(`${product.name} is not in your current order.`);
            }
        }
        return { newOrderState: orderState, reply: replies.join('\n') };
    }

    async startDefaultOrder(orderState, userProfile, db) {
        console.log(`[Agent] Starting usual order for user ${userProfile.id}`);
        orderState.shippingAddress = userProfile.default_shipping_address;
        orderState.purchaseOrderNum = userProfile.default_po_number;
    
        const usualItems = await OrderProcessingAgent.getUsualOrderItems(userProfile.id, db);
        let reply = `I've started an order for your default office: ${userProfile.default_shipping_address}.`;
    
        if (usualItems.length > 0) {
            orderState.lineItems = usualItems.map(item => ({
                sku: item.product_sku,
                quantity: item.quantity,
                name: item.name,
                price: item.price
            }));
            reply += `\n\nI've added your usual items to the cart:\n`;
            usualItems.forEach(item => {
                reply += `- ${item.quantity} x ${item.name}\n`;
            });
            reply += `\nWould you like to review the order or add more items?`;
        } else {
            reply += `\nYou don't have a pre-defined usual order. What would you like to add?`;
        }
    
        return { newOrderState: orderState, reply };
    }

    presentConfirmation(orderState) {
        if (orderState.lineItems.length === 0) return "Your order is empty.";
        let confirmationText = "Please confirm your order:\n";
        confirmationText += `PO Number: ${orderState.purchaseOrderNum || 'Not set'}\n`;
        confirmationText += `Shipping to: ${orderState.shippingAddress || 'Not set'}\nItems:\n`;
        let total = 0;
        orderState.lineItems.forEach(item => {
            confirmationText += `  - ${item.quantity} x ${item.name} @ ₹${item.price}\n`;
            total += item.quantity * item.price;
        });
        confirmationText += `\nOrder Total: ₹${total.toFixed(2)}\n\nIs this correct?`;
        return confirmationText;
    }

    async loadUserProfile(db, userId) {
        const [rows] = await db.execute('SELECT * FROM customers WHERE id = ?', [userId]);
        if (rows.length === 0) throw new Error(`Could not find user with ID: ${userId}`);
        return rows[0];
    }
}

module.exports = ConversationalAgent;
