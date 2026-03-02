import axios from 'axios';

/**
 * ShopifyAdminService
 *
 * Uses the Shopify Admin GraphQL API for product/variant data retrieval.
 * Requires an Admin API Access Token (shpat_...).
 */

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || '';
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';
const API_VERSION = '2026-01';

const ADMIN_ENDPOINT = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

const adminClient = axios.create({
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': ADMIN_TOKEN,
  },
});

async function adminQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await adminClient.post(ADMIN_ENDPOINT, { query, variables });
  if (response.data.errors) {
    throw new Error(`Shopify Admin API error: ${JSON.stringify(response.data.errors)}`);
  }
  return response.data.data as T;
}

export interface ProductVariant {
  id: string;
  price: string;
  currencyCode: string;
  available: boolean;
}

export interface StorefrontProduct {
  id: string;
  title: string;
  description: string;
  variants: ProductVariant[];
}

// Keep export name consistent so checkout.controller.ts doesn't need to change
export class ShopifyStorefrontService {
  /**
   * Fetch a single product variant by its GID to retrieve the latest price.
   * Used by the checkout controller to get authoritative pricing.
   */
  static async getVariantPrice(variantId: string): Promise<{ price: string; currencyCode: string; productTitle: string } | null> {
    const gql = `
      query GetVariant($id: ID!) {
        productVariant(id: $id) {
          price
          product {
            title
          }
        }
      }
    `;

    try {
      const data = await adminQuery<any>(gql, { id: variantId });
      if (!data.productVariant) return null;
      return {
        price: data.productVariant.price,
        currencyCode: 'USD',
        productTitle: data.productVariant.product?.title || '',
      };
    } catch (error: any) {
      console.error(`Error fetching variant ${variantId}:`, error.message);
      return null;
    }
  }

  /**
   * Search for products by keyword using the Admin API.
   */
  static async searchProducts(query: string): Promise<StorefrontProduct[]> {
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
                    price
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const data = await adminQuery<any>(gql, { query });
      return data.products.edges.map((edge: any) => ({
        id: edge.node.id,
        title: edge.node.title,
        description: (edge.node.descriptionHtml || '').replace(/<[^>]+>/g, ''),
        variants: edge.node.variants.edges.map((ve: any) => ({
          id: ve.node.id,
          price: ve.node.price,
          currencyCode: 'USD',
          available: (ve.node.inventoryQuantity || 0) > 0,
        })),
      }));
    } catch (error: any) {
      console.error('Error searching Shopify Admin:', error.message);
      throw error;
    }
  }
}
