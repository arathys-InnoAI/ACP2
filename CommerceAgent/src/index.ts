import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { AgentService } from './agent.service';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Serve the Agent Chat UI
app.use(express.static(path.resolve(__dirname, '..', 'public')));

app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', message: 'Commerce Agent is running' });
});

app.post('/chat', async (req: Request, res: Response) => {
    try {
        const { message, sessionId } = req.body;
        console.log(`[Server] Received message for session ${sessionId}: "${message}"`);

        if (!message) {
            res.status(400).json({ error: 'Message is required' });
            return;
        }

        const response = await AgentService.processMessage(message, sessionId || 'default');
        console.log(`[Server] Agent responded for session ${sessionId}`);
        res.json({ response });
    } catch (error: any) {
        console.error('[Server] Error processing chat:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3DS redirect landing — Stripe redirects the buyer here after the
// challenge.  The page is a static HTML file in public/.
app.get('/payment-return', (_req, res) => {
    res.sendFile(path.resolve(__dirname, '..', 'public', 'payment-return.html'));
});

app.listen(port, () => {
    console.log(`Commerce Agent server listening on port ${port}`);
});

