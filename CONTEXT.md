# Order processing language

This glossary fixes terms used by the assignment and planning documents. Selected business policies and their rationale are tracked in docs/ASSUMPTIONS.md and docs/OPEN_QUESTIONS.md.

## Language

**Order**:
A customer's request for one or more product items, with an overall processing outcome.
_Avoid_: Transaction, shipment

**Order item**:
A line in an order identifying a product and quantity, with its own fulfillment outcome.
_Avoid_: Product instance, job

**Payment**:
The order's monetary operation, distinct from its processing attempts and item fulfillment.
_Avoid_: Order, delivery

**Payment attempt**:
An attempt to obtain or reconcile the outcome of a payment. Multiple attempts do not imply multiple charges.
_Avoid_: New charge

**Fulfillment**:
The product-specific action: granting digital access, activating/extending a subscription, or consuming allocated physical inventory and creating a shipment.
_Avoid_: Payment, order creation

**Inventory reservation**:
A recorded allocation of physical stock to an order item. Checkout holds expire after five minutes; a payment-owned reservation stays protected until the payment result is known and then is released or retained as paid allocation.
_Avoid_: Stock lookup

**Shipment**:
A record that the physical processor created shipping work. It does not establish delivery to a customer.
_Avoid_: Delivered order

**Digital entitlement**:
A customer's right to access a digital product.
_Avoid_: Subscription

**Subscription extension**:
A recorded contribution from an order item to a customer's subscription period.
_Avoid_: Payment retry

**Compensation**:
A separate action intended to counter an already completed action, such as refunding a charge or releasing a reservation.
_Avoid_: Database rollback

**Refund**:
A monetary return against a previously successful payment, distinct from revoking successful fulfillment.
_Avoid_: Payment failure, rollback

**Partial refund**:
Confirmed returned money greater than zero but less than the original captured payment amount.
_Avoid_: Pending refund

**Refund log**:
A durable history entry describing an event in a refund's lifecycle.
_Avoid_: Application console log

**Checkout revision**:
A particular version of the basket, quantities and price snapshot presented for payment.
_Avoid_: Paid-order mutation

**Basket changed**:
The checkout outcome indicating that the basket must be updated before gateway entry because its requested stock is no longer available.
_Avoid_: Payment decline

**Stock discrepancy**:
A mismatch between recorded stock and actual available physical units, assumed here to result from an administrator's count or data mistake.
_Avoid_: Ordinary checkout contention

**Payment reconciliation**:
Obtaining the authoritative outcome of the original payment operation after a missing or uncertain response. It does not create a new logical charge.
_Avoid_: Fulfillment retry, second payment

**Manual review**:
A visible unresolved case requiring operator action when automatic recovery is unlikely, human changes are needed, or repeated automatic work would be excessively costly.
_Avoid_: Confirmed permanent failure, automatic refund

**Cancellation intent**:
An accepted instruction to stop eligible fulfillment and resolve any required refund. Its acceptance does not prove money has already been returned.
_Avoid_: Confirmed refund

**Inventory adjustment**:
An administrator's recorded stock correction with a reason and accounting effect, distinct from a customer reservation or its release.
_Avoid_: Unrestricted stock overwrite

**Financial result**:
An authoritative payment or refund outcome from the financial owner, which an order may reflect after its local progress view updates.
_Avoid_: Client-reported payment success

**Paid allocation**:
Physical stock retained for an item after successful payment, until shipment consumes it or an eligible cancellation/correction releases or disputes it.
_Avoid_: Available stock, expired checkout hold

**Accepted order**:
An order durably admitted by the system, whose processing/recovery must be retained even if the client did not receive its response.
_Avoid_: Rejected request, in-memory task

**Rial amount**:
An exact whole-IRR monetary value; it is not a toman value or an approximate floating-point number.
_Avoid_: Unspecified currency unit
