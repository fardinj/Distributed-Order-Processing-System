# Distributed Order Processing System

## Overview

Design and implement a backend system that accepts customer orders and processes their items asynchronously.

An order may contain different item types, and each type must be fulfilled by a separate processor:

- **DIGITAL:** grant access to a virtual product
- **SUBSCRIPTION:** activate or extend a subscription
- **PHYSICAL:** reserve inventory and create a shipment

The main focus is system design, concurrency control, reliable asynchronous processing, SQL transactions, and failure recovery under heavy load.

## Required Stack

- Node.js / TypeScript
- NestJS
- PostgreSQL
- Redis
- RabbitMQ
- Prisma

## Functional Requirements

### 1. Product and Inventory Setup

Provide seed data or simple APIs for products.

Each product must have:

- id, name, type, and price
- Available stock for physical products
- Optional subscription duration or digital-product metadata

### 2. Order Creation

Provide an API to create an order containing a customer ID and one or more items.

On submission, the system must:

- Validate the products and calculate prices on the server
- Store the order and its items in PostgreSQL
- The requests must be idempotent
- Start processing asynchronously through RabbitMQ
- Return the order ID and current status without waiting for fulfillment

### 3. Payment Processing

Simulate a payment step before fulfillment.

- A payment may succeed, fail, or time out
- A successful payment must be recorded exactly once
- Duplicate messages or retries must never create duplicate charges
- A payment failure must move the order to an appropriate final state

You may use deterministic test rules, such as references containing FAIL, to simulate failures.

### 4. Item Fulfillment

After successful payment, route every order item to the correct processor.

- Digital processor: records that access was granted
- Subscription processor: activates or extends the customer's subscription
- Physical processor: reserves stock and shipment logic

Each item must have its own processing status. An order is completed only when all required items are completed.

Actual external payment, subscription, or shipping integrations are not required. Local worker modules or simulated services are sufficient, but their service boundaries must be clear.

### 5. Order Status

Track the lifecycle of both orders and individual items.

Provide APIs to:

- Get an order with its items, payment, shipment, and processing status
- List orders with basic filtering and pagination
- Retry an eligible failed item or order

### 6. Event History

Store important state changes, for example:

- Order created
- Payment started, succeeded, or failed
- Item processing started, succeeded, or failed
- Retry scheduled
- Shipment created
- Order completed or failed

The history should make it possible to understand what happened to an order.

## Concurrency and Transaction Requirements

The system must remain correct when many requests and workers run concurrently.

Your solution must demonstrate:

- Safe stock reservation with no overselling or negative inventory
- Protection against two workers processing the same item simultaneously
- Atomic SQL transactions for related state changes
- Idempotent consumers that tolerate duplicate RabbitMQ delivery
- A clear locking strategy
- Short-lived distributed lock, caching, rate limiting
- PostgreSQL must remain the source of truth. Explain how correctness is preserved

Include the important SQL or pseudocode for at least:

1. Creating an order idempotently
2. Reserving physical inventory concurrently
3. Claiming and completing an item safely
4. Updating the final order status

## Messaging and Reliability Requirements

Assume RabbitMQ provides at-least-once delivery. Messages may be duplicated, delayed, or delivered out of order, and workers may crash after performing work but before acknowledging a message.

## Data Modeling

Design the PostgreSQL data model yourself. The submission should explain:

- The entities, relationships, and ownership boundaries
- How order-level and item-level state is represented
- The constraints and indexes required for correctness and performance
- How idempotency, event history, inventory, payment, and fulfillment records are modeled
- How the model supports concurrency, retries, and recovery

Include migrations and justify the important modeling decisions. Monetary values must use a safe representation rather than floating point.

## Load and Failure Scenarios

The design should handle:

- Many customers ordering the last units of the same product
- The same create-order request submitted multiple times
- The same RabbitMQ message delivered multiple times
- A worker crashing during fulfillment
- PostgreSQL or Redis being temporarily unavailable
- One item failing after other items in the order have succeeded
- Retry or cancellation while another worker is processing the order

State how partial failures are handled, including whether completed actions are retained or compensated through cancellation, refund, or stock release.

## What to Submit

1. Source code with a clear README and local setup instructions
2. API documentation or an importable Postman/Insomnia collection
3. Architecture and sequence diagrams

## Evaluation Criteria

- System design: clear boundaries, data flow, scalability, and trade-offs
- Concurrency correctness: locking, inventory safety, and race-condition handling
- Database design: schema quality, SQL transactions, constraints, and indexes
- Asynchronous processing: RabbitMQ usage, retries, idempotency, and recovery
- Code quality: NestJS structure, TypeScript quality, testing, and documentation
- Operational thinking: logs, metrics, tracing, health checks, and failure visibility

## Notes

- Keep the implementation focused; a UI is not required.
- Simple simulated processors are acceptable.
- Document any assumptions or deliberately omitted features.
- We value clear reasoning and correctness more than the number of features.

Estimated timeline: 5–7 days for an MVP.
