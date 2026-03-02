import axios from 'axios';

/**
 * CatalogService - Product Discovery via Shopify Admin API
 *
 * Scopes product discovery EXCLUSIVELY to the user's explicit store
 * (demo-cloths-2.myshopify.com) using the Admin API token.
 * This guarantees the agent only finds items that our local Store SDK
 * can actually process for checkout.
 */

const SHOP_DOMAIN = process.env.ACP_SHOP_DOMAIN || 'demo-cloths-2.myshopify.com';
const ADMIN_TOKEN = process.env.ACP_ADMIN_ACCESS_TOKEN || '';
const API_VERSION = '2026-01';

const ADMIN_ENDPOINT = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

const adminClient = axios.create({
    timeout: 15000,
    headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ADMIN_TOKEN,
    },
});

export interface CatalogProduct {
    id: string;           // Shopify GID
    name: string;
    description: string;
    price: string;
    currency: string;
    available: boolean;
    variant_id: string;   // Pass this as `item.id` in checkout
}

export class CatalogService {
    /**
     * Search for products using the Shopify Admin GraphQL API.
     */
    static async searchProducts(query: string): Promise<CatalogProduct[]> {
        // Build the Admin API product query
        // The Admin API returns inventory context differently than Storefront
        const gql = `
            query SearchProducts($query: String!) {
                products(first: 10, query: $query) {
                    edges {
                        node {
                            id
                            title
                            descriptionHtml
                            variants(first: 5) {
                                edges {
                                    node {
                                        id
                                        inventoryQuantity
                                        price
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `;

        try {
            console.log(`[Catalog] Shopify search query: "${query}"`);
            // Shopify Admin API requires the query to be formatted explicitly if not empty
            const searchQuery = query.trim() !== '' && query !== '*' ? `title:*${query}*` : '';

            const response = await adminClient.post(ADMIN_ENDPOINT, {
                query: gql,
                variables: { query: searchQuery },
            });

            if (response.data.errors) {
                console.error('[Catalog] Shopify Admin API errors:', JSON.stringify(response.data.errors, null, 2));
                return [];
            }

            const productsData = response.data.data.products.edges;
            console.log(`[Catalog] Shopify returned ${productsData.length} products`);

            const mapped = productsData.map((edge: any) => {
                const node = edge.node;
                const firstVariant = node.variants?.edges?.[0]?.node;

                // Strip HTML from description
                const plainDescription = (node.descriptionHtml || '').replace(/<[^>]+>/g, '');

                return {
                    id: node.id,
                    name: node.title,
                    description: plainDescription,
                    price: firstVariant?.price || '0',
                    currency: 'USD', // Admin API returns price as string without currency, assuming USD from store default
                    available: (firstVariant?.inventoryQuantity || 0) > 0 || firstVariant?.inventoryPolicy === 'CONTINUE',
                    variant_id: firstVariant?.id || node.id,
                };
            });

            // If the query was specific but returned nothing, try wildcard to show available catalog
            if (mapped.length === 0 && query !== '*') {
                console.log(`[Catalog] Specific search returned no results, trying wildcard search...`);
                return CatalogService.searchProducts('*');
            }
            return mapped;
        } catch (error: any) {
            console.error('[Catalog] Error searching Admin API:', error.response?.data || error.message);
            return [];
        }
    }
}
