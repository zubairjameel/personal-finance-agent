/**
 * bin/plaid-setup.mjs
 *
 * One-time Plaid Sandbox Setup Script.
 *
 * Automatically creates a fake linked bank account in Plaid sandbox
 * and generates the PLAID_SANDBOX_ACCESS_TOKEN for you.
 *
 * Usage:
 *   npm run plaid:setup
 */

import { config } from "dotenv";
import { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } from "plaid";

config({ path: ".env.local" });

const clientId = process.env.PLAID_CLIENT_ID;
const secret = process.env.PLAID_SANDBOX_SECRET;

if (!clientId || !secret) {
    console.error("\n❌ Missing Plaid credentials in .env.local");
    console.error("   Make sure PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET are set.\n");
    process.exit(1);
}

const plaidConfig = new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: {
        headers: {
            "PLAID-CLIENT-ID": clientId,
            "PLAID-SECRET": secret,
        },
    },
});

const plaidClient = new PlaidApi(plaidConfig);

async function main() {
    console.log("\n🏦 Plaid Sandbox Setup");
    console.log("══════════════════════════════════════════\n");

    // Step 1: Create a sandbox public token (simulates user linking a bank)
    console.log("Step 1: Creating fake bank account (First Platypus Bank)...");
    const sandboxResponse = await plaidClient.sandboxPublicTokenCreate({
        institution_id: "ins_109508", // First Platypus Bank — Plaid's official test bank
        initial_products: [Products.Transactions],
        options: {
            webhook: "",
            override_username: "user_good",
            override_password: "pass_good",
        },
    });

    const publicToken = sandboxResponse.data.public_token;
    console.log("   ✅ Public token created");

    // Step 2: Exchange public token for access token
    console.log("Step 2: Exchanging for permanent access token...");
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
        public_token: publicToken,
    });

    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;

    console.log("   ✅ Access token generated!\n");

    // Step 3: Show the result
    console.log("══════════════════════════════════════════");
    console.log("✅ DONE! Add this to your .env.local:\n");
    console.log(`PLAID_SANDBOX_ACCESS_TOKEN=${accessToken}`);
    console.log("\n══════════════════════════════════════════");
    console.log(`\nItem ID (for reference): ${itemId}`);
    console.log("\nThis token gives access to fake transactions from First Platypus Bank.");
    console.log("Run `npm run db:sync` to pull those transactions into CockroachDB.\n");
}

main().catch((err) => {
    const msg = err?.response?.data ?? err?.message ?? String(err);
    console.error("\n❌ Plaid setup failed:");
    console.error(typeof msg === "object" ? JSON.stringify(msg, null, 2) : msg);
    console.error("\nMake sure your PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET are correct.\n");
    process.exit(1);
});
