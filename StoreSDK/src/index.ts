// NOTE: dotenv MUST be imported and configured before any internal module that
// reads environment variables. The Shopify API client initializes at module load
// time, so env vars must be available before the router is imported.
import dotenv from 'dotenv';
import path from 'path';

// Resolve .env from the project root regardless of where node is launched from.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import checkoutRouter from './routes/checkout.routes';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/checkout_sessions', checkoutRouter);

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', message: 'Store SDK is running' });
});

app.listen(port, () => {
    console.log(`Store SDK server listening on port ${port}`);
});
