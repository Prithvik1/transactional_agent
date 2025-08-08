// OrderProcessingAgent.js - FULLY UPDATED FOR POSTGRESQL

class OrderProcessingAgent {
    static async findProduct(productName, db) {
        if (typeof productName !== 'string' || productName.trim() === '') {
            console.error('[OrderProcessingAgent] Received invalid productName:', productName);
            return null;
        }

        const searchWords = productName.split(' ').filter(word => word.length > 0);
        if (searchWords.length === 0) return null;

        // FIX: Dynamically create $1, $2, etc., placeholders for PostgreSQL
        const conditions = searchWords.map((_, index) => `LOWER(name) LIKE $${index + 1}`).join(' AND ');
        const sqlQuery = `SELECT * FROM products WHERE ${conditions}`;
        const searchParams = searchWords.map(word => `%${word.toLowerCase()}%`);

        try {
            // FIX: Use db.query() and destructure { rows } from the result object
            const { rows } = await db.query(sqlQuery, searchParams);
            return rows;
        } catch (error) {
            console.error(`[OrderProcessingAgent] Database query failed:`, error);
            return null;
        }
    }
    
    static async getOrderHistoryPattern(customerId, db) {
        console.log(`[OrderProcessingAgent] Analyzing order history for customer ${customerId}...`);
        try {
            // FIX: Use db.query(), $1 placeholder, and PostgreSQL-specific date functions
            const { rows } = await db.query(
                `SELECT oi.product_sku, p.name, COUNT(*) as order_frequency
                 FROM order_items oi
                 JOIN orders o ON oi.order_id = o.id
                 JOIN products p ON oi.product_sku = p.sku
                 WHERE o.customer_id = $1 AND o.created_at >= NOW() - INTERVAL '90 day'
                 GROUP BY oi.product_sku, p.name
                 ORDER BY order_frequency DESC
                 LIMIT 1;`, 
                [customerId]
            );
            return rows[0];
        } catch (error) {
            console.error(`[OrderProcessingAgent] getOrderHistoryPattern failed:`, error);
            return null;
        }
    }

    static async getUsualOrderItems(customerId, db) {
        try {
            // FIX: Use db.query() and $1 placeholder
            const { rows } = await db.query(
                `SELECT uoi.product_sku, uoi.quantity, p.name, p.price 
                 FROM usual_order_items uoi
                 JOIN products p ON uoi.product_sku = p.sku
                 WHERE uoi.customer_id = $1`,
                [customerId]
            );
            return rows;
        } catch (error) {
            console.error(`[OrderProcessingAgent] getUsualOrderItems failed:`, error);
            return null;
        }
    }

    static async finalizeOrder(orderState, db) {
        if (!orderState.shippingAddress || orderState.lineItems.length === 0) {
            const reply = "Cannot finalize order. Shipping address and items are required.";
            return { newOrderState: orderState, reply };
        }

        // FIX: This is the standard way to handle transactions with node-postgres (pg)
        const client = await db.connect();

        try {
            await client.query('BEGIN'); // Start transaction

            // FIX: Use 'RETURNING id' to get the new order's ID, which is PostgreSQL-specific
            const orderResult = await client.query(
                'INSERT INTO orders (customer_id, purchase_order_num, shipping_address, status) VALUES ($1, $2, $3, $4) RETURNING id', 
                [orderState.customerId, orderState.purchaseOrderNum, orderState.shippingAddress, 'confirmed']
            );
            const orderId = orderResult.rows[0].id; // Get the ID from the result

            for (const item of orderState.lineItems) {
                // Lock the product row to prevent race conditions
                const productResult = await client.query('SELECT stock FROM products WHERE sku = $1 FOR UPDATE', [item.sku]);
                if (productResult.rows[0].stock < item.quantity) {
                    throw new Error(`Insufficient stock for ${item.name}`);
                }

                // Insert the order item
                await client.query(
                    'INSERT INTO order_items (order_id, product_sku, quantity, unit_price) VALUES ($1, $2, $3, $4)', 
                    [orderId, item.sku, item.quantity, item.price]
                );

                // Update the stock
                await client.query(
                    'UPDATE products SET stock = stock - $1 WHERE sku = $2', 
                    [item.quantity, item.sku]
                );
            }
            
            await client.query('COMMIT'); // Commit transaction
            
            const reply = `Order #${orderId} has been confirmed and is being processed.`;
            const newOrderState = { ...orderState, status: 'confirmed', lineItems: [], purchaseOrderNum: null };

            return { newOrderState, reply };

        } catch (error) {
            await client.query('ROLLBACK'); // Roll back transaction on error
            console.error('Order finalization failed:', error);
            const reply = `There was an error processing your order: ${error.message}. Please try again.`;
            return { newOrderState: orderState, reply };
        } finally {
            client.release(); // Release the client back to the pool
        }
    }
}

module.exports = OrderProcessingAgent;