import { pool, getOrCreateUser } from "./index.ts";

async function seed() {
    const user = await getOrCreateUser();
    const accountId = "acc_sandbox_checking_123";

    // 1. Insert sample account
    await pool.query(
        `INSERT INTO accounts (id, user_id, name, type, subtype, currency)
         VALUES ($1, $2, 'Plaid Checking', 'depository', 'checking', 'USD')
         ON CONFLICT (id) DO NOTHING`,
        [accountId, user.id],
    );

    // 2. Insert sample transactions (income + realistic spending mistakes)
    const sampleTxns = [
        // Income
        {
            id: "txn_inc_1",
            date: "2026-01-01",
            name: "Payroll Direct Deposit",
            amount: -3500.0,
            cat: "INCOME",
        },
        {
            id: "txn_inc_2",
            date: "2026-02-01",
            name: "Payroll Direct Deposit",
            amount: -3500.0,
            cat: "INCOME",
        },

        // Excessive Food Delivery
        {
            id: "txn_food_1",
            date: "2026-01-05",
            name: "DoorDash - Burger Joint",
            amount: 48.5,
            cat: "FOOD_AND_DRINK",
            merchant: "DoorDash",
        },
        {
            id: "txn_food_2",
            date: "2026-01-08",
            name: "Uber Eats - Sushi Express",
            amount: 62.1,
            cat: "FOOD_AND_DRINK",
            merchant: "Uber Eats",
        },
        {
            id: "txn_food_3",
            date: "2026-01-12",
            name: "DoorDash - Thai Spice",
            amount: 55.4,
            cat: "FOOD_AND_DRINK",
            merchant: "DoorDash",
        },
        {
            id: "txn_food_4",
            date: "2026-01-18",
            name: "DoorDash - Pizza Hut",
            amount: 42.0,
            cat: "FOOD_AND_DRINK",
            merchant: "DoorDash",
        },
        {
            id: "txn_food_5",
            date: "2026-01-25",
            name: "Uber Eats - Mexican Grill",
            amount: 58.9,
            cat: "FOOD_AND_DRINK",
            merchant: "Uber Eats",
        },
        {
            id: "txn_food_6",
            date: "2026-02-03",
            name: "DoorDash - Artisan Burgers",
            amount: 65.0,
            cat: "FOOD_AND_DRINK",
            merchant: "DoorDash",
        },

        // Unused Subscriptions
        {
            id: "txn_sub_1",
            date: "2026-01-02",
            name: "Equinox Gym Membership",
            amount: 280.0,
            cat: "ENTERTAINMENT",
            merchant: "Equinox",
        },
        {
            id: "txn_sub_2",
            date: "2026-02-02",
            name: "Equinox Gym Membership",
            amount: 280.0,
            cat: "ENTERTAINMENT",
            merchant: "Equinox",
        },
        {
            id: "txn_sub_3",
            date: "2026-01-15",
            name: "StreamMax Ultra 4K",
            amount: 24.99,
            cat: "ENTERTAINMENT",
            merchant: "StreamMax",
        },
        {
            id: "txn_sub_4",
            date: "2026-02-15",
            name: "StreamMax Ultra 4K",
            amount: 24.99,
            cat: "ENTERTAINMENT",
            merchant: "StreamMax",
        },

        // Impulse Shopping
        {
            id: "txn_shop_1",
            date: "2026-01-14",
            name: "Amazon - Ergonomic RGB Chair",
            amount: 499.99,
            cat: "GENERAL_MERCHANDISE",
            merchant: "Amazon",
        },
        {
            id: "txn_shop_2",
            date: "2026-01-28",
            name: "BestBuy - Wireless Headphones",
            amount: 349.99,
            cat: "GENERAL_MERCHANDISE",
            merchant: "BestBuy",
        },
        {
            id: "txn_shop_3",
            date: "2026-02-05",
            name: "Amazon - Mechanical Keyboard",
            amount: 189.0,
            cat: "GENERAL_MERCHANDISE",
            merchant: "Amazon",
        },
    ];

    for (const t of sampleTxns) {
        await pool.query(
            `INSERT INTO transactions
               (id, account_id, user_id, date, merchant_name, name, amount, currency, category_primary, pending)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $8, false)
             ON CONFLICT (id) DO NOTHING`,
            [
                t.id,
                accountId,
                user.id,
                t.date,
                t.merchant ?? null,
                t.name,
                t.amount,
                t.cat,
            ],
        );
    }

    console.log(
        `✅ Seeded ${sampleTxns.length} transactions for user ${user.id}`,
    );
    await pool.end();
}

seed().catch(console.error);
