class OrderProcessingAgent {
    static async findProduct(productName, db) {
        if (typeof productName !== 'string' || productName.trim() === '') {
            console.error('[OrderProcessingAgent] Received invalid productName:', productName);
            return null;
        }

        const searchWords = productName.split(' ').filter(word => word.length > 0);
        if (searchWords.length === 0) return null;

        const conditions = searchWords.map(() => 'LOWER(name) LIKE ?').join(' AND ');
        const sqlQuery = `SELECT * FROM products WHERE ${conditions}`;
        const searchParams = searchWords.map(word => `%${word}%`);

        try {
            const [rows] = await db.execute(sqlQuery, searchParams);
            return rows;
        } catch (error) {
            console.error(`[OrderProcessingAgent] Database query failed:`, error);
            return null;
        }
    }
    
    // --- NEW: Function to analyze order history for patterns ---
    static async getOrderHistoryPattern(customerId, db) {
        console.log(`[OrderProcessingAgent] Analyzing order history for customer ${customerId}...`);
        const [rows] = await db.execute(
            `SELECT oi.product_sku, p.name, COUNT(*) as order_frequency
             FROM order_items oi
             JOIN orders o ON oi.order_id = o.id
             JOIN products p ON oi.product_sku = p.sku
             WHERE o.customer_id = ? AND o.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
             GROUP BY oi.product_sku, p.name
             ORDER BY order_frequency DESC
             LIMIT 1;`, 
            [customerId]
        );
        return rows[0]; 
    }

    static async getUsualOrderItems(customerId, db) {
        const [rows] = await db.execute(
            `SELECT uoi.product_sku, uoi.quantity, p.name, p.price 
             FROM usual_order_items uoi
             JOIN products p ON uoi.product_sku = p.sku
             WHERE uoi.customer_id = ?`,
            [customerId]
        );
        return rows;
    }

    static async finalizeOrder(orderState, db) {
        if (!orderState.shippingAddress || orderState.lineItems.length === 0) {
            const reply = "Cannot finalize order. Shipping address and items are required.";
            return { newOrderState: orderState, reply };
        }
        const connection = await db.getConnection();
        await connection.beginTransaction();
        try {
            const [orderResult] = await connection.execute(
                'INSERT INTO orders (customer_id, purchase_order_num, shipping_address, status) VALUES (?, ?, ?, ?)', 
                [orderState.customerId, orderState.purchaseOrderNum, orderState.shippingAddress, 'confirmed']
            );
            const orderId = orderResult.insertId;
            for (const item of orderState.lineItems) {
                const [productRows] = await connection.execute('SELECT stock FROM products WHERE sku = ? FOR UPDATE', [item.sku]);
                if (productRows[0].stock < item.quantity) {
                    throw new Error(`Insufficient stock for ${item.name}`);
                }
                await connection.execute(
                    'INSERT INTO order_items (order_id, product_sku, quantity, unit_price) VALUES (?, ?, ?, ?)', 
                    [orderId, item.sku, item.quantity, item.price]
                );
                await connection.execute(
                    'UPDATE products SET stock = stock - ? WHERE sku = ?', 
                    [item.quantity, item.sku]
                );
            }
            await connection.commit();
            
            
            const reply = `Order #${orderId} has been confirmed and is being processed.`;

            // The order state is reset, making the application ready for a new order.
            const newOrderState = { ...orderState, lineItems: [], purchaseOrderNum: null, shippingAddress: null };
            return { newOrderState, reply };

        } catch (error) {
            await connection.rollback();
            console.error('Order finalization failed:', error);
            const reply = `There was an error processing your order: ${error.message}. Please try again.`;
            return { newOrderState: orderState, reply };
        } finally {
            connection.release();
        }
    }
}

module.exports = OrderProcessingAgent;
