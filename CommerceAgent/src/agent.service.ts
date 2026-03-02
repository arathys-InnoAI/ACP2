import { ChatOpenAI } from '@langchain/openai';
import { AgentExecutor, createToolCallingAgent } from "@langchain/classic/agents";
import { DynamicTool } from '@langchain/core/tools';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import axios from 'axios';

const STORE_SDK_URL = process.env.STORE_SDK_URL || 'http://localhost:3000';

// Store chat histories in memory (for demo)
const chatHistories: Record<string, BaseMessage[]> = {};

// Helper to interact with Store SDK
const storeClient = axios.create({
    baseURL: STORE_SDK_URL,
    timeout: 15000,
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test_agent_token', // Mock auth
        'API-Version': '2026-01-30' // ACP required header
    }
});

export class AgentService {
    static async processMessage(message: string, sessionId: string): Promise<string> {
        // Use LM Studio local server (OpenAI API compatible)
        const llm = new ChatOpenAI({
            modelName: "qwen/qwen2.5-coder-14b", // Updated to 14B model
            temperature: 0,
            openAIApiKey: "lm-studio", // Dummy key required by LangChain
            configuration: {
                baseURL: "http://localhost:1234/v1", // Default LM Studio local server port
            },
        });

        // Tool: Search products using the ACP Catalog API
        const searchProductsTool = new DynamicTool({
            name: "search_products",
            description: "Search the ACP Catalog for products by name or description (e.g. 'blue t-shirt', 'sneakers'). Returns a list of matching products with their variant IDs needed for checkout.",
            func: async (query: string) => {
                try {
                    console.log(`[Agent] Searching products for query: "${query}"`);
                    const { CatalogService } = await import('./catalog.service');
                    const products = await CatalogService.searchProducts(query);
                    console.log(`[Agent] Found ${products.length} products`);
                    if (!products.length) return "No products found for that search. Try a different query.";
                    return JSON.stringify(products, null, 2);
                } catch (error: any) {
                    console.error(`[Agent] Search error:`, error.message);
                    return `Error searching catalog: ${error.message}`;
                }
            }
        });

        const createCheckoutTool = new DynamicTool({
            name: "create_checkout_session",
            description: "Creates an ACP checkout session. Input must be a JSON object with 'items' (list of {id: string, quantity: number}) and optional 'fulfillment_details'. Use the 'variant_id' from catalog search results as the 'id'.",
            func: async (input: string) => {
                try {
                    let parsed = JSON.parse(input);
                    // Handle case where model sends just the items array
                    if (Array.isArray(parsed)) {
                        parsed = { items: parsed };
                    }
                    if (!parsed || typeof parsed !== 'object') {
                        return "Error: Input must be a JSON object or array of items.";
                    }
                    const items = parsed.items || (Array.isArray(parsed) ? parsed : []);
                    if (!items.length) {
                        return "Error: 'items' list is required.";
                    }
                    // Map variant_id to id if the model uses the catalog field name
                    const normalizedItems = items.map((item: any) => ({
                        id: item.id || item.variant_id || item.variantId,
                        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
                        name: item.name || ""
                    }));

                    console.log(`[Agent] Creating checkout session with items:`, normalizedItems);
                    const response = await storeClient.post('/checkout_sessions', {
                        items: normalizedItems,
                        fulfillment_details: parsed.fulfillment_details
                    });
                    console.log(`[Agent] Session created: ${response.data.id}`);
                    return JSON.stringify(response.data);
                } catch (error: any) {
                    return `Error creating checkout session: ${error.response?.data?.error?.message || error.message}`;
                }
            }
        });

        const completeCheckoutTool = new DynamicTool({
            name: "complete_checkout_session",
            description: "Completes an ACP checkout session given a checkout_session_id. Input must be a JSON object with 'checkout_session_id'. If the response status is 'authentication_required', tell the user they must complete payment verification through the provided link before the order can be confirmed.",
            func: async (input: string) => {
                try {
                    let parsed = JSON.parse(input);
                    const csId = typeof parsed === 'string' ? parsed : (parsed.checkout_session_id || parsed.id);
                    if (!csId) return "Error: checkout_session_id is required.";

                    const response = await storeClient.post(`/checkout_sessions/${csId}/complete`, {
                        payment_data: { token: "tok_visa", provider: "stripe" },
                        buyer: parsed.buyer || { email: "agent@example.com" }
                    });

                    const data = response.data;

                    // ACP: authentication_required — surface 3DS link
                    if (data.status === 'authentication_required' && data.next_action?.url) {
                        return JSON.stringify({
                            status: 'authentication_required',
                            checkout_session_id: csId,
                            message: 'Payment requires verification. Please complete the 3D Secure challenge using the link below, then tell me when you are done.',
                            verification_url: data.next_action.url
                        });
                    }

                    return JSON.stringify(data);
                } catch (error: any) {
                    return `Error completing checkout session: ${error.response?.data?.error?.message || error.message}`;
                }
            }
        });

        const confirmAuthenticationTool = new DynamicTool({
            name: "confirm_authentication",
            description: "After the buyer has completed the 3D Secure verification challenge, call this tool with the checkout_session_id to confirm the payment and finalize the order.",
            func: async (input: string) => {
                try {
                    console.log(`[Agent] Confirming authentication for session: ${input}`);
                    let parsed: any;
                    try { parsed = JSON.parse(input); } catch { parsed = input; }
                    const csId = typeof parsed === 'string' ? parsed : (parsed.checkout_session_id || parsed.id);
                    if (!csId) return "Error: checkout_session_id is required.";

                    const response = await storeClient.post(`/checkout_sessions/${csId}/confirm_authentication`);
                    console.log(`[Agent] Auth confirmation result: ${response.data.status}`);
                    return JSON.stringify(response.data);
                } catch (error: any) {
                    console.error(`[Agent] Confirm Auth error:`, error.message);
                    return `Error confirming authentication: ${error.response?.data?.error?.message || error.message}`;
                }
            }
        });

        const getCheckoutTool = new DynamicTool({
            name: "get_checkout_session",
            description: "Retrieves the current state of an ACP checkout session by its ID.",
            func: async (input: string) => {
                try {
                    console.log(`[Agent] Getting checkout session: ${input}`);
                    const response = await storeClient.get(`/checkout_sessions/${input}`);
                    return JSON.stringify(response.data);
                } catch (error: any) {
                    console.error(`[Agent] Get Session error:`, error.message);
                    return `Error retrieving checkout session: ${error.response?.data?.error?.message || error.message}`;
                }
            }
        });

        const tools = [searchProductsTool, createCheckoutTool, completeCheckoutTool, confirmAuthenticationTool, getCheckoutTool];

        const prompt = ChatPromptTemplate.fromMessages([
            ["system", `You are an AI Commerce Agent. Follow these rules:
1. Search products using search_products.
2. ALWAYS use the 'variant_id' from the search results as the 'id' for checkout. NEVER make up IDs.
3. Show the user search results and ask for confirmation of item and quantity.
4. Call create_checkout_session ONLY after user confirmation.
5. Provide the cart total and ask for shipping address/email.
6. Call complete_checkout_session only after details are provided.
7. If status is "authentication_required", show the verification_url and wait for user to say "I have verified". Then call confirm_authentication.

Be concise. Use tools correctly. Never skip user confirmation for spending money.`],
            new MessagesPlaceholder("chat_history"),
            ["human", "{input}"],
            new MessagesPlaceholder("agent_scratchpad"),
        ]);

        const agent = await createToolCallingAgent({
            llm,
            tools,
            prompt,
        });

        const agentExecutor = new AgentExecutor({
            agent,
            tools,
            verbose: true,
        });

        if (!chatHistories[sessionId]) {
            chatHistories[sessionId] = [];
        }

        const result = await agentExecutor.invoke({
            input: message,
            chat_history: chatHistories[sessionId],
        });

        chatHistories[sessionId].push(new HumanMessage(message));
        chatHistories[sessionId].push(new AIMessage(result.output));

        return result.output;
    }
}

