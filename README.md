# ACP Checkout Testing Guide

This guide explains how to test the end-to-end checkout flow using the **Commerce Agent** and **Store SDK**, including handling of Stripe 3D Secure (SCA) verification according to the Agentic Commerce Protocol (ACP).

## Prerequisites

1.  **Stripe Test Mode**: Ensure your `StoreSDK/.env` contains a valid `STRIPE_SECRET_KEY` (starts with `sk_test_`).
2.  **Shopify Store**: Ensure `SHOPIFY_SHOP_DOMAIN` and `SHOPIFY_ADMIN_ACCESS_TOKEN` are configured.

## Running the Servers

1.  **Terminal 1 (Store SDK)**:
    ```bash
    cd StoreSDK
    npm install
    npm run dev
    ```
    The Store SDK should be listening on `http://localhost:3000`.

2.  **Terminal 2 (Commerce Agent)**:
    ```bash
    cd CommerceAgent
    npm install
    npm run dev
    ```
    The Commerce Agent shell will start on `http://localhost:4000`.

## Testing the Flow

1.  **Open the Agent UI**:
    Go to [http://localhost:4000](http://localhost:4000) in your browser.

2.  **Search for Products**:
    Type: *"I want to buy a t-shirt"* (or any product in your store).
    The agent will search the ACP Catalog and show you matching items.

3.  **Create Checkout**:
    Type: *"Yes, buy the first one"* or similar.
    The agent will use `create_checkout_session` to initialize the cart.

4.  **Confirm Details**:
    The agent will tell you the total and ask for confirmation.
    Type: *"Confirm, my email is test@example.com"* (if asked).

5.  **Complete Purchase (3DS Challenge)**:
    Type: *"Go ahead and complete the purchase"*.
    The agent will call `complete_checkout_session`. 
    
    > [!NOTE]
    > Because we are using a test card, Stripe may trigger a 3D Secure challenge. The agent will detect this (ACP `authentication_required` status) and provide a **Verify Payment** link.

6.  **Verify Payment**:
    Click the **Verify Payment** link. 
    On the Stripe test page, click **Complete Authentication**.
    You will see a "Verification Success" page. Close it and return to the chat.

7.  **Finalize**:
    Type: *"I have verified the payment"*.
    The agent will call `confirm_authentication`.
    **Success!** You will receive an order confirmation with a Stripe reference ID.

## Verification in Stripe

Go to your [Stripe Dashboard (Payments)](https://dashboard.stripe.com/test/payments). 
You should see a payment with status **Succeeded**. (Previously, these were showing up as "Incomplete").
